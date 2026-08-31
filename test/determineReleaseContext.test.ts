import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { Commit } from "../src/commit";
import { determineReleaseContext } from "../src/determineReleaseContext";
import { Github } from "../src/github";
import { logger } from "../src/logger";
import { Tag } from "../src/tag";
import { Version } from "../src/version";

describe("determineReleaseContext", () => {
    const github = new Github({ repo: "repo", owner: "owner" }, "token", logger);

    const featureCommit = createCommit("Add a new feature");
    const previousReleaseCommit = createMergeCommit(1, "Fix a bug");
    const fixCommit = createCommit("Fix a bug");
    const initialCommit = createCommit("Initial commit");

    describe("without tags", () => {
        it("returns an unreleased version and all commits", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {});
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield fixCommit;
                yield initialCommit;
            });

            const result = await determineReleaseContext(github, "main");
            expect(result.previousRelease).toEqual(Version.unreleased);
            expect(result.unreleasedCommits).toEqual([fixCommit, initialCommit]);
        });
    });

    describe("with a previous release tag", () => {
        it("returns the previous release version and unreleased commits", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                yield { sha: "", name: "ignored-tag", committedDate: "" }
                yield { sha: previousReleaseCommit.sha, name: "0.1.0", committedDate: "" }
            });
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield featureCommit;
                yield previousReleaseCommit;
                yield initialCommit;
            });

            const result = await determineReleaseContext(github, "main");
            expect(result.previousRelease).toEqual(Version.parse("0.1.0"));
            expect(result.unreleasedCommits).toEqual([featureCommit]);
        });
    });

    describe("with tags for multiple components", () => {
        it("only considers tags matching the given component prefix", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                // "web-v0.2.0" belongs to another component and is on top of the commit that "api" released;
                // it must be ignored when resolving "api"'s previous release.
                yield { sha: featureCommit.sha, name: "web-v0.2.0", committedDate: "" }
                yield { sha: previousReleaseCommit.sha, name: "api-v0.1.0", committedDate: "" }
            });
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield featureCommit;
                yield previousReleaseCommit;
                yield initialCommit;
            });

            const result = await determineReleaseContext(github, "main", "api-");
            expect(result.previousRelease).toEqual(Version.parse("0.1.0"));
            expect(result.unreleasedCommits).toEqual([featureCommit]);
        });
    });

    describe("with path-based component filtering", () => {
        const componentACommit = createMergeCommit(2, "Add a-feature", ["a/lib.rs"]);
        const componentBCommit = createMergeCommit(3, "Add b-feature", ["b/lib.rs"]);
        // A commit with no associated pull request (e.g. a direct push) has no changed-file data available at
        // all; it must only ever be attributed to the root component (see componentPathFilter.ts).
        const noPullRequestCommit = createCommit("Direct push");

        it("only returns commits owned by the given component path", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {});
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield componentACommit;
                yield componentBCommit;
                yield noPullRequestCommit;
            });

            const result = await determineReleaseContext(github, "main", "a-", "a", ["a", "b"]);
            expect(result.unreleasedCommits).toEqual([componentACommit]);
        });

        it("attributes commits with no changed-file data only to the root component", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {});
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield componentACommit;
                yield componentBCommit;
                yield noPullRequestCommit;
            });

            const result = await determineReleaseContext(github, "main", "", "", ["a", "b"]);
            expect(result.unreleasedCommits).toEqual([noPullRequestCommit]);
        });

        it("finds the tag anchor from the full unfiltered history before filtering unreleased commits", async () => {
            // The tagged commit belongs to component "b", not "a" — but "a"'s own tag must still be found
            // correctly against the unfiltered stream, and only "a"'s commits should end up unreleased.
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                yield { sha: componentBCommit.sha, name: "a-v0.1.0", committedDate: "" };
            });
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield componentACommit;
                yield componentBCommit;
            });

            const result = await determineReleaseContext(github, "main", "a-", "a", ["a", "b"]);
            expect(result.previousRelease).toEqual(Version.parse("0.1.0"));
            expect(result.unreleasedCommits).toEqual([componentACommit]);
        });
    });

    describe("with a previous release tag not on the default branch", () => {
        it("returns an unreleased version and all commits", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                yield { sha: "", name: "ignored-tag", committedDate: "" }
                yield { sha: "", name: "0.1.0", committedDate: "" }
            });
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield featureCommit;
                // Will not yield previousReleaseCommit; as mergeCommitIterator will not return this commit as it's on another branch
                yield initialCommit;
            });

            const result = await determineReleaseContext(github, "main");
            expect(result.previousRelease).toEqual(Version.unreleased);
            expect(result.unreleasedCommits).toEqual([featureCommit, initialCommit]);
        });
    })
});

function createCommit(message: string): Commit {
    return {
        sha: createHash("sha1").update(message).digest("hex"),
        message,
        isMergeCommit: false,
    };
}

function createMergeCommit(pullRequestNumber: number, message: string, changedFilePaths?: string[]): Commit {
    const commit = createCommit(message);
    return {
        ...commit,
        isMergeCommit: true,
        pullRequest: {
            sha: commit.sha,
            number: pullRequestNumber,
            title: `Pull request #${pullRequestNumber}`,
            body: message,
            permalink: "permalink",
            headBranchName: "",
            baseBranchName: "",
            mergeCommitOid: "",
            labels: [],
            changedFilePaths,
        }
    }
}
