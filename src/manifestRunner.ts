import { FileNotFoundError } from "@google-automations/git-file-utils";
import init from "@rainbowatcher/toml-edit-js";
import { Github } from "./github";
import { logger, Logger, logger as defaultLogger } from "./logger";
import { Manifest } from "./manifest";
import { ComponentConfig, ManifestConfigError, parseManifestConfig, ResolvedManifestConfig } from "./manifestConfig";
import { Repository } from "./repository";

const CONFIG_PATH = "release-svp-config.json";

// A single implicit component representing the whole repository, used when no manifest config file is present.
// Its empty `path`/`component` mean "repository root" and "unscoped" respectively.
function rootComponent(releaseType: string): ComponentConfig {
    return { path: "", component: "", releaseType };
}

export class ManifestRunner {
    private constructor(
        private readonly github: Github,
        private readonly repository: Repository,
        private readonly targetBranch: string,
        private readonly components: readonly ComponentConfig[],
    ) {}

    async prepare(): Promise<void> {
        for (const component of this.components) {
            const label = componentLabel(component);
            logger.info(`--- Preparing release for component '${label}' ---`);
            try {
                await Manifest.forComponent(this.github, this.repository, this.targetBranch).prepare(component.releaseType);
            } catch (e) {
                logger.error(`Failed to prepare release for component '${label}'`, e);
            }
        }
    }

    async release(): Promise<void> {
        for (const component of this.components) {
            const label = componentLabel(component);
            logger.info(`--- Creating release(s) for component '${label}' ---`);
            try {
                await Manifest.forComponent(this.github, this.repository, this.targetBranch).release();
            } catch (e) {
                logger.error(`Failed to create release(s) for component '${label}'`, e);
            }
        }
    }

    // Note: `cliReleaseType` is only used as a fallback for repositories without a `release-svp-config.json`,
    // preserving today's single-project behaviour. Once a config file is present, each component declares its
    // own `releaseType` and the CLI flag is ignored (with a warning).
    static async create(repositoryUrl: string, githubToken: string, cliReleaseType?: string, logger: Logger = defaultLogger): Promise<ManifestRunner | null> {
        const repository = parseGitHubUrl(repositoryUrl);
        if (!repository.owner || !repository.repo) {
            logger.error(`Invalid GitHub repository url '${repositoryUrl}', expected 'repository/owner' format`);
            return null;
        }

        // Initialize wasm for the TOML library
        await init();

        const github = new Github(repository, githubToken, logger);
        const defaultBranch = await github.retrieveDefaultBranch();

        const resolved = await ManifestRunner.resolveComponents(github, defaultBranch, cliReleaseType, logger);
        if (!resolved) {
            return null;
        }

        return new ManifestRunner(github, repository, resolved.targetBranch, resolved.components);
    }

    private static async resolveComponents(
        github: Github,
        defaultBranch: string,
        cliReleaseType: string | undefined,
        logger: Logger,
    ): Promise<ResolvedManifestConfig | undefined> {
        let configContent: string | undefined;
        try {
            const file = await github.retrieveFileContents(CONFIG_PATH, defaultBranch);
            configContent = file.parsedContent;
        } catch (e) {
            if (!(e instanceof FileNotFoundError)) {
                throw e;
            }
        }

        if (configContent === undefined) {
            if (!cliReleaseType) {
                logger.error(`No '${CONFIG_PATH}' found and no '--release-type' provided, nothing to do`);
                return undefined;
            }

            return { targetBranch: defaultBranch, components: [rootComponent(cliReleaseType)] };
        }

        if (cliReleaseType) {
            logger.warn(`Both '${CONFIG_PATH}' and '--release-type' were provided, ignoring '--release-type'`);
        }

        try {
            const config = parseManifestConfig(configContent);
            return { ...config, targetBranch: config.targetBranch ?? defaultBranch };
        } catch (e) {
            if (e instanceof ManifestConfigError) {
                logger.error(e.message);
                return undefined;
            }
            throw e;
        }
    }
}

function componentLabel(component: ComponentConfig): string {
    return component.component || "<root>";
}

function parseGitHubUrl(url: string): Repository {
    const match = /^([\w-.]+)\/([\w-.]+)$/.exec(url)
    return {
        owner: match?.[1] ?? "",
        repo: match?.[2] ?? "",
    }
}
