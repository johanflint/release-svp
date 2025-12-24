import { describe, expect, it } from "vitest";
import { Commit } from "../../src/commit";
import { SemanticVersioningStrategy } from "../../src/versioningStrategies/semantic";
import { MajorVersionUpdate, MinorVersionUpdate, PatchVersionUpdate } from "../../src/versioningStrategy";

describe("SemanticVersioningStrategy", () => {
    describe("with a breaking change", () => {
        const commits: Commit[] = [{
                sha: "sha0",
                message: "",
                isMergeCommit: false,
            }, {
                sha: "sha1",
                message: "Message",
                isMergeCommit: true,
                pullRequest: {
                    sha: "sha1",
                    number: 42,
                    title: "PR",
                    body: "",
                    permalink: "",
                    headBranchName: "",
                    baseBranchName: "",
                    mergeCommitOid: undefined,
                    labels: ["feature!"]
                }
            }];

        it("returns the major version update", async () => {
            const strategy = new SemanticVersioningStrategy();
            expect(strategy.releaseType(commits)).toBeInstanceOf(MajorVersionUpdate);
        });
    });

    describe("with a minor change", () => {
        const commits: Commit[] = [{
            sha: "sha1",
            message: "Message",
            isMergeCommit: true,
            pullRequest: {
                sha: "sha1",
                number: 42,
                title: "PR",
                body: "",
                permalink: "",
                headBranchName: "",
                baseBranchName: "",
                mergeCommitOid: undefined,
                labels: ["feature"]
            }
        }];

        it("returns the minor version update", async () => {
            const strategy = new SemanticVersioningStrategy();
            expect(strategy.releaseType(commits)).toBeInstanceOf(MinorVersionUpdate);
        });
    });

    describe("with a patch change", () => {
        const commits: Commit[] = [{
            sha: "sha1",
            message: "Message",
            isMergeCommit: true,
            pullRequest: {
                sha: "sha1",
                number: 42,
                title: "PR",
                body: "",
                permalink: "",
                headBranchName: "",
                baseBranchName: "",
                mergeCommitOid: undefined,
                labels: ["fix"]
            }
        }];

        it("returns the patch version update", async () => {
            const strategy = new SemanticVersioningStrategy();
            expect(strategy.releaseType(commits)).toBeInstanceOf(PatchVersionUpdate);
        });
    });
});
