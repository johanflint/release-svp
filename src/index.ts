import * as yargs from "yargs";
import { buildChangelog } from "./changelogBuilder";
import { Github } from "./github";
import { determineReleaseContext } from "./determineReleaseContext";
import { PullRequestChangelogNoteBuilder } from "./pullRequestChangelogNoteBuilder";
import { Repository } from "./repository";
import { SemanticVersioningStrategy } from "./versioningStrategies/semantic";

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
        const repository = parseGitHubUrl(args.repoUrl ?? "");
        if (!repository.owner || !repository.repo) {
            console.error(`Invalid GitHub repository url '${args.repoUrl}, expected repository/owner format'`);
            return;
        }

        console.info(`Prepare release for repository '${repository.owner}/${repository.repo}'`);
        const github = new Github(repository, args.token ?? "");
        const releaseContext = await determineReleaseContext(github, "main");

        console.info(`Previous release is 'v${releaseContext.previousRelease}', ${releaseContext.unreleasedCommits.length} unreleased commit(s)`);

        const versioningStrategy = new SemanticVersioningStrategy();
        const releaseVersion = versioningStrategy.releaseType(releaseContext.unreleasedCommits).bump(releaseContext.previousRelease);

        const changelog = buildChangelog(releaseContext.unreleasedCommits, new PullRequestChangelogNoteBuilder(), releaseVersion)
        console.info("Will open one pull request");
        console.info("---");
        console.info(changelog);
    },
    command: "prepare",
    describe: "Create or update a pull request representing the next release"
};

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
