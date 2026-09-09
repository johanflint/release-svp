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
                                            labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                            files: {
                                                nodes: [{ path: "a/something/Cargo.toml" }, { path: "a/something/src/lib.rs" }],
                                                pageInfo: { hasNextPage: false },
                                            },
                                        }],
                                        pageInfo: { hasNextPage: false, endCursor: undefined },
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
                                                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                                files: {
                                                    nodes: [{ path: "a/something/Cargo.toml" }],
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                            pageInfo: { hasNextPage: false, endCursor: undefined },
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

        it("bounds how many pull requests' follow-up file pagination runs concurrently", async () => {
            const inFlight = new Set<number>();
            let maxObservedInFlight = 0;
            const releasers = new Map<number, () => void>();

            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number === undefined) {
                    return {
                        repository: {
                            ref: {
                                target: {
                                    history: {
                                        nodes: [1, 2, 3].map(number => ({
                                            sha: `sha${number}`,
                                            message: `Merge PR #${number}`,
                                            associatedPullRequests: {
                                                nodes: [{
                                                    number,
                                                    title: "PR",
                                                    body: "body",
                                                    permalink: "permalink",
                                                    headRefName: "head",
                                                    baseRefName: "main",
                                                    mergeCommit: { oid: `sha${number}` },
                                                    labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                                    files: {
                                                        nodes: [{ path: `a/file-${number}.rs` }],
                                                        pageInfo: { hasNextPage: true, endCursor: `cursor-${number}` },
                                                    },
                                                }],
                                                pageInfo: { hasNextPage: false, endCursor: undefined },
                                            },
                                        })),
                                        pageInfo: { hasNextPage: false, endCursor: undefined },
                                    },
                                },
                            },
                        },
                    };
                }

                // Follow-up single-PR files query: gate on a manually-released promise so the test controls
                // exactly when each pull request's pagination "completes", to observe concurrency in between.
                inFlight.add(parameters.number);
                maxObservedInFlight = Math.max(maxObservedInFlight, inFlight.size);
                await new Promise<void>(resolve => releasers.set(parameters.number, resolve));
                inFlight.delete(parameters.number);

                return {
                    repository: {
                        pullRequest: {
                            files: {
                                nodes: [{ path: `a/file-${parameters.number}-more.rs` }],
                                pageInfo: { hasNextPage: false, endCursor: undefined },
                            },
                        },
                    },
                };
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const collectPromise = (async () => {
                const commits = [];
                for await (const commit of github.mergeCommitIterator("main")) {
                    commits.push(commit);
                }
                return commits;
            })();

            // Let the two allowed concurrent pagination calls start and queue the third.
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(inFlight.size).toBe(2);

            // Releasing one frees a slot for the third to start.
            releasers.get(1)!();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(inFlight.size).toBe(2);

            releasers.get(2)!();
            releasers.get(3)!();
            const commits = await collectPromise;

            expect(maxObservedInFlight).toBe(2);
            expect(commits.map(commit => commit.pullRequest?.changedFilePaths)).toEqual([
                ["a/file-1.rs", "a/file-1-more.rs"],
                ["a/file-2.rs", "a/file-2-more.rs"],
                ["a/file-3.rs", "a/file-3-more.rs"],
            ]);
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
                                                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                                files: {
                                                    nodes: [{ path: "a/something/Cargo.toml" }],
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                            pageInfo: { hasNextPage: false, endCursor: undefined },
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
                                                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                                files: {
                                                    nodes: [{ path: "a/something/Cargo.toml" }],
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                            pageInfo: { hasNextPage: false, endCursor: undefined },
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
                                                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                                files: {
                                                    nodes: [{ path: "a/something/Cargo.toml" }],
                                                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                                                },
                                            }],
                                            pageInfo: { hasNextPage: false, endCursor: undefined },
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

        it("fetches merge commits once and replays them across multiple iterations on the same branch", async () => {
            graphqlMock.mockResolvedValue({
                repository: {
                    ref: {
                        target: {
                            history: {
                                nodes: [{ sha: "sha0", message: "Merge PR #1", associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: undefined } } }],
                                pageInfo: { hasNextPage: false, endCursor: undefined },
                            },
                        },
                    },
                },
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const drain = async () => {
                const commits = [];
                for await (const commit of github.mergeCommitIterator("main")) {
                    commits.push(commit);
                }
                return commits;
            };

            const first = await drain();
            const second = await drain();

            expect(first).toEqual(second);
            expect(graphqlMock).toHaveBeenCalledTimes(1);
        });

        it("fetches merge commits separately per branch, never sharing one branch's cache with another's", async () => {
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => ({
                repository: {
                    ref: {
                        target: {
                            history: {
                                nodes: [{ sha: `sha-${parameters.targetBranch}`, message: "Merge PR #1", associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: undefined } } }],
                                pageInfo: { hasNextPage: false, endCursor: undefined },
                            },
                        },
                    },
                },
            }));

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const drain = async (branch: string) => {
                const commits = [];
                for await (const commit of github.mergeCommitIterator(branch)) {
                    commits.push(commit);
                }
                return commits;
            };

            const main = await drain("main");
            const develop = await drain("develop");

            expect(main[0].sha).toBe("sha-main");
            expect(develop[0].sha).toBe("sha-develop");
            expect(graphqlMock).toHaveBeenCalledTimes(2);
        });

        it("re-throws the same fetch failure on every later iteration instead of silently looking exhausted", async () => {
            graphqlMock.mockRejectedValue(new Error("boom"));

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const drain = async () => {
                const commits = [];
                for await (const commit of github.mergeCommitIterator("main")) {
                    commits.push(commit);
                }
                return commits;
            };

            await expect(drain()).rejects.toThrow("boom");
            // A component whose own commit walk happens to run after another component already hit this failure
            // must still see the same failure itself, never a silently-empty ("nothing unreleased") result.
            await expect(drain()).rejects.toThrow("boom");
            expect(graphqlMock).toHaveBeenCalledTimes(1);
        });

        it("follows pagination and merges all labels when a pull request has more labels than fit on one page", async () => {
            // Regression test: a release-relevant label (e.g. "autorelease: pending (1.2.3)") landing on the
            // second page must not be silently dropped just because the bulk query's first page of labels was full.
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number !== undefined) {
                    expect(parameters.cursor).toBe("label-cursor-page-1");
                    return {
                        repository: {
                            pullRequest: {
                                labels: {
                                    nodes: [{ name: "autorelease: pending (1.2.3)" }],
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
                                                labels: {
                                                    nodes: [{ name: "size/xl" }],
                                                    pageInfo: { hasNextPage: true, endCursor: "label-cursor-page-1" },
                                                },
                                                files: { nodes: [], pageInfo: { hasNextPage: false } },
                                            }],
                                            pageInfo: { hasNextPage: false, endCursor: undefined },
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

            expect(commits[0].pullRequest?.labels).toEqual(["size/xl", "autorelease: pending (1.2.3)"]);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("rejects when label follow-up pagination fails", async () => {
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
                                                labels: {
                                                    nodes: [{ name: "size/xl" }],
                                                    pageInfo: { hasNextPage: true, endCursor: "label-cursor-page-1" },
                                                },
                                                files: { nodes: [], pageInfo: { hasNextPage: false } },
                                            }],
                                            pageInfo: { hasNextPage: false, endCursor: undefined },
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

            await expect(collect()).rejects.toThrow("Failed to fetch all labels for pull request #1");
        });

        it("follows pagination and still finds the merge-matching pull request when it falls past the first page of associated pull requests", async () => {
            // Regression test for the bug this fix addresses: with a bare `associatedPullRequests(first: 10)`
            // query and no pagination, a commit whose real merge-matching pull request (mergeCommit.oid ===
            // commit.sha) fell outside the first page used to leave `mergePullRequest` undefined, silently
            // treating a genuine merge commit as if it weren't one at all — skipping its label-driven version
            // bump entirely, rather than reading wrong data.
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.sha !== undefined) {
                    expect(parameters.sha).toBe("sha0");
                    expect(parameters.cursor).toBe("associated-pr-cursor-page-1");
                    return {
                        repository: {
                            object: {
                                associatedPullRequests: {
                                    nodes: [{
                                        number: 2,
                                        title: "PR 2",
                                        body: "body 2",
                                        permalink: "permalink-2",
                                        headRefName: "head-2",
                                        baseRefName: "main",
                                        mergeCommit: { oid: "sha0" },
                                        labels: { nodes: [{ name: "feature" }], pageInfo: { hasNextPage: false } },
                                        files: { nodes: [], pageInfo: { hasNextPage: false } },
                                    }],
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
                                        message: "Merge PR #2",
                                        associatedPullRequests: {
                                            // Page 1: an unrelated pull request that just happens to reference this
                                            // commit (e.g. a backport/cherry-pick), NOT the one that merged it.
                                            nodes: [{
                                                number: 1,
                                                title: "PR 1",
                                                body: "body 1",
                                                permalink: "permalink-1",
                                                headRefName: "head-1",
                                                baseRefName: "main",
                                                mergeCommit: { oid: "some-other-sha" },
                                                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                                files: { nodes: [], pageInfo: { hasNextPage: false } },
                                            }],
                                            pageInfo: { hasNextPage: true, endCursor: "associated-pr-cursor-page-1" },
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

            expect(commits).toHaveLength(1);
            expect(commits[0].isMergeCommit).toBe(true);
            expect(commits[0].pullRequest?.number).toBe(2);
            expect(commits[0].pullRequest?.labels).toEqual(["feature"]);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("rejects when associated-pull-request follow-up pagination fails", async () => {
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.sha !== undefined) {
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
                                                mergeCommit: { oid: "some-other-sha" },
                                                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                                                files: { nodes: [], pageInfo: { hasNextPage: false } },
                                            }],
                                            pageInfo: { hasNextPage: true, endCursor: "associated-pr-cursor-page-1" },
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

            await expect(collect()).rejects.toThrow("Failed to fetch all associated pull requests for commit sha0");
        });
    });

    describe("#tagIterator", () => {
        it("fetches tags once and replays them across multiple iterations on the same instance", async () => {
            graphqlMock.mockResolvedValue({
                repository: {
                    refs: {
                        nodes: [
                            { name: "v1.0.0", target: { oid: "sha1", committedDate: "2024-01-01" } },
                            { name: "v0.9.0", target: { oid: "sha0", committedDate: "2023-01-01" } },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: undefined },
                    },
                },
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const drain = async () => {
                const tags = [];
                for await (const tag of github.tagIterator()) {
                    tags.push(tag);
                }
                return tags;
            };

            const first = await drain();
            const second = await drain();

            expect(first).toEqual(second);
            expect(first.map(tag => tag.name)).toEqual(["v1.0.0", "v0.9.0"]);
            expect(graphqlMock).toHaveBeenCalledTimes(1);
        });

        it("re-throws the same fetch failure on every later iteration instead of silently looking exhausted", async () => {
            graphqlMock.mockRejectedValue(new Error("boom"));

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const drain = async () => {
                const tags = [];
                for await (const tag of github.tagIterator()) {
                    tags.push(tag);
                }
                return tags;
            };

            await expect(drain()).rejects.toThrow("boom");
            await expect(drain()).rejects.toThrow("boom");
            expect(graphqlMock).toHaveBeenCalledTimes(1);
        });
    });

    describe("#pullRequestIterator", () => {
        it("never fetches or paginates changed files, even for a pull request that touched far more files than the safety cap allows", async () => {
            // Regression test for the bug this fix addresses: pullRequestIterator's callers (determineReleases,
            // Manifest.findExistingPullRequest, ManifestRunner's open-pull-request conflict check) only need
            // labels/body/merge-SHA/number, never changed-file paths — but the query used to fetch and
            // paginate every merged pull request's changed files anyway. Since release() scans every merged
            // pull request with no early exit, a single old, unrelated pull request with more changed files
            // than MAX_ADDITIONAL_CHANGED_FILE_PAGES allows used to throw PullRequestFilesIncompleteError and
            // block the entire scan. mergedPullRequests.graphql no longer requests `files` at all, so no
            // follow-up pull-request-files query should ever be made here, and the mapped result has no
            // changedFilePaths.
            graphqlMock.mockResolvedValue({
                repository: {
                    pullRequests: {
                        nodes: [{
                            number: 4,
                            title: "PR",
                            baseRefName: "main",
                            headRefName: "release-svp--branches-main",
                            labels: { nodes: [{ name: "autorelease: pending" }], pageInfo: { hasNextPage: false } },
                            body: "body",
                            permalink: "permalink",
                            mergeCommit: { oid: "sha0" },
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
            expect(pullRequests[0].changedFilePaths).toBeUndefined();
            // Only one graphql call made — the bulk pull-request query — never a follow-up per-PR files query.
            expect(graphqlMock).toHaveBeenCalledTimes(1);
        });

        it("stops yielding once maxResults is reached, even mid-page, and never fetches a further page", async () => {
            // Regression test: the generic paginate() helper used to only check maxResults *between* pages, so
            // a caller asking for (say) 2 results would still receive every item on a bigger first page, and —
            // had that page also reported hasNextPage: true — paginate() would have kept fetching pages it no
            // longer needed at all.
            graphqlMock.mockResolvedValue({
                repository: {
                    pullRequests: {
                        nodes: [1, 2, 3].map(number => ({
                            number,
                            title: "PR",
                            baseRefName: "main",
                            headRefName: "release-svp--branches-main",
                            labels: { nodes: [], pageInfo: { hasNextPage: false } },
                            body: "body",
                            permalink: "permalink",
                            mergeCommit: { oid: `sha${number}` },
                        })),
                        pageInfo: { endCursor: "cursor-page-1", hasNextPage: true },
                    },
                },
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const pullRequests = [];
            for await (const pullRequest of github.pullRequestIterator("main", "MERGED", 2)) {
                pullRequests.push(pullRequest);
            }

            expect(pullRequests.map(pr => pr.number)).toEqual([1, 2]);
            expect(graphqlMock).toHaveBeenCalledTimes(1);
        });

        it("throws when a page reports more results are available but no cursor to continue from", async () => {
            // Regression test: silently treating this as "no more pages" would under-report results, but
            // silently retrying would call fetchPage with the same (missing) cursor as the page that just
            // produced this response — re-fetching and re-yielding that same page's items forever, since
            // nothing here bounds the number of pages fetched.
            graphqlMock.mockResolvedValue({
                repository: {
                    pullRequests: {
                        nodes: [{
                            number: 1,
                            title: "PR",
                            baseRefName: "main",
                            headRefName: "release-svp--branches-main",
                            labels: { nodes: [], pageInfo: { hasNextPage: false } },
                            body: "body",
                            permalink: "permalink",
                            mergeCommit: { oid: "sha1" },
                        }],
                        pageInfo: { endCursor: undefined, hasNextPage: true },
                    },
                },
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const collect = async () => {
                const pullRequests = [];
                for await (const pullRequest of github.pullRequestIterator("main", "MERGED")) {
                    pullRequests.push(pullRequest);
                }
                return pullRequests;
            };

            await expect(collect()).rejects.toThrow("Server reported more pages are available (hasNextPage: true) but returned no cursor to continue from");
        });

        it("follows pagination and merges all labels when a pull request has more labels than fit on one page", async () => {
            // Regression test for the bug this fix addresses: with a bare `labels(first: 10)` query and no
            // pagination, a release-relevant label on the second page (here "autorelease: pending (1.2.3)") used
            // to be silently dropped, which could misclassify or entirely hide a component's pending release PR.
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number !== undefined) {
                    expect(parameters.cursor).toBe("label-cursor-page-1");
                    return {
                        repository: {
                            pullRequest: {
                                labels: {
                                    nodes: [{ name: "autorelease: pending (1.2.3)" }],
                                    pageInfo: { hasNextPage: false, endCursor: undefined },
                                },
                            },
                        },
                    };
                }

                return {
                    repository: {
                        pullRequests: {
                            nodes: [{
                                number: 4,
                                title: "PR",
                                baseRefName: "main",
                                headRefName: "release-svp--branches-main",
                                labels: {
                                    nodes: [{ name: "size/xl" }],
                                    pageInfo: { hasNextPage: true, endCursor: "label-cursor-page-1" },
                                },
                                body: "body",
                                permalink: "permalink",
                                mergeCommit: { oid: "sha0" },
                            }],
                            pageInfo: { endCursor: undefined, hasNextPage: false },
                        },
                    },
                };
            });

            const logger = createLogger();
            const github = new Github({ owner: "owner", repo: "repo" }, "token", logger);
            const pullRequests = [];
            for await (const pullRequest of github.pullRequestIterator("main", "MERGED")) {
                pullRequests.push(pullRequest);
            }

            expect(pullRequests).toHaveLength(1);
            expect(pullRequests[0].labels).toEqual(["size/xl", "autorelease: pending (1.2.3)"]);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("rejects when a pull request's label pagination hits the safety limit", async () => {
            let pagesFetched = 0;
            graphqlMock.mockImplementation(async (_query: string, parameters: any) => {
                if (parameters.number !== undefined) {
                    pagesFetched++;
                    return {
                        repository: {
                            pullRequest: {
                                labels: {
                                    nodes: [{ name: `label-${pagesFetched}` }],
                                    pageInfo: { hasNextPage: true, endCursor: `label-cursor-${pagesFetched}` },
                                },
                            },
                        },
                    };
                }

                return {
                    repository: {
                        pullRequests: {
                            nodes: [{
                                number: 4,
                                title: "PR",
                                baseRefName: "main",
                                headRefName: "release-svp--branches-main",
                                labels: {
                                    nodes: [{ name: "size/xl" }],
                                    pageInfo: { hasNextPage: true, endCursor: "label-cursor-page-1" },
                                },
                                body: "body",
                                permalink: "permalink",
                                mergeCommit: { oid: "sha0" },
                            }],
                            pageInfo: { endCursor: undefined, hasNextPage: false },
                        },
                    },
                };
            });

            const github = new Github({ owner: "owner", repo: "repo" }, "token", createLogger());
            const collect = async () => {
                const pullRequests = [];
                for await (const pullRequest of github.pullRequestIterator("main", "MERGED")) {
                    pullRequests.push(pullRequest);
                }
                return pullRequests;
            };

            await expect(collect()).rejects.toThrow("giving up on pagination");
            expect(pagesFetched).toBe(20);
        });
    });
});

