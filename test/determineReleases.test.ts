import { describe, expect, it, vi } from "vitest";
import { PullRequest } from "../src/commit";
import { determineReleases, ReleaseOptions } from "../src/determineReleases";
import { Github } from "../src/github";
import { logger } from "../src/logger";
import { createPullRequestBody } from "../src/pullRequestBody";
import { Release } from "../src/release";
import { Tag } from "../src/tag";

describe("determineReleases", () => {
    const github = new Github({ repo: "repo", owner: "owner" }, "token", logger);
    const options: ReleaseOptions = {
        releaseBranchName: "release-svp--branches-main",
        labelPending: "autorelease: pending",
        componentName: "",
    };

    vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
        yield { sha: "", name: "ignored-tag", committedDate: "" }
        yield { sha: "release", name: "0.1.0", committedDate: "" }
    });

    describe("with no merged pull requests", () => {
        vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {});

        it("returns no releases", async () => {
            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });
    });

    describe("with merged pull requests", () => {
        it("returns a release if the head branch name prefix matches", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    headBranchName: "release-svp--branches-main",
                    labels: [],
                }
            });

            const result = await determineReleases(github, "main", options);
            expect(result).toEqual([expectedRelease]);
        });

        it("returns a release if the label matches", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    headBranchName: "fix/a-bug",
                    labels: ["autorelease: pending"],
                }
            });

            const result = await determineReleases(github, "main", options);
            expect(result).toEqual([expectedRelease]);
        });

        it("ignores pull requests that do not match the branch name prefix or labels", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    headBranchName: "fix/a-bug",
                    labels: [],
                }
            });

            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });

        it("ignores a pull request whose branch/label matches but has no release notes section for this component", async () => {
            // Regression test: once a pull request can bundle several components' notes together (combined
            // release pull requests), matching this component's own branch/label isn't enough proof that this
            // component is (still) a member of it -- e.g. it may have already been released and dropped from
            // the body, or belong to a different release group that happens to reuse the branch/label.
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
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
                    body: createPullRequestBody([
                        { componentName: "", notes: "## v0.1.0\n\n- Release notes" },
                        { componentName: "some-other-component", notes: "## v2.0.0\n\n- Other notes" },
                    ]),
                }
            });

            const result = await determineReleases(github, "main", options);
            expect(result).toEqual([expectedRelease]);
        });

        it("ignores pull requests whose branch name only has the release branch name as a prefix", async () => {
            // Regression test: a component's release branch (e.g. "release-svp--branches-main--api") must not
            // match another component's exact branch name check just because it starts with the same string.
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    headBranchName: "release-svp--branches-main--api",
                    labels: [],
                }
            });

            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });

        it("prefixes the release tag with the given component prefix", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    headBranchName: "release-svp--branches-main--api",
                    labels: [],
                }
            });

            const result = await determineReleases(github, "main", { ...options, releaseBranchName: "release-svp--branches-main--api", tagPrefix: "api-" });
            expect(result).toEqual([{ ...expectedRelease, tag: "api-v0.1.0" }]);
        });

        it("ignores pull requests that have been released", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    sha: "release",
                }
            });
            vi.spyOn(logger, "debug");

            const result = await determineReleases(github, "main", options);

            expect(logger.debug).toHaveBeenCalledWith("Skipping already released pull request #1");
            expect(result.length).toBe(0);
        });

        it("ignores pull requests with invalid release notes", async () => {
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield {
                    ...defaultPullRequest,
                    body: "some body without version number",
                }
            });
            vi.spyOn(logger, "warn");

            const result = await determineReleases(github, "main", options);

            expect(logger.warn).toHaveBeenCalledWith("Unable to parse the body for pull request #1");
            expect(result.length).toBe(0);
        });
    });

    describe("scanning for this component's own tags in a monorepo's repo-wide tag history", () => {
        // Regression tests for the "100-tag cap" gap: in a monorepo, tags from every component interleave
        // (newest-first) in the repo-wide tag feed, so a fixed *total* tag count previously risked missing this
        // component's own recent tags entirely if other components released more often — see determineReleases.ts.

        it("keeps scanning past 100 repo-wide tags to find this component's own matching tag", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                // 150 unrelated tags (e.g. another component's releases) before this component's own tag appears.
                for (let i = 0; i < 150; i++) {
                    yield { sha: `other-${i}`, name: `other-v${i}.0.0`, committedDate: "" };
                }
                yield { sha: "released-a", name: "a-v1.0.0", committedDate: "" };
            });
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield { ...defaultPullRequest, sha: "released-a" };
            });

            const result = await determineReleases(github, "main", { ...options, tagPrefix: "a-" });

            // Recognized as already released only if the scan reached the 151st tag, beyond the old 100 cap.
            expect(result.length).toBe(0);
        });

        it("stops scanning and warns after the safety limit when no matching tag is found", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                for (let i = 0; i < 1500; i++) {
                    yield { sha: `other-${i}`, name: `other-v${i}.0.0`, committedDate: "" };
                }
            });
            vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {
                yield { ...defaultPullRequest, sha: "unreleased" };
            });
            vi.spyOn(logger, "warn");

            const result = await determineReleases(github, "main", { ...options, tagPrefix: "a-" });

            expect(logger.warn).toHaveBeenCalledWith("⚠️ Scanned 1000 tags without finding 10 releases for tag prefix 'a-', stopping");
            expect(result).toEqual([{ ...expectedRelease, sha: "unreleased", tag: "a-v0.1.0" }]);
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
}
