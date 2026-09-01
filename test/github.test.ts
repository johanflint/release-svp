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
        });

        it("follows pagination and merges all changed file paths when a pull request has more files than fit on one page", async () => {
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number !== undefined) {
                    // Follow-up single-PR files query.
                    expect(parameters.cursor).toBe("cursor-page-1");
                    return {
                        repository: {
                            pullRequest: {
                                files: {
                                    nodes: [{ path: "a/something/src/main.rs" }],
                                    pageInfo: { hasNextPage: false, endCursor: undefined },
                                },
                            },
                        },
                    };
                }

                return {
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
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                        },
                                    }],
                                    pageInfo: { hasNextPage: false, endCursor: undefined },
                                },
                            },
                        },
                    },
                };
            });

            const logger = createLogger();
            const github = new Github({ owner: "owner", repo: "repo" }, "token", logger);
            const commits = [];
            for await (const commit of github.mergeCommitIterator("main")) {
                commits.push(commit);
            }

            expect(commits[0].pullRequest?.changedFilePaths).toEqual(["a/something/Cargo.toml", "a/something/src/main.rs"]);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("rejects when follow-up pagination fails", async () => {
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number !== undefined) {
                    throw new Error("boom");
                }

                return {
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
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                        },
                                    }],
                                    pageInfo: { hasNextPage: false, endCursor: undefined },
                                },
                            },
                        },
                    },
                };
            });

            const logger = createLogger();
            const github = new Github({ owner: "owner", repo: "repo" }, "token", logger);
            const collect = async () => {
                const commits = [];
                for await (const commit of github.mergeCommitIterator("main")) {
                    commits.push(commit);
                }
                return commits;
            };

            await expect(collect()).rejects.toThrow("Failed to fetch all changed files for pull request #1");
        });

        it("rejects when follow-up pagination hits the safety limit", async () => {
            let pagesFetched = 0;
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number !== undefined) {
                    pagesFetched++;
                    return {
                        repository: {
                            pullRequest: {
                                files: {
                                    nodes: [{ path: `a/file-${pagesFetched}.rs` }],
                                    pageInfo: { hasNextPage: true, endCursor: `cursor-${pagesFetched}` },
                                },
                            },
                        },
                    };
                }

                return {
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
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                        },
                                    }],
                                    pageInfo: { hasNextPage: false, endCursor: undefined },
                                },
                            },
                        },
                    },
                };
            });

            const logger = createLogger();
            const github = new Github({ owner: "owner", repo: "repo" }, "token", logger);
            const collect = async () => {
                const commits = [];
                for await (const commit of github.mergeCommitIterator("main")) {
                    commits.push(commit);
                }
                return commits;
            };

            await expect(collect()).rejects.toThrow("giving up on pagination");
            expect(pagesFetched).toBe(50);
        });

        it("rejects when a later page reports hasNextPage without an endCursor to follow", async () => {
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number !== undefined) {
                    return {
                        repository: {
                            pullRequest: {
                                files: {
                                    nodes: [{ path: "a/more.rs" }],
                                    pageInfo: { hasNextPage: true, endCursor: undefined },
                                },
                            },
                        },
                    };
                }

                return {
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
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                        },
                                    }],
                                    pageInfo: { hasNextPage: false, endCursor: undefined },
                                },
                            },
                        },
                    },
                };
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const collect = async () => {
                const commits = [];
                for await (const commit of github.mergeCommitIterator("main")) {
                    commits.push(commit);
                }
                return commits;
            };

            await expect(collect()).rejects.toThrow("no pagination cursor was returned");
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
        });
    });
});
