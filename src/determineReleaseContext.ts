import { Commit } from "./commit";
import { matchesComponentPath } from "./componentPathFilter";
import { Github } from "./github";
import { logger } from "./logger";
import { parseVersionTag } from "./parseVersionTag";
import { Version } from "./version";

// See manifestConfig.ts (`MigrationConfig`) for the config schema and README.md for the user-facing explanation.
// `cutoverCommit` bounds history for every component during migration: commits at or before it predate any
// component concept, so they're never eligible as "unreleased" for any component (see `truncateAtCutover`).
// `legacyAnchorTagName` is a one-time fallback anchor for the single component that inherits the pre-migration
// repository's release history, used only until that component has its own component-scoped tag.
// `bootstrapVersion` is the starting baseline for every other component, which has no history to inherit.
export interface MigrationOptions {
    readonly cutoverCommit: string;
    readonly legacyAnchorTagName?: string;
    readonly bootstrapVersion?: Version;
}

// `componentTagPrefix` scopes previous-release detection to a single component's tags (see parseVersionTag).
// `componentPath`/`allComponentPaths` scope the returned `unreleasedCommits` to commits owned by this component
// (see componentPathFilter.ts). All default to the root component / single-project values, keeping
// single-project repositories (no `release-svp-config.json`) fully backward compatible.
export async function determineReleaseContext(
    github: Github,
    targetBranch: string,
    componentTagPrefix: string = "",
    componentPath: string = "",
    allComponentPaths: readonly string[] = [""],
    migration?: MigrationOptions,
): Promise<ReleaseContext> {
    const cachedCommits: Commit[] = [];
    const commitIndexBySha = new Map<string, number>();
    let commitIterator: AsyncGenerator<Commit> | undefined;
    let commitIteratorExhausted = false;

    // Pulls one more commit from the (lazily-created, shared) merge-commit iterator, extending `cachedCommits`
    // and `commitIndexBySha`. Reused by `findCommitIndex` (stop as soon as a specific sha is found) and
    // `loadAllCommits` (drain to the end) below, so the underlying iterator is only ever walked forward once,
    // regardless of how many tags need to be checked against it.
    async function pullNextCommit(): Promise<Commit | undefined> {
        if (commitIteratorExhausted) {
            return undefined;
        }

        commitIterator ??= github.mergeCommitIterator(targetBranch);
        const next = await commitIterator.next();
        if (next.done) {
            commitIteratorExhausted = true;
            return undefined;
        }

        commitIndexBySha.set(next.value.sha, cachedCommits.length);
        cachedCommits.push(next.value);
        return next.value;
    }

    async function findCommitIndex(sha: string): Promise<number | undefined> {
        const cached = commitIndexBySha.get(sha);
        if (cached !== undefined) {
            return cached;
        }

        while (await pullNextCommit() !== undefined) {
            const found = commitIndexBySha.get(sha);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }

    async function loadAllCommits(): Promise<void> {
        while (await pullNextCommit() !== undefined) {
            // Keep draining; `cachedCommits` is extended as a side effect of `pullNextCommit`.
        }
    }

    let previousRelease: Version | undefined;
    let previousReleaseIndex: number | undefined;
    let previousReleaseIsLegacyAnchor = false;
    // Tracks the newest *stable* (no SemVer pre-release identifier) tag, in addition to `previousRelease`
    // above (the newest tag of any kind) — see manifestConfig.ts (`prereleaseType`) and README.md
    // ("Pre-releases"). Needed so a component mid pre-release train can still compute its next bump from the
    // last stable baseline, and so graduating back to stable can drop the pre-release suffix correctly.
    let previousStableRelease: Version | undefined;

    // Tags are scanned newest-first, so a real component-scoped tag (once one exists) is always found before
    // we'd ever consider falling back to the legacy anchor tag below — the fallback only kicks in for this
    // component's very first release after migration.
    for await (const tag of github.tagIterator()) {
        const isLegacyAnchor = tag.name === migration?.legacyAnchorTagName;
        const version = parseVersionTag(tag.name, componentTagPrefix) ?? (isLegacyAnchor ? parseVersionTag(tag.name, "") : undefined);
        if (!version) {
            continue;
        }

        const index = await findCommitIndex(tag.sha);
        if (index === undefined) {
            logger.warn(`Tag '${tag.name}' not found in recent commits on branch '${targetBranch}', skipping`);
            continue;
        }

        if (previousRelease === undefined) {
            previousRelease = version;
            previousReleaseIndex = index;
            previousReleaseIsLegacyAnchor = isLegacyAnchor;
        }

        if (!version.preRelease) {
            previousStableRelease = version;
            break; // Found the newest release and the newest stable release; nothing further to look for.
        }
    }

    if (previousRelease === undefined || previousReleaseIndex === undefined) {
        // No tag found that is reachable from the target branch, this is the first release.
        await loadAllCommits();
        const eligibleCommits = migration ? truncateAtCutover(cachedCommits, migration.cutoverCommit) : cachedCommits;
        const firstRelease = migration?.bootstrapVersion ?? Version.unreleased;
        return {
            previousRelease: firstRelease,
            previousStableRelease: firstRelease,
            unreleasedCommits: filterCommitsByComponent(eligibleCommits, componentPath, allComponentPaths),
        };
    }

    const rawCommits = cachedCommits.slice(0, previousReleaseIndex);
    // Truncation only applies to the legacy-anchor fallback (see below): once the component has a genuine tag
    // of its own, that tag can only exist after the migration cutover, so its bounded slice is already tighter
    // than the cutover point — re-truncating would just spuriously warn that the (out-of-range) cutover commit
    // "wasn't found".
    const eligibleCommits = migration && previousReleaseIsLegacyAnchor ? truncateAtCutover(rawCommits, migration.cutoverCommit) : rawCommits;
    return {
        previousRelease,
        // No stable tag was ever found (either every tag scanned was a pre-release, or the search above never
        // needed to scan that far back before exhausting the tag list) — fall back the same way a component
        // with no release history at all does.
        previousStableRelease: previousStableRelease ?? migration?.bootstrapVersion ?? Version.unreleased,
        unreleasedCommits: filterCommitsByComponent(eligibleCommits, componentPath, allComponentPaths),
    };
}

export interface ReleaseContext {
    previousRelease: Version;
    previousStableRelease: Version;
    unreleasedCommits: Commit[];
}

// Thrown when a configured `migration.cutoverCommit` isn't reachable from the target branch's recent history
// (e.g. a typo, or the wrong branch). Migration correctness depends on every pre-cutover commit being excluded,
// so silently proceeding without truncation would risk re-releasing legacy history — this must fail the
// component's release run rather than warn and continue (see README.md).
export class MigrationCutoverNotFoundError extends Error {
    constructor(readonly cutoverCommit: string) {
        super(`Migration cutover commit '${cutoverCommit}' not found in recent commits, refusing to release without it (check 'migration.cutoverCommit' in release-svp-config.json)`);
    }
}

// Excludes `cutoverCommit` and everything before it from `commits` (which is ordered newest-first, like
// `cachedCommits` above). Used only during migration, to stop pre-migration commits from being (re-)attributed
// to a component that didn't conceptually exist yet — see MigrationOptions and README.md.
function truncateAtCutover(commits: Commit[], cutoverCommit: string): Commit[] {
    const index = commits.findIndex(commit => commit.sha === cutoverCommit);
    if (index === -1) {
        throw new MigrationCutoverNotFoundError(cutoverCommit);
    }

    return commits.slice(0, index);
}

// Filters commits down to the ones owned by `componentPath`, using each commit's associated pull request's
// changed-file data (see componentPathFilter.ts). Note: the tag-anchor lookup above always scans the full,
// unfiltered commit history — only the *returned* unreleased commits are scoped to this component.
function filterCommitsByComponent(commits: Commit[], componentPath: string, allComponentPaths: readonly string[]): Commit[] {
    return commits.filter(commit => {
        const pullRequest = commit.pullRequest;
        const verdict = matchesComponentPath(pullRequest?.changedFilePaths, componentPath, allComponentPaths);
        if (verdict !== "unknown") {
            return verdict === "match";
        }

        // No changed-file data is available at all (e.g. a direct commit with no associated pull request).
        // Conservatively attribute it to the root component only, rather than risk spuriously releasing every
        // other configured component whenever this happens.
        if (componentPath === "") {
            return true;
        }

        logger.warn(`Commit '${commit.sha}' has no changed-file data available, excluding it from component '${componentPath}' (attributed to the root component only)`);
        return false;
    });
}

