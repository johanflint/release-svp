import yargs, { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import "source-map-support/register";
import { hideBin } from "yargs/helpers";
import { logger } from "./logger";
import { ManifestRunner } from "./manifestRunner";
import { strategyTypes } from "./strategyFactory";

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
            describe: "Type of repository a release is being created for; only used as a fallback when the repository has no 'release-svp-config.json'",
            choices: strategyTypes(),
        });
}

const prepareCommand: CommandModule<{}, GitHubArgs> = {
    builder(yargs) {
        return gitHubOptions(yargs);
    },
    async handler(args: ArgumentsCamelCase<GitHubArgs>) {
        const runner = await ManifestRunner.create(args.repoUrl ?? "", args.token ?? "", args.releaseType as string | undefined, logger);
        await runner?.prepare();
    },
    command: "prepare",
    describe: "Create or update a pull request representing the next release"
};

const releaseCommand: CommandModule<{}, GitHubArgs> = {
    builder(yargs) {
        return gitHubOptions(yargs);
    },
    async handler(args: ArgumentsCamelCase<GitHubArgs>) {
        const runner = await ManifestRunner.create(args.repoUrl ?? "", args.token ?? "", args.releaseType as string | undefined, logger);
        await runner?.release();
    },
    command: "release",
    describe: "Create a GitHub release from a release pull request"
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
