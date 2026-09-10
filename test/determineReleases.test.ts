import { describe, expect, it, vi } from "vitest";
import { PullRequest } from "../src/commit";
import { determineReleases, ReleaseOptions } from "../src/determineReleases";
import { Github } from "../src/github";
import { logger } from "../src/logger";
import { createPullRequestBody } from "../src/pullRequestBody";
import { Release } from "../src/release";

describe("determineReleases", () => {
    const github = new Github({ repo: "repo", owner: "owner" }, "token", logger);
    const options: ReleaseOptions = {
        labelPending: "autorelease: pending",
        componentName: "",
    };

    describe("with no merged pull requests", () => {
        vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {});

        it("returns no releases", async () => {
            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });
    });

    describe("with merged pull requests", () => {
        it("returns a release for a pull request still labeled pending", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield { ...defaultPullRequest, labels: ["autorelease: pending"] }
            });

            const result = await determineReleases(github, "main", options);
            expect(result).toEqual([expectedRelease]);
        });

        it("ignores pull requests that do not carry the pending label", async () => {
            // A merged pull request that no longer carries the pending label has already been released — see
            // Manifest.release(), which only removes it once the release has actually been created. Once removed,
            // it's authoritative: no need to fall back to inspecting the branch name or scanning tag history.
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield { ...defaultPullRequest, headBranchName: "release-svp--branches-main", labels: [] }
            });

            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });

        it("ignores pull requests carrying a different component's pending label", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield { ...defaultPullRequest, labels: ["autorelease: pending (some-other-component)"] }
            });

            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });

        it("ignores a pull request whose label matches but has no release notes section for this component", async () => {
            // Regression test: once a pull request can bundle several components' notes together (combined
            // release pull requests), matching this component's own label isn't enough proof that this component
            // is (still) a member of it -- e.g. it may have already been released and dropped from the body, or
            // belong to a different release group that happens to reuse the label.
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    labels: ["autorelease: pending"],
                    body: createPullRequestBody([{ componentName: "some-other-component", notes: "## v0.1.0\n\n- Release notes" }]),
                }
            });

            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });

        it("returns a release for the matching component's own section in a pull request covering multiple components", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    labels: ["autorelease: pending"],
                    body: createPullRequestBody([
                        { componentName: "", notes: "## v0.1.0\n\n- Release notes" },
                        { componentName: "some-other-component", notes: "## v2.0.0\n\n- Other notes" },
                    ]),
                }
            });

            const result = await determineReleases(github, "main", options);
            expect(result).toEqual([expectedRelease]);
        });

        it("prefixes the release tag with the given component prefix", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield { ...defaultPullRequest, labels: ["autorelease: pending (api)"] }
            });

            const result = await determineReleases(github, "main", { ...options, labelPending: "autorelease: pending (api)", tagPrefix: "api-" });
            expect(result).toEqual([{ ...expectedRelease, tag: "api-v0.1.0" }]);
        });

        it("ignores pull requests with invalid release notes", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    labels: ["autorelease: pending"],
                    body: "some body without version number",
                }
            });
            vi.spyOn(logger, "warn");

            const result = await determineReleases(github, "main", options);

            expect(logger.warn).toHaveBeenCalledWith("Unable to parse the body for pull request #1");
            expect(result.length).toBe(0);
        });
    });

    describe("finding a still-pending pull request that a scan-depth heuristic would previously have missed", () => {
        // Regression test for a real bug: determineReleases() used to infer "already released" from a bounded
        // window of this component's own tags plus a cutoff that gave up scanning after enough confirmed-
        // released pull requests in a row, assuming everything further back was released too. That's a heuristic
        // pretending to be a state check, and could silently skip a genuinely unreleased pull request depending
        // on scan order. Filtering purely by the pending label has no such cutoff: it scans every merged pull
        // request for this branch, so a still-pending one can never be missed regardless of how many other,
        // already-released pull requests surround it.
        it("finds a still-pending pull request however many already-released pull requests it's scanned past first", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                for (let i = 0; i < 25; i++) {
                    yield { ...defaultPullRequest, number: i + 1, labels: [] };
                }
                yield { ...defaultPullRequest, number: 26, labels: ["autorelease: pending"] };
            });

            const result = await determineReleases(github, "main", options);

            expect(result).toEqual([{ ...expectedRelease, pullRequestNumber: 26 }]);
        });
    });
});

const defaultPullRequest: PullRequest = {
    sha: "sha",
    number: 1,
    title: "Title",
    body: createPullRequestBody([{ componentName: "", notes: "## v0.1.0\n\n- Release notes" }]),
    permalink: "permalink",
    headBranchName: "release-svp--branches-main",
    baseBranchName: "main",
    labels: []
}

const expectedRelease: Release = {
    sha: "sha",
    tag: "v0.1.0",
    notes: "## v0.1.0\n" +
        "\n" +
        "- Release notes",
    pullRequestNumber: 1,
    prerelease: false,
}
