import init from "@rainbowatcher/toml-edit-js";
import yargs, { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import "source-map-support/register";
import { hideBin } from "yargs/helpers";
import { buildChangelog } from "./changelogBuilder";
import { PullRequest } from "./commit";
import { determineReleaseContext } from "./determineReleaseContext";
import { determineReleases } from "./determineReleases";
import { Github } from "./github";
import { logger } from "./logger";
import { createPullRequestBody } from "./pullRequestBody";
import { PullRequestChangelogNoteBuilder } from "./pullRequestChangelogNoteBuilder";
import { Repository } from "./repository";
import { UpdateOptions } from "./strategy";
import { buildStrategy, strategyTypes } from "./strategyFactory";
import { SemanticVersioningStrategy } from "./versioningStrategies/semantic";

const LABEL_PENDING = "autorelease: pending";
const RELEASE_BRANCH_PREFIX = "release-svp--branches-";

interface GitHubArgs {
    token?: string;
    repoUrl?: string;
}

function gitHubOptions(yargs: Argv<GitHubArgs>): yargs.Argv {
    return yargs
        .option("token", {
            describe: "GitHub token with repository write permissions",
        })
        .option("repo-url", {
            describe: "GitHub URL to generate a release for",
            demandOption: true,
            type: "string",
        })
        .option("release-type", {
            describe: "Type of repository a release is being created for",
            choices: strategyTypes(),
        });
}

const prepareCommand: CommandModule<{}, GitHubArgs> = {
    builder(yargs) {
        return gitHubOptions(yargs);
    },
    async handler(args: ArgumentsCamelCase<GitHubArgs>) {
        const repository = parseGitHubUrl(args.repoUrl ?? "");
        if (!repository.owner || !repository.repo) {
            logger.error(`Invalid GitHub repository url '${args.repoUrl}', expected 'repository/owner' format`);
            return;
        }

        // Initialize wasm for the TOML library
        await init();

        logger.info(`Prepare release for repository '${repository.owner}/${repository.repo}'`);
        const github = new Github(repository, args.token ?? "", logger);
        const targetBranch = await github.retrieveDefaultBranch();
        const releaseContext = await determineReleaseContext(github, targetBranch);

        logger.info(`Previous release is 'v${releaseContext.previousRelease}', ${releaseContext.unreleasedCommits.length} unreleased commit(s)`);

        const versioningStrategy = new SemanticVersioningStrategy();
        const releaseVersion = versioningStrategy.releaseType(releaseContext.unreleasedCommits).bump(releaseContext.previousRelease);
        logger.info(`Next release is v${releaseVersion}`);

        const changelog = buildChangelog(releaseContext.unreleasedCommits, new PullRequestChangelogNoteBuilder(), releaseVersion)
        logger.debug(`Will open one pull request`);
        logger.info("---");
        logger.info(changelog);
        logger.info("---");

        const strategy = buildStrategy(args.releaseType as string, { github });
        const updateOptions: UpdateOptions = {
            changelogEntry: changelog,
            releaseVersion,
            targetBranch,
        };
        const updates = await strategy.determineUpdates(updateOptions);

        const pullRequest: PullRequest = {
            number: -1,
            title: `Release v${releaseVersion}`,
            body: createPullRequestBody(changelog),
            permalink: "unused",
            headBranchName: `${RELEASE_BRANCH_PREFIX}${targetBranch}`,
            baseBranchName: targetBranch,
            labels: [LABEL_PENDING],
        }

        const existingPullRequest = await findExistingPullRequest(pullRequest, github);
        const commitMessage = `Release v${releaseVersion}`;
        if (existingPullRequest?.body === pullRequest.body && existingPullRequest.title === pullRequest.title) {
            logger.info(`Done, pull request https://github.com/${repository.owner}/${repository.repo}/pull/${existingPullRequest.number} remained the same`);
            return;
        }

        if (existingPullRequest) {
            const updatedPullRequest = await github.updatePullRequest(pullRequest, commitMessage, updates);
            logger.info(`Updated pull request https://github.com/${repository.owner}/${repository.repo}/pull/${updatedPullRequest.number}`);
        } else {
            const createdPullRequest = await github.createPullRequest(pullRequest, commitMessage, updates);
            logger.info(`Created pull request https://github.com/${repository.owner}/${repository.repo}/pull/${createdPullRequest.number}`);
        }
    },
    command: "prepare",
    describe: "Create or update a pull request representing the next release"
};

async function findExistingPullRequest(pullRequest: PullRequest, github: Github): Promise<PullRequest | undefined> {
    const openPullRequestsGenerator = github.pullRequestIterator(pullRequest.baseBranchName, "OPEN");
    for await (const pullRequest of openPullRequestsGenerator) {
        if (pullRequest.headBranchName === pullRequest.headBranchName && pullRequest.labels.includes(LABEL_PENDING)) {
            return pullRequest;
        }
    }
    return undefined;
}

const releaseCommand: CommandModule<{}, GitHubArgs> = {
    builder(yargs) {
        return gitHubOptions(yargs);
    },
    async handler(args: ArgumentsCamelCase<GitHubArgs>) {
        const repository = parseGitHubUrl(args.repoUrl ?? "");
        if (!repository.owner || !repository.repo) {
            logger.error(`Invalid GitHub repository url '${args.repoUrl}', expected 'repository/owner' format`);
            return;
        }

        const github = new Github(repository, args.token ?? "", logger);
        const targetBranch = await github.retrieveDefaultBranch();

        const releases = await determineReleases(github, targetBranch, { releaseBranchPrefix: RELEASE_BRANCH_PREFIX, labelPending: LABEL_PENDING });

        for (const release of releases) {
            logger.info(`Creating release ${release.tag} for pull request #${release.pullRequestNumber}...`);
        }
    },
    command: "release",
    describe: "Create a GitHub release from a release pull request"
}

function parseGitHubUrl(url: string): Repository {
    const match = /^([\w-.]+)\/([\w-.]+)$/.exec(url)
    return {
        owner: match?.[1] ?? "",
        repo: match?.[2]?? "",
    }
}

const parser = yargs(hideBin(process.argv))
    .command(prepareCommand)
    .command(releaseCommand)
    .demandCommand(1)
    .strict(true)
    .scriptName("release-svp");

(async () => {
    await parser.parseAsync();
})();
