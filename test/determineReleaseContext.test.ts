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

    describe("with a migration in progress", () => {
        const cutoverCommit = createMergeCommit(4, "Add release-svp-config.json", ["release-svp-config.json"]);
        const legacyCommit = createCommit("Old, pre-migration commit");
        const postCutoverACommit = createMergeCommit(5, "Add a-feature after migration", ["a/lib.rs"]);
        const postCutoverBCommit = createMergeCommit(6, "Add b-feature after migration", ["b/lib.rs"]);

        it("falls back to the legacy anchor tag when the component has no scoped tag of its own yet", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                // No "a-"-prefixed tag exists yet — only the pre-migration, unscoped tag.
                yield { sha: legacyCommit.sha, name: "v1.4.0", committedDate: "" };
            });
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield postCutoverACommit;
                yield cutoverCommit;
                yield legacyCommit;
            });

            const result = await determineReleaseContext(github, "main", "a-", "a", ["a", "b"], {
                cutoverCommit: cutoverCommit.sha,
                legacyAnchorTagName: "v1.4.0",
            });

            expect(result.previousRelease).toEqual(Version.parse("1.4.0"));
            // The cutover commit itself (and anything at/before it) is excluded, even though it's "after" the
            // legacy anchor tag — it predates the component concept entirely.
            expect(result.unreleasedCommits).toEqual([postCutoverACommit]);
        });

        it("prefers a component's own scoped tag over the legacy anchor tag once one exists, without spuriously warning about the (now out-of-range) cutover commit", async () => {
            vi.spyOn(logger, "warn");
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {
                yield { sha: postCutoverACommit.sha, name: "a-v1.5.0", committedDate: "" };
                yield { sha: legacyCommit.sha, name: "v1.4.0", committedDate: "" };
            });
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield postCutoverACommit;
                yield cutoverCommit;
                yield legacyCommit;
            });

            const result = await determineReleaseContext(github, "main", "a-", "a", ["a", "b"], {
                cutoverCommit: cutoverCommit.sha,
                legacyAnchorTagName: "v1.4.0",
            });

            expect(result.previousRelease).toEqual(Version.parse("1.5.0"));
            expect(result.unreleasedCommits).toEqual([]);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("uses the bootstrap version and truncates at the cutover commit for a component with no legacy history", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {});
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield postCutoverBCommit;
                yield cutoverCommit;
                yield legacyCommit;
            });

            const result = await determineReleaseContext(github, "main", "b-", "b", ["a", "b"], {
                cutoverCommit: cutoverCommit.sha,
                bootstrapVersion: Version.parse("0.1.0"),
            });

            expect(result.previousRelease).toEqual(Version.parse("0.1.0"));
            expect(result.unreleasedCommits).toEqual([postCutoverBCommit]);
        });

        it("throws MigrationCutoverNotFoundError when the cutover commit isn't found in recent history", async () => {
            vi.spyOn(github, "tagIterator").mockImplementation(async function* (): AsyncGenerator<Tag> {});
            vi.spyOn(github, "mergeCommitIterator").mockImplementation(async function* () {
                yield postCutoverBCommit;
            });

            await expect(determineReleaseContext(github, "main", "b-", "b", ["a", "b"], {
                cutoverCommit: "does-not-exist",
                bootstrapVersion: Version.parse("0.1.0"),
            })).rejects.toThrow(
                "Migration cutover commit 'does-not-exist' not found in recent commits, refusing to release without it (check 'migration.cutoverCommit' in release-svp-config.json)",
            );
        });
    });
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
