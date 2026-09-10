import { RequestError } from "octokit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChangelog } from "../src/changelogBuilder";
import { Commit, PullRequest } from "../src/commit";
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
    const repository = { owner: "owner", repo: "repo" };

    beforeEach(() => {
        vi.resetAllMocks();
    });

    // Builds the root-component Manifest instance used by most tests below (mirroring how ManifestRunner
    // constructs one per component in production), plus computes and opens/updates its pull request in one call
    // — a small test-only convenience, since `computeCandidate`/`openOrUpdatePullRequest` are now deliberately
    // separate on `Manifest` itself (the title is repo-wide context only the caller has, see manifestRunner.ts).
    function createManifest(): Manifest {
        const github = new Github(repository, token, logger);
        return Manifest.forComponent(github, repository, "main");
    }

    async function prepareAndOpen(manifest: Manifest, releaseType: string, title: string = "Release v1.2.4"): Promise<void> {
        const candidate = await manifest.computeCandidate(releaseType);
        if (candidate) {
            await manifest.openOrUpdatePullRequest(candidate, title);
        }
    }

    describe("computeCandidate + openOrUpdatePullRequest", () => {
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
                    previousStableRelease: Version.parse("1.2.3"),
                    unreleasedCommits: [],
                });

                const manifest = createManifest();

                await prepareAndOpen(manifest, "rust");

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
                    previousStableRelease: Version.parse("1.2.3"),
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

                const manifest = createManifest();

                await prepareAndOpen(manifest, "rust");

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
                    previousStableRelease: Version.parse("1.2.3"),
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


                const manifest = createManifest();

                await prepareAndOpen(manifest, "rust");

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
                    previousStableRelease: Version.parse("1.2.3"),
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

                const manifest = createManifest();

                await prepareAndOpen(manifest, "rust");

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
                    body: createPullRequestBody([{ componentName: "", notes: undefined as unknown as string }]),
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
                    previousStableRelease: Version.parse("1.2.3"),
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

                const manifest = createManifest();

                await prepareAndOpen(manifest, "rust");

                expect(logger.info).toHaveBeenCalledWith(`Done, pull request https://github.com/owner/repo/pull/2 remained the same`);
                expect(githubMock.createPullRequest).not.toHaveBeenCalled();
                expect(githubMock.updatePullRequest).not.toHaveBeenCalled();
            });

            it("does not update the pull request if it is missing the pending label", async () => {
                const existingPullRequest: PullRequest = {
                    ...pullRequest,
                    title: "Release v1.2.4",
                    body: createPullRequestBody([{ componentName: "", notes: undefined as unknown as string }]),
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
                    previousStableRelease: Version.parse("1.2.3"),
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

                const manifest = createManifest();

                await prepareAndOpen(manifest, "rust");

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
            prerelease: false,
        }

        it("does nothing if there is nothing to release", async () => {
            const githubMock = createGithubMock();
            vi.spyOn(logger, "info");

            vi.mocked(determineReleases).mockResolvedValue([]);

            const manifest = createManifest();

            await manifest.release();

            expect(logger.info).toHaveBeenCalledWith(`Nothing to release 🐼`);
            expect(githubMock.createRelease).not.toHaveBeenCalled();
        });

        it("creates a release for every release", async () => {
            const githubMock = createGithubMock();

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const manifest = createManifest();

            await manifest.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
        });

        it("creates a comment on every release", async () => {
            const githubMock = createGithubMock();

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const manifest = createManifest();

            await manifest.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
            expect(githubMock.commentOnIssue).toHaveBeenCalledWith(":bowtie: Created release [v1.2.4](url) :tulip:", 4);
        });

        it("updates the labels on every release", async () => {
            const githubMock = createGithubMock();

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const manifest = createManifest();

            await manifest.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
            expect(githubMock.removePullRequestLabels).toHaveBeenCalledWith(["autorelease: pending"], 4);
            expect(githubMock.addPullRequestLabels).toHaveBeenCalledWith(["autorelease: tagged"], 4);
        });

        it("resumes bookkeeping for a release that already exists, without re-commenting", async () => {
            const githubMock = createGithubMock();
            vi.spyOn(logger, "warn");

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockRejectedValue(new DuplicateReleaseError(new RequestError("", 400, {request: { method: "GET", url: "", headers: {}}}), "v1.2.4"));
            vi.mocked(githubMock.retrieveReleaseByTag).mockResolvedValue({ id: 1, url: "url" });

            const manifest = createManifest();

            await manifest.release();

            expect(githubMock.createRelease).toHaveBeenCalledWith(release);
            expect(githubMock.retrieveReleaseByTag).toHaveBeenCalledWith("v1.2.4");
            expect(logger.warn).toHaveBeenCalledWith(`Release v1.2.4 already exists, resuming pull request #4 bookkeeping...`);
            expect(githubMock.commentOnIssue).not.toHaveBeenCalled();
            expect(githubMock.addPullRequestLabels).toHaveBeenCalledWith(["autorelease: tagged"], 4);
            expect(githubMock.removePullRequestLabels).toHaveBeenCalledWith(["autorelease: pending"], 4);
        });

        it("throws unexpected exceptions", async () => {
            const githubMock = createGithubMock();
            vi.spyOn(logger, "warn");

            vi.mocked(determineReleases).mockResolvedValue([release]);
            vi.mocked(githubMock.createRelease).mockRejectedValue(new Error("boom"));

            const manifest = createManifest();

            await expect(
                manifest.release()
            ).rejects.toThrow("boom");
        });
    });

    // See determineReleaseContext.ts (`previousStableRelease`) and manifestConfig.ts (`ComponentConfig.prereleaseType`).
    describe("computeCandidate with a configured prereleaseType", () => {
        function createManifestWithPrereleaseType(prereleaseType: string | undefined): Manifest {
            const github = new Github(repository, token, logger);
            return Manifest.forComponent(github, repository, "main", "", "", [""], undefined, prereleaseType);
        }

        function fixCommit(): Commit {
            return { sha: "sha0", message: "Fix a bug", isMergeCommit: false };
        }

        function breakingChangeCommit(): Commit {
            return {
                sha: "sha0",
                message: "Breaking change",
                isMergeCommit: true,
                pullRequest: {
                    number: 1,
                    title: "Breaking change",
                    body: "body",
                    permalink: "permalink",
                    headBranchName: "head",
                    baseBranchName: "main",
                    labels: ["feat!"],
                },
            };
        }

        beforeEach(() => {
            createGithubMock();
            vi.mocked(buildStrategy).mockReturnValue({
                config: { github: new Github(repository, token, logger) },
                async determineUpdates(_options: UpdateOptions): Promise<Update[]> {
                    return [];
                }
            });
        });

        it("starts a new pre-release train (fresh identifier, no number yet) when there is no train in progress", async () => {
            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.2.3"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });

            const candidate = await createManifestWithPrereleaseType("beta").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("1.2.4-beta"));
        });

        it("increments the identifier's trailing number when continuing the same train", async () => {
            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.3.0-beta.1"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });

            const candidate = await createManifestWithPrereleaseType("beta").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("1.3.0-beta.2"));
        });

        // Regression test: a `prereleaseType` that itself ends in a number (e.g. "rc.1") must not be confused
        // with the train's own counter — see `incrementTrainCounter` in manifest.ts. Before that fix, this
        // sequence would produce "rc.1" -> "rc.2" -> "rc.1" again (the counter increment mutated part of the
        // configured type instead of an isolated counter), silently reusing an already-published tag on the
        // third release.
        it("keeps incrementing a numbered prereleaseType's own counter, without conflating it with the type's trailing number", async () => {
            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.2.3"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });
            let candidate = await createManifestWithPrereleaseType("rc.1").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("1.2.4-rc.1"));

            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.2.4-rc.1"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });
            candidate = await createManifestWithPrereleaseType("rc.1").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("1.2.4-rc.1.1"));

            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.2.4-rc.1.1"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });
            candidate = await createManifestWithPrereleaseType("rc.1").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("1.2.4-rc.1.2"));
        });

        it("keeps a mid-train bump that a prior tag already reflects, even when the only new commit is trivial", async () => {
            // previousRelease already reflects a major bump over the stable baseline (from an earlier commit
            // in the train); the only unreleased commit since then is a trivial fix, which alone would only
            // justify a patch bump — the major bump must not be lost.
            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("2.0.0-beta.1"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });

            const candidate = await createManifestWithPrereleaseType("beta").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("2.0.0-beta.2"));
        });

        it("starts a fresh train at a bigger target when a breaking change lands mid-train", async () => {
            // The train so far only reflects a minor bump (1.3.0-beta.1); a breaking change now lands, moving
            // the target past what that identifier covers, so the train restarts fresh at the new target.
            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.3.0-beta.1"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [breakingChangeCommit()],
            });

            const candidate = await createManifestWithPrereleaseType("beta").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("2.0.0-beta"));
        });

        it("graduates to a stable release when prereleaseType is no longer configured", async () => {
            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.3.0-beta.2"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });

            const candidate = await createManifestWithPrereleaseType(undefined).computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("1.3.0"));
        });

        it("starts fresh (does not increment) when prereleaseType switches to a different word", async () => {
            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.3.0-beta.2"),
                previousStableRelease: Version.parse("1.2.3"),
                unreleasedCommits: [fixCommit()],
            });

            const candidate = await createManifestWithPrereleaseType("rc").computeCandidate("rust");
            expect(candidate?.releaseVersion).toEqual(Version.parse("1.3.0-rc"));
        });
    });

    describe("with a named component", () => {
        it("computeCandidate/openOrUpdatePullRequest namespaces the tag prefix, branch name and label", async () => {
            const githubMock = createGithubMock({
                pullRequestIterator: (async function* () {}),
                createPullRequest: vi.fn().mockResolvedValue({ number: 5 }),
            });
            const github = new Github({ owner: "owner", repo: "repo" }, token, logger);

            vi.mocked(determineReleaseContext).mockResolvedValue({
                previousRelease: Version.parse("1.2.3"),
                previousStableRelease: Version.parse("1.2.3"),
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
            await prepareAndOpen(manifest, "rust", "Release api v1.2.4");

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
                prerelease: false,
            };

            vi.mocked(determineReleases).mockResolvedValue([namespacedRelease]);
            vi.mocked(githubMock.createRelease).mockResolvedValue({ id: 1, url: "url", pullRequestNumber: 4 });

            const manifest = Manifest.forComponent(github, { owner: "owner", repo: "repo" }, "main", "api");
            await manifest.release();

            expect(determineReleases).toHaveBeenCalledWith(expect.anything(), "main", {
                labelPending: "autorelease: pending (api)",
                tagPrefix: "api-",
                componentName: "api",
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
        retrieveReleaseByTag: vi.fn(),
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
