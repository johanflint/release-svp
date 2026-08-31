import { Commit } from "./commit";
import { matchesComponentPath } from "./componentPathFilter";
import { Github } from "./github";
import { logger } from "./logger";
import { parseVersionTag } from "./parseVersionTag";
import { Version } from "./version";

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
): Promise<ReleaseContext> {
    const commitShas = new Set<string>();
    const cachedCommits: Commit[] = [];

    const tagGenerator = github.tagIterator();
    for await (const tag of tagGenerator) {
        const version = parseVersionTag(tag.name, componentTagPrefix);
        if (!version) {
            continue;
        }

        const useCache = cachedCommits.length > 0;
        const commits = useCache ? toIterable(cachedCommits) : github.mergeCommitIterator(targetBranch);
        let index = 0;
        for await (const commit of commits) {
            if (!useCache) {
                commitShas.add(commit.sha);
                cachedCommits.push(commit);
            }

            if (commitShas.has(tag.sha)) {
                const unreleasedCommits = filterCommitsByComponent(cachedCommits.slice(0, index), componentPath, allComponentPaths);
                return {
                    previousRelease: version,
                    unreleasedCommits,
                };
            }
            index++;
        }

        logger.warn(`Tag '${tag.name}' not found in recent commits on branch '${targetBranch}', skipping`);
    }

    if (cachedCommits.length === 0) { // True if there are no tags
        const commits = github.mergeCommitIterator(targetBranch);
        for await (const commit of commits) {
            cachedCommits.push(commit);
        }
    }

    // No tag found that is reachable from the target branch, this is the first release
    return {
        previousRelease: Version.unreleased,
        unreleasedCommits: filterCommitsByComponent(cachedCommits, componentPath, allComponentPaths),
    };
}

export interface ReleaseContext {
    previousRelease: Version;
    unreleasedCommits: Commit[];
}

// Filters commits down to the ones owned by `componentPath`, using each commit's associated pull request's
// changed-file data (see componentPathFilter.ts). Note: the tag-anchor lookup above always scans the full,
// unfiltered commit history — only the *returned* unreleased commits are scoped to this component.
function filterCommitsByComponent(commits: Commit[], componentPath: string, allComponentPaths: readonly string[]): Commit[] {
    return commits.filter(commit => {
        const pullRequest = commit.pullRequest;
        const verdict = matchesComponentPath(pullRequest?.changedFilePaths, pullRequest?.changedFilePathsTruncated, componentPath, allComponentPaths);
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

function toIterable<T>(data: T[]): AsyncGenerator<T, void, unknown> {
    return (async function* () {
        for (const item of data) yield item;
    })();
}

