import { Github } from "./github";
import { logger } from "./logger";
import { parseVersionTag } from "./parseVersionTag";
import { buildRelease, Release } from "./release";
import { Tag } from "./tag";

// How deep into the release history to scan before assuming everything older is already released
const RELEASE_HISTORY_DEPTH: number = 10;

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
    const tags: Tag[] = [];
    for await (const tag of github.tagIterator(100)) {
        if (parseVersionTag(tag.name, tagPrefix)) {
            tags.push(tag);
        }
    }

    return tags;
}
