import { PullRequest } from "./commit";
import { logger } from "./logger";
import { extractComponentSections, parsePullRequestBody } from "./pullRequestBody";
import { Version } from "./version";

export interface Release {
    readonly sha: string;
    readonly tag: string;
    readonly notes: string;
    readonly pullRequestNumber: number;
}

export function buildReleaseForComponent(mergedPullRequest: PullRequest, componentName: string, tagPrefix: string = ""): Release | undefined {
    if (!mergedPullRequest.sha) {
        logger.warn(`Pull request #${mergedPullRequest.number}  has no SHA — not merged? Skipping.`);
        return;
    }

    const releaseInfo = extractReleaseInfo(mergedPullRequest.body, mergedPullRequest.number, componentName);
    if (!releaseInfo) {
        return;
    }

    return {
        sha: mergedPullRequest.sha,
        tag: `${tagPrefix}v${releaseInfo.version}`,
        notes: releaseInfo.notes,
        pullRequestNumber: mergedPullRequest.number,
    };
}

const VERSION_REGEX = /^#{2,} v?\[?(?<version>\d+\.\d+\.\d+[^\]]*)]?/;
function extractReleaseInfo(body: string, pullRequestNumber: number, componentName: string) {
    const pullRequestBody = parsePullRequestBody(body);
    if (!pullRequestBody) {
        logger.warn(`Unable to parse the body for pull request #${pullRequestNumber}`);
        return;
    }

    const notes = extractNotesForComponent(pullRequestBody.content, componentName, pullRequestNumber);
    if (notes === undefined) {
        return;
    }

    const match = notes.match(VERSION_REGEX);
    const versionString = match?.groups?.version;
    if (!versionString) {
        logger.warn("Unable to find a version in the release notes");
        return;
    }

    return {
        version: Version.parse(versionString),
        notes,
    }
}

// Pull requests written by this version of release-svp always wrap each component's release notes in a
// `<!-- release-svp:component:X -->` ... `<!-- /release-svp:component:X -->` marker pair (see
// pullRequestBody.ts, `createPullRequestBody`), so a single pull request covering multiple components can be
// parsed per-component. Pull requests opened by an older, pre-combined-PR version of the tool have no markers
// at all — but `determineReleases` only ever considers a pull request in the first place because its branch
// name or label already identifies which single component it belongs to (see determineReleases.ts), so in that
// legacy case the whole content is that component's notes.
function extractNotesForComponent(content: string, componentName: string, pullRequestNumber: number): string | undefined {
    const sections = extractComponentSections(content);
    if (sections.length === 0) {
        return content.trim();
    }

    const section = sections.find(section => section.componentName === componentName);
    if (!section) {
        logger.warn(`Pull request #${pullRequestNumber} has no release notes section for component '${componentName || "<root>"}'`);
        return undefined;
    }

    return section.notes.trim();
}
