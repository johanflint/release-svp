import { FileNotFoundError } from "@google-automations/git-file-utils";
import init from "@rainbowatcher/toml-edit-js";
import { MigrationOptions } from "./determineReleaseContext";
import { Github } from "./github";
import { logger, Logger, logger as defaultLogger } from "./logger";
import { Manifest } from "./manifest";
import { ComponentConfig, ManifestConfigError, MigrationConfig, parseManifestConfig, ResolvedManifestConfig } from "./manifestConfig";
import { Repository } from "./repository";
import { Version } from "./version";

const CONFIG_PATH = "release-svp-config.json";

// A single implicit component representing the whole repository, used when no manifest config file is present.
// Its empty `path`/`component` mean "repository root" and "unscoped" respectively.
function rootComponent(releaseType: string): ComponentConfig {
    return { path: "", component: "", releaseType };
}

async function fetchConfig(github: Github, branch: string): Promise<string | undefined> {
    try {
        const file = await github.retrieveFileContents(CONFIG_PATH, branch);
        return file.parsedContent;
    } catch (e) {
        if (e instanceof FileNotFoundError) {
            return undefined;
        }
        throw e;
    }
}

export class ManifestRunner {
    private constructor(
        private readonly github: Github,
        private readonly repository: Repository,
        private readonly targetBranch: string,
        private readonly components: readonly ComponentConfig[],
        private readonly migration?: MigrationConfig,
    ) {}

    // Returns `false` if any component failed to prepare, so the caller (e.g. the CLI entrypoint) can reflect
    // that in the process exit status, while still isolating each component's failure from the others below.
    async prepare(): Promise<boolean> {
        const allComponentPaths = this.components.map(component => component.path);
        let allSucceeded = true;
        for (const component of this.components) {
            const label = componentLabel(component);
            logger.info(`--- Preparing release for component '${label}' ---`);
            try {
                await Manifest.forComponent(this.github, this.repository, this.targetBranch, component.component, component.path, allComponentPaths, migrationOptionsFor(component, this.migration))
                    .prepare(component.releaseType);
            } catch (e) {
                logger.error(`Failed to prepare release for component '${label}'`, e);
                allSucceeded = false;
            }
        }
        return allSucceeded;
    }

    // Returns `false` if any component failed to release, so the caller (e.g. the CLI entrypoint) can reflect
    // that in the process exit status, while still isolating each component's failure from the others below.
    async release(): Promise<boolean> {
        const allComponentPaths = this.components.map(component => component.path);
        let allSucceeded = true;
        for (const component of this.components) {
            const label = componentLabel(component);
            logger.info(`--- Creating release(s) for component '${label}' ---`);
            try {
                await Manifest.forComponent(this.github, this.repository, this.targetBranch, component.component, component.path, allComponentPaths, migrationOptionsFor(component, this.migration))
                    .release();
            } catch (e) {
                logger.error(`Failed to create release(s) for component '${label}'`, e);
                allSucceeded = false;
            }
        }
        return allSucceeded;
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

        return new ManifestRunner(github, repository, resolved.targetBranch, resolved.components, resolved.migration);
    }

    private static async resolveComponents(
        github: Github,
        defaultBranch: string,
        cliReleaseType: string | undefined,
        logger: Logger,
    ): Promise<ResolvedManifestConfig | undefined> {
        const configContent = await fetchConfig(github, defaultBranch);

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
            const targetBranch = config.targetBranch ?? defaultBranch;

            // The default branch's config only tells us *which* branch to target; the actual releases are
            // created against `targetBranch`, so that's the config that should govern them — it may declare a
            // different set of components (or not exist at all) compared to the default branch's copy.
            if (targetBranch === defaultBranch) {
                return { ...config, targetBranch };
            }

            const targetConfigContent = await fetchConfig(github, targetBranch);
            if (targetConfigContent === undefined) {
                logger.warn(`'${CONFIG_PATH}' not found on target branch '${targetBranch}', falling back to the copy on default branch '${defaultBranch}'`);
                return { ...config, targetBranch };
            }

            const targetConfig = parseManifestConfig(targetConfigContent);
            if (targetConfig.targetBranch && targetConfig.targetBranch !== targetBranch) {
                logger.warn(`'${CONFIG_PATH}' on target branch '${targetBranch}' declares a different 'targetBranch' ('${targetConfig.targetBranch}'), ignoring it to avoid a redirect loop`);
            }

            return { ...targetConfig, targetBranch };
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

// Translates the (path-agnostic) migration config into the per-component MigrationOptions determineReleaseContext
// needs — see manifestConfig.ts (`MigrationConfig`) and determineReleaseContext.ts (`MigrationOptions`).
function migrationOptionsFor(component: ComponentConfig, migration: MigrationConfig | undefined): MigrationOptions | undefined {
    if (!migration) {
        return undefined;
    }

    if (component.component === migration.legacyRootSuccessor) {
        return { cutoverCommit: migration.cutoverCommit, legacyAnchorTagName: migration.legacyAnchorTag };
    }

    const bootstrapVersionString = migration.bootstrapVersions?.[component.component];
    if (bootstrapVersionString) {
        return { cutoverCommit: migration.cutoverCommit, bootstrapVersion: Version.parse(bootstrapVersionString) };
    }

    // Config validation (see manifestConfig.ts) requires every non-successor component to have a bootstrap
    // version, so this should be unreachable — still, truncate at cutover defensively rather than silently
    // falling back to un-truncated (pre-migration-inclusive) history.
    return { cutoverCommit: migration.cutoverCommit };
}

function parseGitHubUrl(url: string): Repository {
    const match = /^([\w-.]+)\/([\w-.]+)$/.exec(url)
    return {
        owner: match?.[1] ?? "",
        repo: match?.[2] ?? "",
    }
}
