import * as yargs from "yargs";
import { buildChangelog } from "./changelogBuilder";
import { ChangelogUpdater } from "./changelogUpdater";
import { PullRequest } from "./commit";
import { Github } from "./github";
import { determineReleaseContext } from "./determineReleaseContext";
import { PullRequestChangelogNoteBuilder } from "./pullRequestChangelogNoteBuilder";
import { Repository } from "./repository";
import { Update } from "./update";
import { SemanticVersioningStrategy } from "./versioningStrategies/semantic";

const CHANGELOG_PATH = "CHANGELOG.md";

interface GitHubArgs {
    token?: string;
    repoUrl?: string;
}

function gitHubOptions(yargs: yargs.Argv<GitHubArgs>): yargs.Argv {
    return yargs
        .option("token", {
            describe: "GitHub token with repository write permissions",
        })
        .option("repo-url", {
            describe: "GitHub URL to generate a release for",
            demandOption: true,
            type: "string",
        })
}

const prepareCommand: yargs.CommandModule<{}, GitHubArgs> = {
    builder(yargs) {
        return gitHubOptions(yargs);
    },
    async handler(args: yargs.ArgumentsCamelCase<GitHubArgs>) {
        const targetBranch = "main";
        const repository = parseGitHubUrl(args.repoUrl ?? "");
        if (!repository.owner || !repository.repo) {
            console.error(`Invalid GitHub repository url '${args.repoUrl}, expected repository/owner format'`);
            return;
        }

        console.info(`Prepare release for repository '${repository.owner}/${repository.repo}'`);
        const github = new Github(repository, args.token ?? "");
        const releaseContext = await determineReleaseContext(github, targetBranch);

        console.info(`Previous release is 'v${releaseContext.previousRelease}', ${releaseContext.unreleasedCommits.length} unreleased commit(s)`);

        const versioningStrategy = new SemanticVersioningStrategy();
        const releaseVersion = versioningStrategy.releaseType(releaseContext.unreleasedCommits).bump(releaseContext.previousRelease);

        const changelog = buildChangelog(releaseContext.unreleasedCommits, new PullRequestChangelogNoteBuilder(), releaseVersion)
        console.info("Will open one pull request");
        console.info("---");
        console.info(changelog);
        console.info("---");

        const updates: Update[] = [{
            path: CHANGELOG_PATH,
            createIfMissing: true,
            updater: new ChangelogUpdater(changelog),
        }];

        const pullRequest: PullRequest = {
            number: -1,
            title: `Release v${releaseVersion}`,
            body: "Description.",
            permalink: "unused",
            headBranchName: `release-svp--branches-${targetBranch}`,
            baseBranchName: targetBranch,
            labels: ["autorelease: pending"],
        }

        const existingPullRequest = await findExistingPullRequest(pullRequest, github);
        const commitMessage = `Release v${releaseVersion}`;
        if (existingPullRequest?.body === pullRequest.body && existingPullRequest.title === pullRequest.title) {
            console.info(`Done, pull request https://github.com/${repository.owner}/${repository.repo}/pull/${existingPullRequest.number} remained the same`);
            return;
        }

        if (existingPullRequest) {
            const updatedPullRequest = await github.updatePullRequest(pullRequest, commitMessage, updates);
            console.info(`Updated pull request https://github.com/${repository.owner}/${repository.repo}/pull/${updatedPullRequest.number}`);
        } else {
            const createdPullRequest = await github.createPullRequest(pullRequest, commitMessage, updates);
            console.info(`Created pull request https://github.com/${repository.owner}/${repository.repo}/pull/${createdPullRequest.number}`);
        }
    },
    command: "prepare",
    describe: "Create or update a pull request representing the next release"
};

async function findExistingPullRequest(pullRequest: PullRequest, github: Github): Promise<PullRequest | undefined> {
    const openPullRequestsGenerator = github.pullRequestIterator(pullRequest.baseBranchName, "OPEN");
    for await (const pullRequest of openPullRequestsGenerator) {
        if (pullRequest.headBranchName === pullRequest.headBranchName && pullRequest.labels.includes("autorelease: pending")) {
            return pullRequest;
        }
    }
    return undefined;
}

function parseGitHubUrl(url: string): Repository {
    const match = /^([\w-.]+)\/([\w-.]+)$/.exec(url)
    return {
        owner: match?.[1] ?? "",
        repo: match?.[2]?? "",
    }
}

const parser = yargs.command(prepareCommand)
    .demandCommand(1)
    .strict(true)
    .scriptName("release-svp");

(async () => {
    await parser.parseAsync();
})();
