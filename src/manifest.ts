import init from "@rainbowatcher/toml-edit-js";
import { Github } from "./github";
import { Logger, logger as defaultLogger } from "./logger";
import { Repository } from "./repository";

export class Manifest {
    private constructor(private readonly github: Github, private readonly targetBranch: string) {}

    static async create(repositoryUrl: string, githubToken: string, logger: Logger = defaultLogger): Promise<Manifest | null> {
        const repository = parseGitHubUrl(repositoryUrl);
        if (!repository.owner || !repository.repo) {
            logger.error(`Invalid GitHub repository url '${repositoryUrl}', expected 'repository/owner' format`);
            return null;
        }

        // Initialize wasm for the TOML library
        await init();

        const github = new Github(repository, githubToken, logger);
        const targetBranch = await github.retrieveDefaultBranch();
        return new Manifest(github, targetBranch);
    }
}

function parseGitHubUrl(url: string): Repository {
    const match = /^([\w-.]+)\/([\w-.]+)$/.exec(url)
    return {
        owner: match?.[1] ?? "",
        repo: match?.[2]?? "",
    }
}
