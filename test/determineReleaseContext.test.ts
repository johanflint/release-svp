import { describe, expect, test, vi } from "vitest";
import { Commit } from "../src/commit";
import { determineReleaseContext } from "../src/determineReleaseContext";
import { Github } from "../src/github";
import { logger } from "../src/logger";
import { Tag } from "../src/tag";
import { Version } from "../src/version";
import { createHash } from "crypto";

describe("determineReleaseContext", () => {
    const github = new Github({ repo: "repo", owner: "owner" }, "token", logger);

    const featureCommit = createCommit("Add a new feature");
    const previousReleaseCommit = createMergeCommit(1, "Fix a bug");
    const fixCommit = createCommit("Fix a bug");
    const initialCommit = createCommit("Initial commit");

    describe("without tags", () => {
        test("returns an unreleased version and all commits", async () => {
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
        test("returns the previous release version and unreleased commits", async () => {
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

    describe("with a previous release tag not on the default branch", () => {
        test("returns an unreleased version and all commits", async () => {
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

function createMergeCommit(pullRequestNumber: number, message: string): Commit {
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
        }
    }
}
