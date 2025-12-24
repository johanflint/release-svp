import { describe, expect, it } from "vitest";
import { PullRequest } from "../src/commit";
import { createPullRequestBody } from "../src/pullRequestBody";
import { buildRelease } from "../src/release";

describe("buildRelease", () => {
    const pullRequest: PullRequest = {
        sha: "sha",
        number: 4,
        title: `Release v1.2.3`,
        body: createPullRequestBody(changelog),
        permalink: "unused",
        headBranchName: "release-svp--branches-main",
        baseBranchName: "main",
        labels: ["autorelease: pending"],
    }

    it("returns undefined if no sha is available", () => {
        const release = buildRelease({...pullRequest, sha: undefined });
        expect(release).toBeUndefined();
    });

    it("returns undefined if the pull request body cannot be parsed", () => {
        const release = buildRelease({...pullRequest, body: "My release" });
        expect(release).toBeUndefined();
    });

    it("returns undefined if the pull request body contains no version string", () => {
        const release = buildRelease({...pullRequest, body: createPullRequestBody(changelogWithoutVersion) });
        expect(release).toBeUndefined();
    });

    it("returns a release if all release info is present", () => {
        const release = buildRelease(pullRequest);

        expect(release?.sha).toBe("sha");
        expect(release?.tag).toBe("v1.2.3");
        expect(release?.notes).toBe(changelog.trim());
    });

    it("returns a release if all release info is present if the pull request body contains no footer delimiter", () => {
        const release = buildRelease({...pullRequest, body: pullRequestBodyNoFooterDelimiter });

        expect(release?.sha).toBe("sha");
        expect(release?.tag).toBe("v1.2.3");
        expect(release?.notes).toBe(changelog.trim());
    });
});

const changelog = `## v1.2.3 (2025-11-26)

### Features

- Fixes environment variable access in script ([#4](https://github.com/owner/repo/pull/4))
`;

const changelogWithoutVersion = `## 2025-11-26

### Features

- Fixes environment variable access in script ([#4](https://github.com/owner/repo/pull/4))
`;

const pullRequestBodyNoFooterDelimiter = `:bowtie: I have created a release
---


## v1.2.3 (2025-11-26)

### Features

- Fixes environment variable access in script ([#4](https://github.com/owner/repo/pull/4))

This pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).`;