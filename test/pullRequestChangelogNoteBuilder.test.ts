import { describe, expect, it } from "vitest";
import { Commit } from "../src/commit";
import { PullRequestChangelogNoteBuilder } from "../src/pullRequestChangelogNoteBuilder";

describe("PullRequestChangelogNoteBuilder", () => {
    describe("buildNote", () => {
        const noteBuilder = new PullRequestChangelogNoteBuilder();

        it("returns null if the commit has no pull request", () => {
            const commit: Commit = {
                sha: "sha",
                message: "Message",
                isMergeCommit: false
            };

            const result = noteBuilder.buildNote(commit, [], "default");
            expect(result).toBe(null);
        });

        it("returns null if the commit's pull request sha is not equal to the merge commit id", () => {
            const result = noteBuilder.buildNote(commit(undefined, "mergeCommitId"), [], "default");
            expect(result).toBe(null);
        });

        it("returns an entry with the first matching label set as type", () => {
            const result = noteBuilder.buildNote(commit("beautification"), ["beautification"], "default");
            expect(result).toEqual({
                "type": "beautification",
                "note": "Commit message",
            });
        });

        it("returns an entry with the default section if no label matches", () => {
            const result = noteBuilder.buildNote(commit("beautification"), ["other"], "default");
            expect(result).toEqual({
                "type": "default",
                "note": "Commit message",
            });
        });

        it("returns an entry with a pull request reference", () => {
            const commitWithReference: Commit = {...commit(undefined), message: "Release v0.1.1 (#7)" };
            const result = noteBuilder.buildNote(commitWithReference, ["other"], "default");
            expect(result).toEqual({
                "type": "default",
                "note": "Release v0.1.1 ([#7](permalink/7))",
            });
        });
    });
});

function commit(label: string | undefined, mergeCommitOid: string = "sha"): Commit {
    return {
        sha: "sha",
        message: "Commit message",
        isMergeCommit: true,
        pullRequest: {
            sha: "sha",
            number: 7,
            title: "My pull request",
            body: "Description",
            permalink: "permalink/7",
            headBranchName: "my-branch",
            baseBranchName: "main",
            mergeCommitOid,
            labels: label ? [label] : []
        }
    };
}

