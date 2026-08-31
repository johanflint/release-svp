import init from "@rainbowatcher/toml-edit-js";
import { RequestError } from "octokit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChangelog } from "../src/changelogBuilder";
import { PullRequest } from "../src/commit";
import { determineReleaseContext } from "../src/determineReleaseContext";
import { determineReleases } from "../src/determineReleases";
import { DuplicateReleaseError, Github } from "../src/github";
import { logger } from "../src/logger";
import { Manifest } from "../src/manifest";
import { createPullRequestBody } from "../src/pullRequestBody";
import { Release } from "../src/release";
import { UpdateOptions } from "../src/strategy";
import { buildStrategy } from "../src/strategyFactory";
import { Update } from "../src/update";
import { Version } from "../src/version";

vi.mock("@rainbowatcher/toml-edit-js", () => ({
    default: vi.fn(),
}));

vi.mock("../src/github", async () => {
    const actual = await vi.importActual("../src/github");
    return {
        ...actual,
        Github: vi.fn(),
    };
});

vi.mock("../src/determineReleaseContext", () => {
    return {
        determineReleaseContext: vi.fn(),
    };
});

vi.mock("../src/changelogBuilder", () => {
    return {
        buildChangelog: vi.fn(),
    };
});

vi.mock("../src/strategyFactory", () => {
    return {
        buildStrategy: vi.fn(),
    };
});

vi.mock("../src/determineReleases", () => {
    return {
        determineReleases: vi.fn(),
    }
});

describe("Manifest", () => {
    const token = "token";

    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(init);
    });

    describe("#create", () => {
        it("creates a manifest, initializes TOML and creates a Github client", async () => {
            const githubMock = createGithubMock();

            const result = await Manifest.create("owner/repo", token);
            expect(result).toBeInstanceOf(Manifest);
            expect(init).toHaveBeenCalled();
            expect(Github).toHaveBeenCalledExactlyOnceWith(
                { owner: "owner", repo: "repo" },
                token,
                logger,
            );
            expect(githubMock.retrieveDefaultBranch).toHaveBeenCalledOnce();
        });

        it("returns null and logs an error for an invalid repository url", async () => {
            vi.spyOn(logger, "error");
            const result = await Manifest.create("invalid", token, logger);

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledExactlyOnceWith("Invalid GitHub repository url 'invalid', expected 'repository/owner' format");
            expect(init).not.toHaveBeenCalled();
        });

        it("propagates errors from retrieveDefaultBranch", async () => {
            vi.mocked(init);
            createGithubMock({
                retrieveDefaultBranch: vi.fn().mockRejectedValue(new Error("boom"))
            });

            await expect(
                Manifest.create("owner/repo", token, logger)
            ).rejects.toThrow("boom");
        });
    });

    describe("#prepare", () => {
        const pullRequest: PullRequest = {
            number: 2,
            title: "PR",
            body: "body",
            permalink: "permalink",
            headBranchName: "headBranchName",
            baseBranchName: "baseBranchName",
            labels: []
        };

        describe("with no unreleased commits", () => {
            it("returns with a log message", async () => {
                const githubMock = createGithubMock();

                vi.spyOn(logger, "info");
                vi.mocked(determineReleaseContext).mockResolvedValue({
                    previousRelease: Version.parse("1.2.3"),
                    unreleasedCommits: [],
                });

                const result = await Manifest.create("owner/repo", token);
                expect(result).not.toBeNull();

                await result!.prepare("rust");

                expect(determineReleaseContext).toHaveBeenCalledOnce();
                expect(logger.info).toHaveBeenCalledWith(`No unreleased commits, nothing to do 🕸️`);
                expect(buildChangelog).not.toHaveBeenCalled();
                expect(githubMock.updatePullRequest).not.toHaveBeenCalled();
                expect(githubMock.createPullRequest).not.toHaveBeenCalled();
            });
        });

        describe("with no existing pull request", () => {
            it("builds the new changelog, strategy and opens a pull request", async () => {
                const githubMock = createGithubMock({
                    pullRequestIterator: (async function* () {
                        yield pullRequest;
                    }),
                    createPullRequest: vi.fn().mockResolvedValue(pullRequest),
                });

                vi.mocked(determineReleaseContext).mockResolvedValue({
                    previousRelease: Version.parse("1.2.3"),
                    unreleasedCommits: [{
                        sha: "sha0",
                        message: "New commit",
                        isMergeCommit: false,
                    }],
                });
                vi.mocked(buildStrategy).mockReturnValue({
                    config: { github: new Github({ owner: "owner", repo: "repo" }, token, logger) },
                    async determineUpdates(_options: UpdateOptions): Promise<Update[]> {
                        return [];
                    }
                });

                const result = await Manifest.create("owner/repo", token);
                expect(result).not.toBeNull();

                await result!.prepare("rust");

                expect(buildChangelog).toHaveBeenCalled();
                expect(buildStrategy).toHaveBeenCalledWith("rust", expect.anything());
                expect(githubMock.createPullRequest).toHaveBeenCalledWith(
                    expectReleasePullRequest({ body: expect.anything() }),
                    "Release v1.2.4",
                    expect.anything()
                );
                expect(githubMock.updatePullRequest).not.toHaveBeenCalled();
            });
        });

        describe("with an existing pull request", () => {
            it("builds the new changelog, strategy and updates the existing pull request", async () => {
                const existingPullRequest: PullRequest = {
                    ...pullRequest,
                    headBranchName: "release-svp--branches-main",
                    labels: ["autorelease: pending"],
                };

                const githubMock = createGithubMock({
                    pullRequestIterator: (async function* () {
                        yield existingPullRequest;
                    }),
                    updatePullRequest: vi.fn().mockResolvedValue(existingPullRequest),
                });

                vi.mocked(determineReleaseContext).mockResolvedValue({
                    previousRelease: Version.parse("1.2.3"),
                    unreleasedCommits: [{
                        sha: "sha0",
                        message: "New commit",
                        isMergeCommit: false,
                    }],
                });
                const determineUpdatesMock = vi.fn().mockResolvedValue([]);
                vi.mocked(buildStrategy).mockReturnValue({
                    config: { github: new Github({ owner: "owner", repo: "repo" }, token, logger) },
                    determineUpdates: determineUpdatesMock,
                });


                const result = await Manifest.create("owner/repo", token);
                expect(result).not.toBeNull();

                await result!.prepare("rust");

                expect(buildChangelog).toHaveBeenCalled();
                expect(buildStrategy).toHaveBeenCalledWith("rust", expect.anything());
                expect(determineUpdatesMock).toHaveBeenCalledWith({
                    changelog: undefined,
                    releaseVersion: Version.parse("1.2.4"),
                    targetBranch: "main",
                });
                expect(githubMock.createPullRequest).not.toHaveBeenCalled();
                expect(githubMock.updatePullRequest).toHaveBeenCalledWith(
                    expectReleasePullRequest({ body: expect.anything() }),
                    "Release v1.2.4",
                    expect.anything()
                );
            });

            it("updates the correct existing pull request if there are multiple pull requests open", async () => {
                const ignoredPullRequest: PullRequest = {
                    ...pullRequest,
                    number: 3,
                    headBranchName: "release-svp--branches-main",
                    labels: [],
                };
                const existingPullRequest: PullRequest = {
                    ...pullRequest,
                    number: 4,
                    headBranchName: "release-svp--branches-main",
                    labels: ["autorelease: pending"],
                };

                const githubMock = createGithubMock({
                    pullRequestIterator: (async function* () {
                        yield ignoredPullRequest;
                        yield existingPullRequest;
                    }),
                    updatePullRequest: vi.fn().mockResolvedValue(existingPullRequest),
                });

                vi.spyOn(logger, "info");
                vi.mocked(determineReleaseContext).mockResolvedValue({
                    previousRelease: Version.parse("1.2.3"),
                    unreleasedCommits: [{
                        sha: "sha0",
                        message: "New commit",
                        isMergeCommit: false,
                    }],
                });
                vi.mocked(buildStrategy).mockReturnValue({
                    config: { github: new Github({ owner: "owner", repo: "repo" }, token, logger) },
                    async determineUpdates(_options: UpdateOptions): Promise<Update[]> {
                        return [];
                    }
                });

                const result = await Manifest.create("owner/repo", token);
                expect(result).not.toBeNull();

                await result!.prepare("rust");

                expect(buildChangelog).toHaveBeenCalled();
                expect(buildStrategy).toHaveBeenCalledWith("rust", expect.anything());
                expect(githubMock.createPullRequest).not.toHaveBeenCalled();
                expect(githubMock.updatePullRequest).toHaveBeenCalledWith(
                    expectReleasePullRequest({ body: expect.anything() }),
                    "Release v1.2.4",
                    expect.anything()
                );
                expect(logger.info).toHaveBeenCalledWith(`Updated pull request https://github.com/owner/repo/pull/4`);
            });

            it("does nothing if the new pull request is identical to the existing one", async () => {
                const existingPullRequest: PullRequest = {
                    ...pullRequest,
                    title: "Release v1.2.4",
                    body: createPullRequestBody(undefined),
                    headBranchName: "release-svp--branches-main",
                    labels: ["autorelease: pending"]
                };

                const githubMock = createGithubMock({
                    pullRequestIterator: (async function* () {
                        yield existingPullRequest;
                    }),
                    updatePullRequest: vi.fn().mockResolvedValue(existingPullRequest),
                });

                vi.spyOn(logger, "info");
                vi.mocked(determineReleaseContext).mockResolvedValue({
                    previousRelease: Version.parse("1.2.3"),
                    unreleasedCommits: [{
                        sha: "sha0",
                        message: "New commit",
                        isMergeCommit: false,
                    }],
                });
                vi.mocked(buildStrategy).mockReturnValue({
                    config: { github: new Github({ owner: "owner", repo: "repo" }, token, logger) },
                    async determineUpdates(_options: UpdateOptions): Promise<Update[]> {
                        return [];
                    }
                });

                const result = await Manifest.create("owner/repo", token);
                expect(result).not.toBeNull();

                await result!.prepare("rust");

                expect(logger.info).toHaveBeenCalledWith(`Done, pull request https://github.com/owner/repo/pull/2 remained the same`);
                expect(githubMock.createPullRequest).not.toHaveBeenCalled();
                expect(githubMock.updatePullRequest).not.toHaveBeenCalled();
            });

            it("does not update the pull request if it is missing the pending label", async () => {
                const existingPullRequest: PullRequest = {
                    ...pullRequest,
                    title: "Release v1.2.4",
                    body: createPullRequestBody(undefined),
                    headBranchName: "release-svp--branches-main",
                    labels: [] // No pending label
                };

                const githubMock = createGithubMock({
                    pullRequestIterator: (async function* () {
                        yield existingPullRequest;
                    }),
                    createPullRequest: vi.fn().mockResolvedValue(existingPullRequest),
                });

                vi.spyOn(logger, "info");
                vi.mocked(determineReleaseContext).mockResolvedValue({
                    previousRelease: Version.parse("1.2.3"),
                    unreleasedCommits: [{
                        sha: "sha0",
                        message: "New commit",
                        isMergeCommit: false,
                    }],
                });
                vi.mocked(buildStrategy).mockReturnValue({
                    config: { github: new Github({ owner: "owner", repo: "repo" }, token, logger) },
                    async determineUpdates(_options: UpdateOptions): Promise<Update[]> {
                        return [];
                    }
                });

                const result = await Manifest.create("owner/repo", token);
                expect(result).not.toBeNull();

                await result!.prepare("rust");

                expect(logger.info).toHaveBeenCalledWith(`Created pull request https://github.com/owner/repo/pull/2`);
                expect(githubMock.createPullRequest).toHaveBeenCalled();
                expect(githubMock.updatePullRequest).not.toHaveBeenCalled();
            });
        });
    });

    describe("#release", () => {
        const release: Release = {
            sha: "sha0",
            tag: "v1.2.4",
            notes: "notes",
            pullRequestNumber: 4,
        }

        it("does nothing if there is nothing to release", async () => {
            const githubMock = createGithubMock();
            vi.spyOn(logger, "info");

            vi.mocked(determineReleases).mockResolvedValue([]);

            const result = await Manifest.create("owner/repo", token);
            expect(result).not.toBeNull();

            await result!.release();

            expect(logger.info).toHaveBeenCalledWith(`Nothing to release 🐼`);
            expect(githubMock.createRelease).not.toHaveBeenCalled();
        });

        it("creates a release for every release", async () => {
            const githubMock = createGithubMock();

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const result = await Manifest.create("owner/repo", token);
            expect(result).not.toBeNull();

            await result!.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
        });

        it("creates a comment on every release", async () => {
            const githubMock = createGithubMock();

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const result = await Manifest.create("owner/repo", token);
            expect(result).not.toBeNull();

            await result!.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
            expect(githubMock.commentOnIssue).toHaveBeenCalledWith(":bowtie: Created release [v1.2.4](url) :tulip:", 4);
        });

        it("updates the labels on every release", async () => {
            const githubMock = createGithubMock();

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const result = await Manifest.create("owner/repo", token);
            expect(result).not.toBeNull();

            await result!.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
            expect(githubMock.removePullRequestLabels).toHaveBeenCalledWith(["autorelease: pending"], 4);
            expect(githubMock.addPullRequestLabels).toHaveBeenCalledWith(["autorelease: tagged"], 4);
        });

        it("logs a warning for duplicate release tags", async () => {
            const githubMock = createGithubMock();
            vi.spyOn(logger, "warn");

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockRejectedValue(new DuplicateReleaseError(new RequestError("", 400, {request: { method: "GET", url: "", headers: {}}}), "v1.2.4"));

            const result = await Manifest.create("owner/repo", token);
            expect(result).not.toBeNull();

            await result!.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
            expect(logger.warn).toHaveBeenCalledWith(`Duplicate release tag for v1.2.4`);
            expect(githubMock.commentOnIssue).not.toHaveBeenCalledWith(":bowtie: Created release [v1.2.4](url) :tulip:", 4);
        });

        it("throws unexpected exceptions", async () => {
            const githubMock = createGithubMock();
            vi.spyOn(logger, "warn");

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockRejectedValue(new Error("boom"));

            const result = await Manifest.create("owner/repo", token);
            expect(result).not.toBeNull();

            await expect(
                result!.release()
            ).rejects.toThrow("boom");
        });
    });

    describe("with a named component", () => {
        it("prepare() namespaces the tag prefix, branch name and label", async () => {
            const githubMock = createGithubMock({
                pullRequestIterator: (async function* () {}),
                createPullRequest: vi.fn().mockResolvedValue({ number: 5 }),
            });
            const github = new Github({ owner: "owner", repo: "repo" }, token, logger);

            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.2.3"),
                unreleasedCommits: [{
                    sha: "sha0",
                    message: "New commit",
                    isMergeCommit: false,
                }],
            });
            vi.mocked(buildStrategy).mockReturnValue({
                config: { github },
                async determineUpdates(_options: UpdateOptions): Promise<Update[]> {
                    return [];
                }
            });

            const manifest = Manifest.forComponent(github, { owner: "owner", repo: "repo" }, "main", "api");
            await manifest.prepare("rust");

            expect(determineReleaseContext).toHaveBeenCalledWith(expect.anything(), "main", "api-", "", [""], undefined);
            expect(githubMock.createPullRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    headBranchName: "release-svp--branches-main--api",
                    labels: ["autorelease: pending (api)"],
                }),
                expect.anything(),
                expect.anything(),
            );
        });

        it("release() namespaces the tag prefix, branch name and label", async () => {
            const githubMock = createGithubMock();
            const github = new Github({ owner: "owner", repo: "repo" }, token, logger);
            const namespacedRelease: Release = {
                sha: "sha0",
                tag: "api-v1.2.4",
                notes: "notes",
                pullRequestNumber: 4,
            };

            vi.mocked(determineReleases).mockResolvedValue([namespacedRelease]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const manifest = Manifest.forComponent(github, { owner: "owner", repo: "repo" }, "main", "api");
            await manifest.release();

            expect(determineReleases).toHaveBeenCalledWith(expect.anything(), "main", {
                releaseBranchName: "release-svp--branches-main--api",
                labelPending: "autorelease: pending (api)",
                tagPrefix: "api-",
            });
            expect(githubMock.removePullRequestLabels).toHaveBeenCalledWith(["autorelease: pending (api)"], 4);
            expect(githubMock.addPullRequestLabels).toHaveBeenCalledWith(["autorelease: tagged (api)"], 4);
        });
    });
});

function createGithubMock(overrides?: Partial<Github>) {
    const mock: Partial<Github> = {
        retrieveDefaultBranch: vi.fn().mockResolvedValue("main"),
        createPullRequest: vi.fn(),
        updatePullRequest: vi.fn(),
        pullRequestIterator: vi.fn(),
        createRelease: vi.fn(),
        commentOnIssue: vi.fn(),
        removePullRequestLabels: vi.fn(),
        addPullRequestLabels: vi.fn(),
        ...overrides,
    };

    vi.mocked(Github).mockImplementation(function GithubMock(this: any) {
        Object.assign(this, mock);
    });
    return mock as Github;
}

function expectReleasePullRequest(overrides?: Partial<PullRequest>, version: string = "1.2.4") {
    return expect.objectContaining({
        number: -1,
        title: `Release v${version}`,
        headBranchName: "release-svp--branches-main",
        baseBranchName: "main",
        permalink: "unused",
        labels: ["autorelease: pending"],
        ...overrides,
    });
}
