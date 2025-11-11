import * as yargs from "yargs";
import { Github } from "./github";
import { Repository } from "./repository";

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

        const github = new Github(repository, args.token ?? "");

        const commitGenerator = github.mergeCommitIterator("main");
        for await (const commit of commitGenerator) {
            console.info(`Commit '${commit.sha}, associated pull request: ${commit.pullRequest?.number}`);
        }

        console.info(`Prepare release for repository '${repository.owner}/${repository.repo}'`);
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
