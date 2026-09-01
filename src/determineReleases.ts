import { Github } from "./github";
import { logger } from "./logger";
import { parseVersionTag } from "./parseVersionTag";
import { buildRelease, Release } from "./release";
import { Tag } from "./tag";

// How deep into the release history to scan before assuming everything older is already released
// Only counts tags for the component to be released
const RELEASE_HISTORY_DEPTH: number = 10;

// Safety ceiling on how many *repo-wide* tags to scan while looking for this component's own tags, so a
// component with no (or very few) prior releases still terminates in a monorepo with a large, unrelated tag
// history — see retrieveVersionTags below.
const TAG_SCAN_SAFETY_LIMIT: number = 1000;

export interface ReleaseOptions {
    // Exact release-PR branch name (not a prefix) to match against — see componentNaming.releaseBranchName.
    releaseBranchName: string;
    labelPending: string;
    // Prefix applied to release tags, scoping them to a single component — see componentNaming.tagPrefix.
    tagPrefix?: string;
}

export async function determineReleases(github: Github, targetBranch: string, options: ReleaseOptions): Promise<Release[]> {
    logger.info("Finding release candidates...");
    const versionTags = await retrieveVersionTags(github, options.tagPrefix ?? "");
    const releasedShas = new Set(versionTags.map(tag => tag.sha));

    const mergedPullRequests = github.pullRequestIterator(targetBranch, "MERGED");
    const releases: Release[] = [];
    let confirmedReleaseCount = 0;
    for await (const pullRequest of mergedPullRequests) {
        const isReleasePullRequest = pullRequest.headBranchName === options.releaseBranchName || pullRequest.labels.includes(options.labelPending);
        if (!isReleasePullRequest) {
            continue;
        }

        if (releasedShas.has(pullRequest.sha || "")) {
            logger.debug(`Skipping already released pull request #${pullRequest.number}`);
            confirmedReleaseCount++;
            if (confirmedReleaseCount === RELEASE_HISTORY_DEPTH) {
                logger.info(`Found ${RELEASE_HISTORY_DEPTH} previous releases after examining pull request #${pullRequest.number}, assuming older pull requests have been released`);
                break;
            }

            continue;
        }

        const release = buildRelease(pullRequest, options.tagPrefix);
        if (release) {
            logger.debug(`Found unreleased pull request #${pullRequest.number}`);
            releases.push(release);
        } else {
            logger.trace(`Pull request #${pullRequest.number} does not contain valid release notes or version`);
        }
    }

    return releases;
}

async function retrieveVersionTags(github: Github, tagPrefix: string) {
    // Repo-wide tags interleave across every configured component (newest-first), so a fixed *total* tag count
    // (e.g. "the newest 100 tags") can miss this component's own recent tags entirely if other components have
    // released more often — that previously caused determineReleases() to mistake an already-released pull
    // request for an unreleased one. Instead, keep scanning until we've found enough of *our own* matching tags
    // (the same depth determineReleases() itself treats as "enough to conclude everything older is released"),
    // bounded by TAG_SCAN_SAFETY_LIMIT so a component with little or no tag history still terminates.
    const tags: Tag[] = [];
    let scanned = 0;
    for await (const tag of github.tagIterator()) {
        scanned++;
        if (parseVersionTag(tag.name, tagPrefix)) {
            tags.push(tag);
            if (tags.length === RELEASE_HISTORY_DEPTH) {
                break;
            }
        }

        if (scanned === TAG_SCAN_SAFETY_LIMIT) {
            logger.warn(`⚠️ Scanned ${TAG_SCAN_SAFETY_LIMIT} tags without finding ${RELEASE_HISTORY_DEPTH} releases for tag prefix '${tagPrefix}', stopping`);
            break;
        }
    }

    return tags;
}
