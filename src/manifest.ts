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
import { incrementPrereleaseIdentifier, Version } from "./version";

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
    // `prereleaseType` is only present when this component is configured for pre-releases (see
    // manifestConfig.ts, `ComponentConfig.prereleaseType`, and README.md "Pre-releases"); removing it from
    // config graduates the component back to stable on its next release.
    private constructor(
        private readonly github: Github,
        private readonly repository: Repository,
        private readonly targetBranch: string,
        private readonly componentName: string = "",
        private readonly componentPath: string = "",
        private readonly allComponentPaths: readonly string[] = [""],
        private readonly migration?: MigrationOptions,
        private readonly prereleaseType?: string,
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
        // Always compute the numeric bump from the last *stable* release, not merely the last tag of any kind:
        // when this component is mid pre-release train, `previousRelease` may itself already reflect a bump
        // (e.g. a breaking change) that no longer shows up in `unreleasedCommits` (they only cover commits made
        // *after* that tag) — taking whichever of "what the new commits alone call for" and "what
        // `previousRelease` already committed to" is numerically higher recovers that already-committed-to
        // bump so it's never silently lost, and a version can never move backwards.
        const newTarget = versioningStrategy.releaseType(releaseContext.unreleasedCommits).bump(releaseContext.previousStableRelease);
        const bumpTarget = higherNumericTarget(newTarget, releaseContext.previousRelease);
        const releaseVersion = applyPrereleaseType(bumpTarget, releaseContext.previousRelease, this.prereleaseType);
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

            // Resume, rather than skip, a pull request whose release was already created by an earlier run that
            // then failed before it could finish commenting/relabeling — determineReleases() has no way to tell
            // "genuinely new" and "release exists, bookkeeping didn't finish" apart (both are still labeled
            // pending), so that distinction is made here instead by trying to create the release and falling
            // back to looking the existing one up by tag on a DuplicateReleaseError.
            let result;
            try {
                result = await this.github.createRelease(release);
                logger.info(`Created release ${result.id} at ${result.url}`);

                const comment = `:bowtie: Created release [${release.tag}](${result.url}) :tulip:`;
                const url = await this.github.commentOnIssue(comment, release.pullRequestNumber);
                logger.info(`Commented on pull request #${release.pullRequestNumber} at ${url}`);
            } catch (e) {
                if (!(e instanceof DuplicateReleaseError)) {
                    throw e;
                }

                logger.warn(`Release ${release.tag} already exists, resuming pull request #${release.pullRequestNumber} bookkeeping...`);
                result = await this.github.retrieveReleaseByTag(release.tag);
                // Deliberately not re-commenting here: since the release already existed, an earlier run most
                // likely posted the comment too, and comment failures are cosmetic — worth risking a rare
                // missing comment over guaranteeing a duplicate one on every retry.
            }

            // Add the tagged label before removing pending, not after: if this component's release run gets
            // interrupted between the two, a pull request left with BOTH labels is still unambiguously
            // recognizable as "released, cleanup unfinished" and safely retried (removeLabel on an
            // already-removed label is a no-op below) — left with NEITHER, it would look unreleased again and
            // determineReleases() would try to create a duplicate release for it on every subsequent run.
            logger.info(`Updating labels, adding '${taggedLabel(this.componentName)}'...`);
            await this.github.addPullRequestLabels([taggedLabel(this.componentName)], release.pullRequestNumber);
            logger.info(`Updating labels, removing '${pendingLabel(this.componentName)}'...`);
            await this.github.removePullRequestLabels([pendingLabel(this.componentName)], release.pullRequestNumber);
        }

        console.info(`✅️ Created ${releases.length} release(s) 🌷️`);
    }

    // Builds a Manifest for a single component, reusing an already-configured Github client, repository and
    // target branch. Used by ManifestRunner so that resolving the repository/branch/wasm init happens once per
    // run, regardless of how many components it processes. `componentName`/`componentPath` default to "" and
    // `allComponentPaths` to [""] (root component, single-project behaviour). `migration` is only passed while
    // a repository is migrating from single-project to multi-component mode. `prereleaseType` is only passed
    // for a component configured for pre-releases (see manifestConfig.ts, `ComponentConfig.prereleaseType`).
    static forComponent(
        github: Github,
        repository: Repository,
        targetBranch: string,
        componentName: string = "",
        componentPath: string = "",
        allComponentPaths: readonly string[] = [""],
        migration?: MigrationOptions,
        prereleaseType?: string,
    ): Manifest {
        return new Manifest(github, repository, targetBranch, componentName, componentPath, allComponentPaths, migration, prereleaseType);
    }
}

// Picks whichever of `a` and `b`'s numeric (major.minor.patch) parts is higher, discarding any pre-release
// identifier/build metadata either one carries (that's decided separately, see `applyPrereleaseType` below) —
// see `computeCandidate` above for why this must never move backwards relative to `previousRelease`.
function higherNumericTarget(a: Version, b: Version): Version {
    const numericallyHigherOrEqual = a.major !== b.major ? a.major > b.major
        : a.minor !== b.minor ? a.minor > b.minor
        : a.patch >= b.patch;
    const winner = numericallyHigherOrEqual ? a : b;
    return new Version(winner.major, winner.minor, winner.patch);
}

// Decides the final release version's pre-release identifier (if any) from `bumpTarget` (the plain
// major.minor.patch this release would be at, with no identifier — see `higherNumericTarget`/`bumpTarget`
// above), the previous release's version (to detect whether this continues the same train) and this
// component's configured `prereleaseType` (see manifestConfig.ts, README.md "Pre-releases"):
//  - No `prereleaseType` configured: always stable. This is also how a component *graduates* — removing
//    `prereleaseType` from config strips whatever pre-release identifier a previous release carried, even if
//    the numeric target stays exactly the same (e.g. "1.0.0-beta" -> "1.0.0", not "1.0.1").
//  - `prereleaseType` configured, and `previousRelease` is already a pre-release of this exact same
//    major.minor.patch target using this same identifier (or a numbered continuation of it): continue that
//    train by incrementing its trailing number (e.g. "beta" -> "beta.1", "beta.1" -> "beta.2").
//  - Otherwise (first release of a new train, e.g. after a bump moved the target, or after switching
//    `prereleaseType` to a different word): start fresh with the configured identifier verbatim.
function applyPrereleaseType(bumpTarget: Version, previousRelease: Version, prereleaseType: string | undefined): Version {
    if (prereleaseType === undefined) {
        return bumpTarget;
    }

    const sameTarget = previousRelease.major === bumpTarget.major
        && previousRelease.minor === bumpTarget.minor
        && previousRelease.patch === bumpTarget.patch;
    const continuingTrain = sameTarget && previousRelease.preRelease !== undefined && isContinuationOf(previousRelease.preRelease, prereleaseType);

    const preRelease = continuingTrain ? incrementPrereleaseIdentifier(previousRelease.preRelease!) : prereleaseType;
    return new Version(bumpTarget.major, bumpTarget.minor, bumpTarget.patch, preRelease, bumpTarget.build);
}

// True when `identifier` is either exactly `prereleaseType` or `prereleaseType` followed by a "." and a
// numbered continuation (e.g. "beta.3" continues "beta") — the shape `incrementPrereleaseIdentifier` always
// produces. Guards against blindly incrementing an unrelated identifier left over from before `prereleaseType`
// was changed to a different word (e.g. "beta.3" -> "rc" must start fresh at "rc", not "rc.4").
function isContinuationOf(identifier: string, prereleaseType: string): boolean {
    return identifier === prereleaseType || identifier.startsWith(`${prereleaseType}.`);
}
