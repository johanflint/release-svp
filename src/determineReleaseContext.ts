import { Commit } from "./commit";
import { Github } from "./github";
import { logger } from "./logger";
import { Tag } from "./tag";
import { Version } from "./version";

const TAG_PATTERN = /^(?<v>v)?(?<version>\d+\.\d+\.\d+.*)$/;

export async function determineReleaseContext(github: Github, targetBranch: string): Promise<ReleaseContext> {
    const commitShas = new Set<string>();
    const cachedCommits: Commit[] = [];

    const tagGenerator = github.tagIterator();
    for await (const tag of tagGenerator) {
        const version = matchTag(tag.name);
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
                const unreleasedCommits = cachedCommits.slice(0, index);
                return {
                    previousRelease: version,
                    unreleasedCommits,
                };
            }
            index++;
        }

        logger.warn(`Tag '${tag.name}' not found in recent commits on branch '${targetBranch}', skipping`);
    }

    // No tag found that is reachable from the target branch, this is the first release
    return {
        previousRelease: Version.unreleased,
        unreleasedCommits: cachedCommits,
    };
}

export interface ReleaseContext {
    previousRelease: Version;
    unreleasedCommits: Commit[];
}

function toIterable<T>(data: T[]): AsyncGenerator<T, void, unknown> {
    return (async function* () {
        for (const item of data) yield item;
    })();
}

function matchTag(tagName: string): Version | undefined {
    const match = tagName.match(TAG_PATTERN);
    if (match?.groups) {
        return Version.parse(match.groups["version"]);
    }

    return;
}
