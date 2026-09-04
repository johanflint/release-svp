import { describe, expect, it } from "vitest";
import { PullRequest } from "../src/commit";
import { buildCombinedSections, findConflictingOpenPullRequest, pullRequestTitle } from "../src/combinedPullRequest";
import { ComponentCandidate } from "../src/manifest";
import { ComponentConfig } from "../src/manifestConfig";
import { createPullRequestBody } from "../src/pullRequestBody";
import { ReleaseUnit } from "../src/releaseUnit";
import { Version } from "../src/version";

function component(name: string, releaseGroup?: string): ComponentConfig {
    return { path: name, component: name, releaseType: "node", releaseGroup };
}

function candidate(componentName: string, version: string, changelog: string, updates: ComponentCandidate["updates"] = []): ComponentCandidate {
    return { componentName, releaseVersion: Version.parse(version), changelog, updates };
}

function pullRequestWithBody(body: string): PullRequest {
    return {
        sha: "sha",
        number: 1,
        title: "Release",
        body,
        permalink: "unused",
        headBranchName: "release-svp--branches-main--combined",
        baseBranchName: "main",
        labels: [],
    };
}

describe("buildCombinedSections", () => {
    const ios = component("ios-client", "product-a");
    const android = component("android-client", "product-a");
    const unit: ReleaseUnit = { groupId: "product-a", branchName: "release-svp--branches-main--product-a", members: [ios, android] };

    it("builds a fresh section (and flattens updates) for every member with a candidate when there is no existing pull request", () => {
        const iosUpdate = { path: "ios/version.txt", createIfMissing: true, updater: { updateContent: () => "" } };
        const androidUpdate = { path: "android/version.txt", createIfMissing: true, updater: { updateContent: () => "" } };
        const candidates = new Map([
            ["ios-client", candidate("ios-client", "1.0.0", "## v1.0.0\n\n- iOS notes", [iosUpdate])],
            ["android-client", candidate("android-client", "2.0.0", "## v2.0.0\n\n- Android notes", [androidUpdate])],
        ]);

        const result = buildCombinedSections(unit, candidates, undefined);

        expect(result).toEqual({
            sections: [
                { componentName: "ios-client", notes: "## v1.0.0\n\n- iOS notes" },
                { componentName: "android-client", notes: "## v2.0.0\n\n- Android notes" },
            ],
            updates: [iosUpdate, androidUpdate],
        });
    });

    it("carries forward a member's existing section unchanged when it has no candidate this run, and excludes it from updates", () => {
        const existingBody = createPullRequestBody([
            { componentName: "ios-client", notes: "## v1.0.0\n\n- iOS notes" },
            { componentName: "android-client", notes: "## v2.0.0\n\n- Android notes" },
        ]);
        const iosUpdate = { path: "ios/version.txt", createIfMissing: true, updater: { updateContent: () => "" } };
        // Only iOS has fresh, unreleased commits this run; android has none yet.
        const candidates = new Map([["ios-client", candidate("ios-client", "1.1.0", "## v1.1.0\n\n- More iOS notes", [iosUpdate])]]);

        const result = buildCombinedSections(unit, candidates, pullRequestWithBody(existingBody));

        expect(result).toEqual({
            sections: [
                { componentName: "ios-client", notes: "## v1.1.0\n\n- More iOS notes" },
                { componentName: "android-client", notes: "## v2.0.0\n\n- Android notes" },
            ],
            updates: [iosUpdate],
        });
    });

    it("drops a member entirely when it has no candidate this run and no existing section either", () => {
        const candidates = new Map([["ios-client", candidate("ios-client", "1.0.0", "## v1.0.0\n\n- iOS notes")]]);

        const result = buildCombinedSections(unit, candidates, undefined);

        expect(result).toEqual({ sections: [{ componentName: "ios-client", notes: "## v1.0.0\n\n- iOS notes" }], updates: [] });
    });

    it("fails with the orphaned component name(s) when the existing pull request has a section for a component that is no longer a member of this unit", () => {
        const existingBody = createPullRequestBody([
            { componentName: "ios-client", notes: "## v1.0.0\n\n- iOS notes" },
            { componentName: "web-client", notes: "## v3.0.0\n\n- Web notes" },
        ]);
        const candidates = new Map([["ios-client", candidate("ios-client", "1.1.0", "## v1.1.0\n\n- More iOS notes")]]);

        const result = buildCombinedSections(unit, candidates, pullRequestWithBody(existingBody));

        expect(result).toEqual({ orphaned: ["web-client"] });
    });
});

describe("pullRequestTitle", () => {
    it("uses the repository name for the implicit default group", () => {
        const unit: ReleaseUnit = { groupId: "combined", branchName: "release-svp--branches-main--combined", members: [component("ios-client"), component("android-client")] };
        expect(pullRequestTitle({ unit, totalComponentCount: 2, repositoryName: "repo" })).toBe("Release repo");
    });

    it("uses the group id for an explicit release group", () => {
        const unit: ReleaseUnit = { groupId: "product-a", branchName: "release-svp--branches-main--product-a", members: [component("ios-client"), component("android-client")] };
        expect(pullRequestTitle({ unit, totalComponentCount: 2, repositoryName: "repo" })).toBe("Release product-a");
    });

    it("uses just the version for a singleton unit when only one component is configured in total", () => {
        const unit: ReleaseUnit = { branchName: "release-svp--branches-main", members: [component("")] };
        expect(pullRequestTitle({ unit, totalComponentCount: 1, repositoryName: "repo", releaseVersion: Version.parse("1.2.3") })).toBe("Release v1.2.3");
    });

    it("includes the component name for a singleton unit when multiple components are configured in total", () => {
        const unit: ReleaseUnit = { branchName: "release-svp--branches-main--backend", members: [component("backend")] };
        expect(pullRequestTitle({ unit, totalComponentCount: 2, repositoryName: "repo", releaseVersion: Version.parse("1.2.3") })).toBe("Release backend v1.2.3");
    });
});

describe("findConflictingOpenPullRequest", () => {
    const body = createPullRequestBody([{ componentName: "api", notes: "## v1.0.0\n\n- Notes" }]);

    it("returns undefined when no open pull request references the component on a different branch", () => {
        const result = findConflictingOpenPullRequest([], "api", "release-svp--branches-main--combined", "main");
        expect(result).toBeUndefined();
    });

    it("finds a legacy, pre-upgrade pull request still open on the component's own old branch", () => {
        const legacyPullRequest: PullRequest = {
            sha: "sha",
            number: 2,
            title: "Release v1.0.0",
            body: "## v1.0.0\n\n- Notes", // no markers -- legacy body
            permalink: "unused",
            headBranchName: "release-svp--branches-main--api",
            baseBranchName: "main",
            labels: ["autorelease: pending (api)"],
        };

        const result = findConflictingOpenPullRequest([legacyPullRequest], "api", "release-svp--branches-main--combined", "main");

        expect(result).toBe(legacyPullRequest);
    });

    it("ignores the unit's own pull request on its own branch", () => {
        const ownPullRequest: PullRequest = {
            ...pullRequestWithBody(body),
            headBranchName: "release-svp--branches-main--combined",
            labels: ["autorelease: pending (api)"],
        };

        const result = findConflictingOpenPullRequest([ownPullRequest], "api", "release-svp--branches-main--combined", "main");

        expect(result).toBeUndefined();
    });

    it("ignores a pull request whose branch/label matches but whose body no longer covers this component", () => {
        const otherComponentBody = createPullRequestBody([{ componentName: "some-other-component", notes: "## v1.0.0\n\n- Notes" }]);
        const pullRequest: PullRequest = {
            ...pullRequestWithBody(otherComponentBody),
            headBranchName: "release-svp--branches-main--api",
        };

        const result = findConflictingOpenPullRequest([pullRequest], "api", "release-svp--branches-main--combined", "main");

        expect(result).toBeUndefined();
    });
});
