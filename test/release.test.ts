import { describe, expect, it } from "vitest";
import { PullRequest } from "../src/commit";
import { createPullRequestBody } from "../src/pullRequestBody";
import { buildReleaseForComponent, pullRequestCoversComponent } from "../src/release";

describe("buildReleaseForComponent", () => {
    const pullRequest: PullRequest = {
        sha: "sha",
        number: 4,
        title: `Release v1.2.3`,
        body: createPullRequestBody([{ componentName: "", notes: changelog }]),
        permalink: "unused",
        headBranchName: "release-svp--branches-main",
        baseBranchName: "main",
        labels: ["autorelease: pending"],
    }

    it("returns undefined if no sha is available", () => {
        const release = buildReleaseForComponent({...pullRequest, sha: undefined }, "");
        expect(release).toBeUndefined();
    });

    it("returns undefined if the pull request body cannot be parsed", () => {
        const release = buildReleaseForComponent({...pullRequest, body: "My release" }, "");
        expect(release).toBeUndefined();
    });

    it("returns undefined if the pull request body contains no version string", () => {
        const release = buildReleaseForComponent({...pullRequest, body: createPullRequestBody([{ componentName: "", notes: changelogWithoutVersion }]) }, "");
        expect(release).toBeUndefined();
    });

    it("returns a release if all release info is present", () => {
        const release = buildReleaseForComponent(pullRequest, "");

        expect(release?.sha).toBe("sha");
        expect(release?.tag).toBe("v1.2.3");
        expect(release?.notes).toBe(changelog.trim());
    });

    it("returns a release if all release info is present if the pull request body contains no footer delimiter", () => {
        const release = buildReleaseForComponent({...pullRequest, body: pullRequestBodyNoFooterDelimiter }, "");

        expect(release?.sha).toBe("sha");
        expect(release?.tag).toBe("v1.2.3");
        expect(release?.notes).toBe(changelog.trim());
    });

    it("prefixes the tag with the given component prefix", () => {
        const release = buildReleaseForComponent(pullRequest, "", "api-");

        expect(release?.tag).toBe("api-v1.2.3");
    });

    describe("with a pull request body covering multiple components", () => {
        const multiComponentBody = createPullRequestBody([
            { componentName: "ios-client", notes: changelog },
            { componentName: "android-client", notes: changelogAndroid },
        ]);

        it("extracts the requested component's own version and notes, ignoring the others", () => {
            const release = buildReleaseForComponent({...pullRequest, body: multiComponentBody }, "ios-client");

            expect(release?.tag).toBe("v1.2.3");
            expect(release?.notes).toBe(changelog.trim());
        });

        it("extracts a different component's own version and notes from the same body", () => {
            const release = buildReleaseForComponent({...pullRequest, body: multiComponentBody }, "android-client");

            expect(release?.tag).toBe("v2.0.0");
            expect(release?.notes).toBe(changelogAndroid.trim());
        });

        it("returns undefined when the requested component has no section in the body", () => {
            const release = buildReleaseForComponent({...pullRequest, body: multiComponentBody }, "product-b");

            expect(release).toBeUndefined();
        });
    });

    describe("with a legacy pull request body (no component markers)", () => {
        // Regression test: pull requests opened by a pre-combined-PR-format version of the tool have no
        // `<!-- release-svp:component:X -->` markers at all — the whole body is treated as this component's
        // notes, since `determineReleases` only ever considers a pull request in the first place because its
        // branch/label already identifies which single component it belongs to.
        const legacyBody = `:bowtie: I have created a release
---


${changelog}

---
This pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).`;

        it("treats the whole content as the given component's notes", () => {
            const release = buildReleaseForComponent({...pullRequest, body: legacyBody }, "any-component-name");

            expect(release?.tag).toBe("v1.2.3");
            expect(release?.notes).toBe(changelog.trim());
        });
    });
});

describe("pullRequestCoversComponent", () => {
    it("returns true for a legacy body with no component markers at all", () => {
        // Legacy, pre-combined-PR-format bodies always cover the single component determineReleases already
        // matched by branch/label — see release.ts for the full rationale.
        const legacyBody = `:bowtie: I have created a release
---


${changelog}

---
This pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).`;

        expect(pullRequestCoversComponent(legacyBody, "any-component-name")).toBe(true);
    });

    it("returns true for a body that cannot be parsed at all", () => {
        // Deliberately permissive: parsing failures are diagnosed and logged by buildReleaseForComponent instead,
        // not silently swallowed here as "doesn't cover this component".
        expect(pullRequestCoversComponent("My release", "any-component-name")).toBe(true);
    });

    it("returns true when the body has a marked section for the requested component", () => {
        const body = createPullRequestBody([
            { componentName: "ios-client", notes: changelog },
            { componentName: "android-client", notes: changelogAndroid },
        ]);

        expect(pullRequestCoversComponent(body, "ios-client")).toBe(true);
    });

    it("returns false when the body has marked sections but none for the requested component", () => {
        const body = createPullRequestBody([
            { componentName: "ios-client", notes: changelog },
            { componentName: "android-client", notes: changelogAndroid },
        ]);

        expect(pullRequestCoversComponent(body, "product-b")).toBe(false);
    });
});

const changelog = `## v1.2.3 (2025-11-26)

### Features

- Fixes environment variable access in script ([#4](https://github.com/owner/repo/pull/4))
`;

const changelogAndroid = `## v2.0.0 (2025-11-26)

### Features

- Adds dark mode support ([#7](https://github.com/owner/repo/pull/7))
`;

const changelogWithoutVersion = `## 2025-11-26

### Features

- Fixes environment variable access in script ([#4](https://github.com/owner/repo/pull/4))
`;

const pullRequestBodyNoFooterDelimiter = `:bowtie: I have created a release
---


${changelog}

This pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).`;