import { buildChangelog } from "./changelogBuilder";
import { PullRequest } from "./commit";
import { pendingLabel, releaseBranchName, taggedLabel, tagPrefix } from "./componentNaming";
import { determineReleaseContext, MigrationOptions } from "./determineReleaseContext";
import { determineReleases } from "./determineReleases";
import { DuplicateReleaseError, Github } from "./github";
import { logger } from "./logger";
import { createPullRequestBody } from "./pullRequestBody";
import { PullRequestChangelogNoteBuilder } from "./pullRequestChangelogNoteBuilder";
import { Repository } from "./repository";
import { UpdateOptions } from "./strategy";
import { buildStrategy } from "./strategyFactory";
import { Update } from "./update";
import { SemanticVersioningStrategy } from "./versioningStrategies/semantic";
import { Version } from "./version";

// The pure result of "would this component release, and what would it contain" — computed without any GitHub
// side effects (no pull request is created/updated/read). Kept separate from opening/updating the pull request
// itself so callers preparing multiple components (see ManifestRunner) can inspect every component's candidate
// up front — e.g. to detect two components whose `updates` collide on the same file path — before any of them
// touch GitHub.
export interface ComponentCandidate {
    readonly componentName: string;
    readonly releaseVersion: Version;
    readonly changelog: string;
    readonly updates: readonly Update[];
}

export class Manifest {
    // `componentName` is "" for the root component (single-project, backward-compatible naming — see
    // componentNaming.ts). `componentPath`/`allComponentPaths` scope which commits are considered "unreleased"
    // for this component (see componentPathFilter.ts); defaulting to "" / [""] preserves single-project
    // behaviour (every commit is attributed to the root component). `migration` is only present while a
    // repository is migrating from single-project to multi-component mode — see manifestConfig.ts and README.md.
    private constructor(
        private readonly github: Github,
        private readonly repository: Repository,
        private readonly targetBranch: string,
        private readonly componentName: string = "",
        private readonly componentPath: string = "",
        private readonly allComponentPaths: readonly string[] = [""],
        private readonly migration?: MigrationOptions,
    ) {}

    // Computes what this component's next release would look like (version, changelog, file updates) without
    // touching GitHub's pull request state at all. Returns `undefined` when there's nothing to release.
    async computeCandidate(releaseType: string): Promise<ComponentCandidate | undefined> {
        logger.info(`Prepare release for repository '${this.repository.owner}/${this.repository.repo}'`);
        const releaseContext = await determineReleaseContext(
            this.github,
            this.targetBranch,
            tagPrefix(this.componentName),
            this.componentPath,
            this.allComponentPaths,
            this.migration,
        );

        if (releaseContext.unreleasedCommits.length === 0) {
            logger.info(`No unreleased commits, nothing to do 🕸️`);
            return undefined;
        }

        logger.info(`Previous release is 'v${releaseContext.previousRelease}', ${releaseContext.unreleasedCommits.length} unreleased commit(s)`);

        const versioningStrategy = new SemanticVersioningStrategy();
        const releaseVersion = versioningStrategy.releaseType(releaseContext.unreleasedCommits).bump(releaseContext.previousRelease);
        logger.info(`Next release is v${releaseVersion}`);

        const changelog = buildChangelog(releaseContext.unreleasedCommits, new PullRequestChangelogNoteBuilder(), releaseVersion)
        logger.debug(`Will open one pull request`);
        logger.info("---");
        logger.info(changelog);
        logger.info("---");

        const strategy = buildStrategy(releaseType, { github: this.github, componentPath: this.componentPath });
        const updateOptions: UpdateOptions = {
            changelogEntry: changelog,
            releaseVersion,
            targetBranch: this.targetBranch,
        };
        const updates = await strategy.determineUpdates(updateOptions);

        return { componentName: this.componentName, releaseVersion, changelog, updates };
    }

    // Opens a new pull request for this candidate, or updates the existing one if it's already open. The only
    // GitHub-mutating half of what used to be `prepare()` — see `computeCandidate` for the pure computation.
    // `title` is computed by the caller (see manifestRunner.ts, `pullRequestTitle`) since it depends on
    // repo-wide context (how many other components are configured) this per-component class has no visibility
    // into — also reused verbatim as the commit message, matching the combined-pull-request code path.
    async openOrUpdatePullRequest(candidate: ComponentCandidate, title: string): Promise<void> {
        const pullRequest: PullRequest = {
            number: -1,
            title,
            body: createPullRequestBody([{ componentName: this.componentName, notes: candidate.changelog }]),
            permalink: "unused",
            headBranchName: releaseBranchName(this.targetBranch, this.componentName),
            baseBranchName: this.targetBranch,
            labels: [pendingLabel(this.componentName)],
        }

        const existingPullRequest = await this.findExistingPullRequest(pullRequest, this.github);
        if (existingPullRequest?.body === pullRequest.body && existingPullRequest.title === pullRequest.title) {
            logger.info(`Done, pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${existingPullRequest.number} remained the same`);
            return;
        }

        if (existingPullRequest) {
            const updatedPullRequest = await this.github.updatePullRequest(pullRequest, title, [...candidate.updates]);
            logger.info(`Updated pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${updatedPullRequest.number}`);
        } else {
            const createdPullRequest = await this.github.createPullRequest(pullRequest, title, [...candidate.updates]);
            logger.info(`Created pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${createdPullRequest.number}`);
        }
    }

    private async findExistingPullRequest(existingPullRequest: PullRequest, github: Github): Promise<PullRequest | undefined> {
        const openPullRequestsGenerator = github.pullRequestIterator(existingPullRequest.baseBranchName, "OPEN");
        for await (const pullRequest of openPullRequestsGenerator) {
            if (existingPullRequest.headBranchName === pullRequest.headBranchName && pullRequest.labels.includes(pendingLabel(this.componentName))) {
                return pullRequest;
            }
        }
        return undefined;
    }

    async release() {
        const releases = await determineReleases(this.github, this.targetBranch, {
            releaseBranchName: releaseBranchName(this.targetBranch, this.componentName),
            labelPending: pendingLabel(this.componentName),
            tagPrefix: tagPrefix(this.componentName),
            componentName: this.componentName,
        });

        if (releases.length === 0) {
            logger.info(`Nothing to release 🐼`);
            return;
        }

        for (const release of releases) {
            logger.info(`Creating release ${release.tag} for pull request #${release.pullRequestNumber}...`);
            try {
                const result = await this.github.createRelease(release);
                logger.info(`Created release ${result.id} at ${result.url}`);

                const comment = `:bowtie: Created release [${release.tag}](${result.url}) :tulip:`;
                const url = await this.github.commentOnIssue(comment, release.pullRequestNumber);
                logger.info(`Commented on pull request #${release.pullRequestNumber} at ${url}`);

                logger.info(`Updating labels, removing '${pendingLabel(this.componentName)}'...`);
                await this.github.removePullRequestLabels([pendingLabel(this.componentName)], release.pullRequestNumber);
                logger.info(`Updating labels, adding '${taggedLabel(this.componentName)}'...`);
                await this.github.addPullRequestLabels([taggedLabel(this.componentName)], release.pullRequestNumber);
            } catch (e) {
                if (e instanceof DuplicateReleaseError) {
                    logger.warn(`Duplicate release tag for ${e.tagName}`);
                } else {
                    throw e;
                }
            }
        }

        console.info(`✅️ Created ${releases.length} release(s) 🌷️`);
    }

    // Builds a Manifest for a single component, reusing an already-configured Github client, repository and
    // target branch. Used by ManifestRunner so that resolving the repository/branch/wasm init happens once per
    // run, regardless of how many components it processes. `componentName`/`componentPath` default to "" and
    // `allComponentPaths` to [""] (root component, single-project behaviour). `migration` is only passed while
    // a repository is migrating from single-project to multi-component mode.
    static forComponent(
        github: Github,
        repository: Repository,
        targetBranch: string,
        componentName: string = "",
        componentPath: string = "",
        allComponentPaths: readonly string[] = [""],
        migration?: MigrationOptions,
    ): Manifest {
        return new Manifest(github, repository, targetBranch, componentName, componentPath, allComponentPaths, migration);
    }
}
