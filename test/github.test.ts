import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../src/logger";

const graphqlMock = vi.fn();

vi.mock("octokit", async () => {
    const actual = await vi.importActual<typeof import("octokit")>("octokit");
    return {
        ...actual,
        Octokit: vi.fn().mockImplementation(function (this: any) {
            this.graphql = graphqlMock;
            this.rest = {};
        }),
    };
});

vi.mock("@octokit/rest", async () => {
    const actual = await vi.importActual<typeof import("@octokit/rest")>("@octokit/rest");
    return {
        ...actual,
        Octokit: vi.fn().mockImplementation(function (this: any) {}),
    };
});

// Imported after the mocks above so `Github` picks up the mocked Octokit constructors.
const { Github } = await import("../src/github");

function createLogger(): Logger {
    return {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    };
}

describe("Github", () => {
    beforeEach(() => {
        graphqlMock.mockReset();
    });

    describe("#mergeCommitIterator", () => {
        it("maps changed file paths and marks them as not truncated when all files fit on one page", async () => {
            graphqlMock.mockResolvedValue({
                repository: {
                    ref: {
                        target: {
                            history: {
                                nodes: [{
                                    sha: "sha0",
                                    message: "Merge PR #1",
                                    associatedPullRequests: {
                                        nodes: [{
                                            number: 1,
                                            title: "PR",
                                            body: "body",
                                            permalink: "permalink",
                                            headRefName: "head",
                                            baseRefName: "main",
                                            mergeCommit: { oid: "sha0" },
                                            labels: { nodes: [] },
                                            files: {
                                                nodes: [{ path: "a/something/Cargo.toml" }, { path: "a/something/src/lib.rs" }],
                                                pageInfo: { hasNextPage: false },
                                            },
                                        }],
                                    },
                                }],
                                pageInfo: { hasNextPage: false, endCursor: undefined },
                            },
                        },
                    },
                },
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const commits = [];
            for await (const commit of github.mergeCommitIterator("main")) {
                commits.push(commit);
            }

            expect(commits).toHaveLength(1);
            expect(commits[0].pullRequest?.changedFilePaths).toEqual(["a/something/Cargo.toml", "a/something/src/lib.rs"]);
            expect(commits[0].pullRequest?.changedFilePathsTruncated).toBe(false);
        });

        it("marks changed file paths as truncated and warns when the pull request has more files than fit on one page", async () => {
            graphqlMock.mockResolvedValue({
                repository: {
                    ref: {
                        target: {
                            history: {
                                nodes: [{
                                    sha: "sha0",
                                    message: "Merge PR #1",
                                    associatedPullRequests: {
                                        nodes: [{
                                            number: 1,
                                            title: "PR",
                                            body: "body",
                                            permalink: "permalink",
                                            headRefName: "head",
                                            baseRefName: "main",
                                            mergeCommit: { oid: "sha0" },
                                            labels: { nodes: [] },
                                            files: {
                                                nodes: [{ path: "a/something/Cargo.toml" }],
                                                pageInfo: { hasNextPage: true },
                                            },
                                        }],
                                    },
                                }],
                                pageInfo: { hasNextPage: false, endCursor: undefined },
                            },
                        },
                    },
                },
            });

            const logger = createLogger();
            const github = new Github({ owner: "owner", repo: "repo" }, "token", logger);
            const commits = [];
            for await (const commit of github.mergeCommitIterator("main")) {
                commits.push(commit);
            }

            expect(commits[0].pullRequest?.changedFilePathsTruncated).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(
                "Pull request #1 has more than 1 changed files, path-based component filtering may be incomplete"
            );
        });
    });

    describe("#pullRequestIterator", () => {
        it("maps changed file paths from merged pull requests", async () => {
            graphqlMock.mockResolvedValue({
                repository: {
                    pullRequests: {
                        nodes: [{
                            number: 4,
                            title: "PR",
                            baseRefName: "main",
                            headRefName: "release-svp--branches-main",
                            labels: { nodes: [{ name: "autorelease: pending" }] },
                            body: "body",
                            permalink: "permalink",
                            mergeCommit: { oid: "sha0" },
                            files: {
                                nodes: [{ path: "b/Cargo.toml" }],
                                pageInfo: { hasNextPage: false },
                            },
                        }],
                        pageInfo: { endCursor: undefined, hasNextPage: false },
                    },
                },
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const pullRequests = [];
            for await (const pullRequest of github.pullRequestIterator("main", "MERGED")) {
                pullRequests.push(pullRequest);
            }

            expect(pullRequests).toHaveLength(1);
            expect(pullRequests[0].changedFilePaths).toEqual(["b/Cargo.toml"]);
            expect(pullRequests[0].changedFilePathsTruncated).toBe(false);
        });
    });
});
