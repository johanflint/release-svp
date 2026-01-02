import yargs, { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import "source-map-support/register";
import { hideBin } from "yargs/helpers";
import { PullRequest } from "./commit";
import { determineReleases } from "./determineReleases";
import { DuplicateReleaseError, Github } from "./github";
import { logger } from "./logger";
import { Manifest } from "./manifest";
import { Repository } from "./repository";
import { strategyTypes } from "./strategyFactory";

const LABEL_PENDING = "autorelease: pending";
const LABEL_TAGGED = "autorelease: tagged";
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
        const manifest = await Manifest.create(args.repoUrl ?? "", args.token ?? "", logger);
        await manifest?.prepare(args.releaseType as string);
    },
    command: "prepare",
    describe: "Create or update a pull request representing the next release"
};

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

        if (releases.length === 0) {
            logger.info(`Nothing to release 🐼`);
            return;
        }

        for (const release of releases) {
            logger.info(`Creating release ${release.tag} for pull request #${release.pullRequestNumber}...`);
            try {
                const result = await github.createRelease(release);
                logger.info(`Created release ${result.id} at ${result.url}`);

                const comment = `:bowtie: Created release [${release.tag}](${result.url}) :tulip:`;
                const url = await github.commentOnIssue(comment, release.pullRequestNumber);
                logger.info(`Commented on pull request #${release.pullRequestNumber} at ${url}`);

                logger.info(`Updating labels, removing '${LABEL_PENDING}'...`);
                await github.removePullRequestLabels([LABEL_PENDING], release.pullRequestNumber);
                logger.info(`Updating labels, adding '${LABEL_TAGGED}'...`);
                await github.addPullRequestLabels([LABEL_TAGGED], release.pullRequestNumber);
            } catch (e) {
                if (e instanceof DuplicateReleaseError) {
                    logger.warn(`Duplicate release tag for ${e.tagName}`);
                }
            }
        }

        console.info(`✅️ Created ${releases.length} release(s) 🌷️`);
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
