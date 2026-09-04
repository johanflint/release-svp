import { FileNotFoundError } from "@google-automations/git-file-utils";
import init from "@rainbowatcher/toml-edit-js";
import { PullRequest } from "./commit";
import { buildCombinedSections, findConflictingOpenPullRequest, pullRequestTitle } from "./combinedPullRequest";
import { pendingLabel } from "./componentNaming";
import { MigrationOptions } from "./determineReleaseContext";
import { Github } from "./github";
import { logger, Logger, logger as defaultLogger } from "./logger";
import { ComponentCandidate, Manifest } from "./manifest";
import { ComponentConfig, ManifestConfigError, MigrationConfig, parseManifestConfig, ResolvedManifestConfig } from "./manifestConfig";
import { createPullRequestBody } from "./pullRequestBody";
import { Repository } from "./repository";
import { computeReleaseUnits, ReleaseUnit } from "./releaseUnit";
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
        private readonly separatePullRequests?: boolean,
    ) {}

    // Returns `false` if any component failed to prepare, so the caller (e.g. the CLI entrypoint) can reflect
    // that in the process exit status, while still isolating each component's failure from the others below.
    //
    // Runs in phases so that every component's candidate (version, changelog, file updates) is known before any
    // of them touch GitHub's pull request state:
    //  1. Compute every component's candidate.
    //  2. `detectDuplicateUpdatePaths` — see there for why two components whose `updates` target the same file
    //     path must abort the whole run rather than risk one silently overwriting the other.
    //  3. Partition components into release units (see releaseUnit.ts) and detect a component simultaneously
    //     claimed by two open pull requests (see `findConflictingOpenPullRequest`) — also aborts the whole run,
    //     since automatically picking one pull request over the other could discard real, unmerged release notes.
    //  4. Open/update each unit's pull request — a singleton unit (today's one-pull-request-per-component
    //     behaviour, unchanged) via `Manifest.openOrUpdatePullRequest`; a combined unit via
    //     `openOrUpdateCombinedPullRequest` below.
    async prepare(): Promise<boolean> {
        const allComponentPaths = this.components.map(component => component.path);
        let allSucceeded = true;

        const manifestsByComponent = new Map<string, Manifest>();
        const candidatesByComponent = new Map<string, ComponentCandidate>();
        const candidateEntries: { component: ComponentConfig; candidate: ComponentCandidate }[] = [];
        for (const component of this.components) {
            const label = componentLabel(component);
            logger.info(`--- Preparing release for component '${label}' ---`);
            try {
                const manifest = Manifest.forComponent(this.github, this.repository, this.targetBranch, component.component, component.path, allComponentPaths, migrationOptionsFor(component, this.migration));
                manifestsByComponent.set(component.component, manifest);
                const candidate = await manifest.computeCandidate(component.releaseType);
                if (candidate) {
                    candidatesByComponent.set(component.component, candidate);
                    candidateEntries.push({ component, candidate });
                }
            } catch (e) {
                logger.error(`Failed to prepare release for component '${label}'`, e);
                allSucceeded = false;
            }
        }

        const collisions = detectDuplicateUpdatePaths(candidateEntries);
        if (collisions.length > 0) {
            for (const collision of collisions) {
                logger.error(`Update path collision: '${collision.path}' would be written by multiple components [${collision.componentNames.join(", ")}] — refusing to prepare any release this run, since combining them would let one component's changes silently overwrite another's`);
            }
            return false;
        }

        const units = computeReleaseUnits(this.components, this.targetBranch, this.separatePullRequests);

        const openPullRequests: PullRequest[] = [];
        for await (const pullRequest of this.github.pullRequestIterator(this.targetBranch, "OPEN")) {
            openPullRequests.push(pullRequest);
        }

        if (this.hasConflictingOpenPullRequest(units, openPullRequests)) {
            return false;
        }

        for (const unit of units) {
            try {
                if (unit.members.length === 1) {
                    const component = unit.members[0];
                    const candidate = candidatesByComponent.get(component.component);
                    if (!candidate) {
                        continue;
                    }
                    const title = pullRequestTitle({ unit, totalComponentCount: this.components.length, repositoryName: this.repository.repo, releaseVersion: candidate.releaseVersion });
                    await manifestsByComponent.get(component.component)!.openOrUpdatePullRequest(candidate, title);
                } else {
                    await this.openOrUpdateCombinedPullRequest(unit, candidatesByComponent, openPullRequests);
                }
            } catch (e) {
                // Singleton units (the common case) are identified by their one member's own name here, matching
                // the wording used everywhere else in this file; only a genuine multi-member unit is identified
                // by its groupId, since it has no single component name of its own.
                const unitLabel = unit.groupId ?? componentLabel(unit.members[0]);
                logger.error(`Failed to prepare release for release unit '${unitLabel}'`, e);
                allSucceeded = false;
            }
        }

        return allSucceeded;
    }

    // Phase 3 of `prepare()`: detects a component simultaneously claimed by two open pull requests — e.g. a
    // pre-upgrade, per-component pull request left open when a component joins a release group for the first
    // time, or a pull request left over from before a `releaseGroup` config change moved the component
    // elsewhere. Logs one error per conflict found. Like `detectDuplicateUpdatePaths`, any conflict aborts the
    // *entire* run rather than partially proceeding, since automatically picking one pull request over the other
    // could discard real, unmerged release notes.
    private hasConflictingOpenPullRequest(units: readonly ReleaseUnit[], openPullRequests: readonly PullRequest[]): boolean {
        let hasConflict = false;
        for (const unit of units) {
            for (const component of unit.members) {
                const conflict = findConflictingOpenPullRequest(openPullRequests, component.component, unit.branchName, this.targetBranch);
                if (conflict) {
                    logger.error(`Component '${componentLabel(component)}' is already tracked by pull request #${conflict.number} (branch '${conflict.headBranchName}'), which is no longer this component's release branch ('${unit.branchName}') — merge or close pull request #${conflict.number} manually before its next run`);
                    hasConflict = true;
                }
            }
        }
        return hasConflict;
    }

    // Opens or updates the one shared pull request for a multi-member release unit — see `buildCombinedSections`
    // for how members without a fresh candidate this run are either carried forward unchanged or rejected.
    private async openOrUpdateCombinedPullRequest(
        unit: ReleaseUnit,
        candidatesByComponent: ReadonlyMap<string, ComponentCandidate>,
        openPullRequests: readonly PullRequest[],
    ): Promise<void> {
        // Matched by branch name alone, unlike Manifest's singleton lookup (which also requires the pending
        // label) — deliberately so: this is exactly what lets `buildCombinedSections` detect an "orphaned"
        // component below (one whose label no longer belongs to any current member, e.g. after a `releaseGroup`
        // config change) instead of mistaking it for "no existing pull request" and silently opening a duplicate.
        // Safe in practice because `unit.branchName` is always one of our own reserved, auto-generated branch
        // names (see componentNaming.ts), never one a user would create by hand.
        const existingPullRequest = openPullRequests.find(pullRequest => pullRequest.headBranchName === unit.branchName);
        const result = buildCombinedSections(unit, candidatesByComponent, existingPullRequest);
        if ("orphaned" in result) {
            throw new Error(`Pull request on branch '${unit.branchName}' already has release notes for component(s) [${result.orphaned.join(", ")}], which ${result.orphaned.length === 1 ? "is" : "are"} no longer a member of this release unit — update the configuration to keep it in this group, or merge/close the existing pull request manually`);
        }

        if (result.sections.length === 0) {
            return;
        }

        const labels = result.sections.map(section => pendingLabel(section.componentName));
        const title = pullRequestTitle({ unit, totalComponentCount: this.components.length, repositoryName: this.repository.repo });
        const body = createPullRequestBody(result.sections);

        const pullRequest: PullRequest = {
            number: -1,
            title,
            body,
            permalink: "unused",
            headBranchName: unit.branchName,
            baseBranchName: this.targetBranch,
            labels,
        };

        if (existingPullRequest?.body === pullRequest.body && existingPullRequest.title === pullRequest.title) {
            logger.info(`Done, pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${existingPullRequest.number} remained the same`);
            return;
        }

        if (existingPullRequest) {
            const updatedPullRequest = await this.github.updatePullRequest(pullRequest, title, [...result.updates]);
            logger.info(`Updated pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${updatedPullRequest.number}`);
        } else {
            const createdPullRequest = await this.github.createPullRequest(pullRequest, title, [...result.updates]);
            logger.info(`Created pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${createdPullRequest.number}`);
        }
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

        return new ManifestRunner(github, repository, resolved.targetBranch, resolved.components, resolved.migration, resolved.separatePullRequests);
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

// Detects file paths that would be written by more than one component's candidate. Github.buildChangeSet keys
// updates by path in a single Map, so if two components' `Update[]`s both target the same path — e.g. a shared
// root-level file two "root-ish" components both think they own — one would silently clobber the other were
// their updates ever combined (e.g. into one pull request). Returns one entry per colliding path, listing every
// component that targets it, so the caller can report all of them at once rather than failing on the first hit.
function detectDuplicateUpdatePaths(
    candidates: readonly { component: ComponentConfig; candidate: ComponentCandidate }[],
): { path: string; componentNames: string[] }[] {
    const componentNamesByPath = new Map<string, string[]>();
    for (const { component, candidate } of candidates) {
        for (const update of candidate.updates) {
            const componentNames = componentNamesByPath.get(update.path) ?? [];
            componentNames.push(componentLabel(component));
            componentNamesByPath.set(update.path, componentNames);
        }
    }

    return Array.from(componentNamesByPath.entries())
        .filter(([, componentNames]) => componentNames.length > 1)
        .map(([path, componentNames]) => ({ path, componentNames }));
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
