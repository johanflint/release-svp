import { Github } from "./github";
import { logger } from "./logger";
import { buildReleaseForComponent, pullRequestCoversComponent, Release } from "./release";

export interface ReleaseOptions {
    labelPending: string;
    // Prefix applied to release tags, scoping them to a single component — see componentNaming.tagPrefix.
    tagPrefix?: string;
    // Which component's release-notes section to extract from a (possibly multi-component) pull request body —
    // see release.ts, `buildReleaseForComponent`. "" for the root component.
    componentName: string;
}

// Finds this component's merged release pull requests that still need a GitHub Release/tag created for them.
//
// A merged pull request still carrying `options.labelPending` is, by definition, not yet released: Manifest's
// release() only removes that label once the release has actually been created (see manifest.ts). This is
// deliberately simple: the label is this tool's own bookkeeping, so it's an authoritative answer rather than a
// heuristic. An earlier version of this function instead tried to infer "already released" from a bounded window
// of this component's own tags plus a depth-based scan cutoff — that was a heuristic pretending to be a state
// check: it assumed pull request scan order tracked release recency closely enough that giving up after N
// confirmed-already-released pull requests in a row was safe, which doesn't hold in every case and could silently
// skip a genuinely unreleased pull request. Label-only filtering has no such cutoff, so it can't silently miss one.
export async function determineReleases(github: Github, targetBranch: string, options: ReleaseOptions): Promise<Release[]> {
    logger.info("Finding release candidates...");
    const mergedPullRequests = github.pullRequestIterator(targetBranch, "MERGED");
    const releases: Release[] = [];
    for await (const pullRequest of mergedPullRequests) {
        if (!pullRequest.labels.includes(options.labelPending)) {
            continue;
        }

        // Once a pull request can bundle several components' notes together (see README.md, "Combined release
        // pull requests"), a label match alone isn't enough — it only proves the pull request BELONGS to this
        // component's release group, not that this specific component is (still) a member of it. See
        // `pullRequestCoversComponent`.
        if (!pullRequestCoversComponent(pullRequest.body, options.componentName)) {
            logger.trace(`Pull request #${pullRequest.number} matched by label but has no release notes section for component '${options.componentName || "<root>"}', skipping`);
            continue;
        }

        const release = buildReleaseForComponent(pullRequest, options.componentName, options.tagPrefix);
        if (release) {
            logger.debug(`Found unreleased pull request #${pullRequest.number}`);
            releases.push(release);
        } else {
            logger.trace(`Pull request #${pullRequest.number} does not contain valid release notes or version`);
        }
    }

    return releases;
}
