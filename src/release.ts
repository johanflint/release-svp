import { PullRequest } from "./commit";
import { logger } from "./logger";
import { parsePullRequestBody } from "./pullRequestBody";
import { Version } from "./version";

export interface Release {
    readonly sha: string;
    readonly tag: string;
    readonly notes: string;
    readonly pullRequestNumber: number;
}

export function buildRelease(mergedPullRequest: PullRequest): Release | undefined {
    if (!mergedPullRequest.sha) {
        logger.warn(`Pull request #${mergedPullRequest.number}  has no SHA — not merged? Skipping.`);
        return;
    }

    const releaseInfo = extractReleaseInfo(mergedPullRequest.body, mergedPullRequest.number);
    if (!releaseInfo) {
        return;
    }

    return {
        sha: mergedPullRequest.sha,
        tag: `v${releaseInfo.version}`,
        notes: releaseInfo.notes,
        pullRequestNumber: mergedPullRequest.number,
    };
}

const VERSION_REGEX = /^#{2,} v?\[?(?<version>\d+\.\d+\.\d+[^\]]*)]?/;
function extractReleaseInfo(body: string, pullRequestNumber: number) {
    const pullRequestBody = parsePullRequestBody(body);
    if (!pullRequestBody) {
        logger.warn(`Unable to parse the body for pull request #${pullRequestNumber}`);
        return;
    }

    const content = pullRequestBody.content.trim();
    const match = content.match(VERSION_REGEX);
    const versionString = match?.groups?.version;
    if (!versionString) {
        logger.warn("Unable to find a version in the release notes");
        return;
    }

    return {
        version: Version.parse(versionString),
        notes: content,
    }
}
