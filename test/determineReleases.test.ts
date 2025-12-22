import { describe, expect, test, vi } from "vitest";
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
        releaseBranchPrefix: "release-svp--branches-",
        labelPending: "autorelease: pending",
    };

    vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
        yield { sha: "", name: "ignored-tag", committedDate: "" }
        yield { sha: "release", name: "0.1.0", committedDate: "" }
    });

    describe("with no merged pull requests", () => {
        vi.spyOn(github, "pullRequestIterator").mockImplementation(async function* () {});

        test("returns no releases", async () => {
            const result = await determineReleases(github, "main", options);
            expect(result.length).toBe(0);
        });
    });

    describe("with merged pull requests", () => {
        test("returns a release if the head branch name prefix matches", async () => {
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

        test("returns a release if the label matches", async () => {
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

        test("ignores pull requests that do not match the branch name prefix or labels", async () => {
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

        test("ignores pull requests that have been released", async () => {
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

        test("ignores pull requests with invalid release notes", async () => {
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
});

const defaultPullRequest: PullRequest = {
    sha: "sha",
    number: 1,
    title: "Title",
    body: createPullRequestBody("## v0.1.0\n\n- Release notes"),
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
