import { FileNotFoundError } from "@google-automations/git-file-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Github } from "../src/github";
import { logger } from "../src/logger";
import { Manifest } from "../src/manifest";
import { ManifestRunner } from "../src/manifestRunner";
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

vi.mock("../src/manifest", () => ({
    Manifest: {
        forComponent: vi.fn(),
    },
}));

describe("ManifestRunner", () => {
    const token = "token";

    beforeEach(() => {
        vi.resetAllMocks();
    });

    describe("#create", () => {
        it("returns null and logs an error for an invalid repository url", async () => {
            vi.spyOn(logger, "error");

            const result = await ManifestRunner.create("invalid", token, "rust", logger);

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledExactlyOnceWith("Invalid GitHub repository url 'invalid', expected 'repository/owner' format");
        });

        describe("without a config file", () => {
            it("falls back to a single root component using --release-type", async () => {
                createGithubMock({
                    retrieveFileContents: vi.fn().mockRejectedValue(new FileNotFoundError("release-svp-config.json")),
                });

                const result = await ManifestRunner.create("owner/repo", token, "rust", logger);

                expect(result).toBeInstanceOf(ManifestRunner);
            });

            it("returns null and logs an error when no --release-type is provided either", async () => {
                createGithubMock({
                    retrieveFileContents: vi.fn().mockRejectedValue(new FileNotFoundError("release-svp-config.json")),
                });
                vi.spyOn(logger, "error");

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);

                expect(result).toBeNull();
                expect(logger.error).toHaveBeenCalledWith("No 'release-svp-config.json' found and no '--release-type' provided, nothing to do");
            });

            it("propagates errors other than FileNotFoundError while fetching the config", async () => {
                createGithubMock({
                    retrieveFileContents: vi.fn().mockRejectedValue(new Error("boom")),
                });

                await expect(
                    ManifestRunner.create("owner/repo", token, "rust", logger)
                ).rejects.toThrow("boom");
            });
        });

        describe("with a config file", () => {
            const configContent = JSON.stringify({
                components: [
                    { path: "a/something", component: "project-a", releaseType: "rust" },
                    { path: "b", component: "project-b", releaseType: "rust" },
                ],
            });

            it("parses the components from the config file", async () => {
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({ parsedContent: configContent }),
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);

                expect(result).toBeInstanceOf(ManifestRunner);
            });

            it("logs a warning and ignores --release-type when a config file is present", async () => {
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({ parsedContent: configContent }),
                });
                vi.spyOn(logger, "warn");

                const result = await ManifestRunner.create("owner/repo", token, "rust", logger);

                expect(result).toBeInstanceOf(ManifestRunner);
                expect(logger.warn).toHaveBeenCalledWith("Both 'release-svp-config.json' and '--release-type' were provided, ignoring '--release-type'");
            });

            it("returns null and logs an error for an invalid config file", async () => {
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({ parsedContent: "{not json" }),
                });
                vi.spyOn(logger, "error");

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);

                expect(result).toBeNull();
                expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Invalid manifest config"));
            });

            it("uses the config's targetBranch override for components", async () => {
                createGithubMock({
                    retrieveDefaultBranch: vi.fn().mockResolvedValue("main"),
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            targetBranch: "trunk",
                            components: [{ path: "b", component: "project-b", releaseType: "rust" }],
                        }),
                    }),
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent).mockReturnValue({
                    prepare: vi.fn().mockResolvedValue(undefined),
                } as unknown as Manifest);

                await result!.prepare();

                expect(Manifest.forComponent).toHaveBeenCalledWith(expect.anything(), expect.anything(), "trunk", "project-b", "b", ["b"], undefined);
            });

            it("re-reads the config from the target branch when it differs from the default branch", async () => {
                const retrieveFileContents = vi.fn()
                    .mockResolvedValueOnce({
                        parsedContent: JSON.stringify({
                            targetBranch: "trunk",
                            components: [{ path: "a", component: "project-a", releaseType: "rust" }],
                        }),
                    })
                    .mockResolvedValueOnce({
                        // The config on "trunk" is authoritative for the actual release run, and may differ.
                        parsedContent: JSON.stringify({
                            components: [{ path: "b", component: "project-b", releaseType: "rust" }],
                        }),
                    });
                createGithubMock({ retrieveDefaultBranch: vi.fn().mockResolvedValue("main"), retrieveFileContents });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent).mockReturnValue({ prepare: vi.fn().mockResolvedValue(undefined) } as unknown as Manifest);

                await result!.prepare();

                expect(retrieveFileContents).toHaveBeenNthCalledWith(1, "release-svp-config.json", "main");
                expect(retrieveFileContents).toHaveBeenNthCalledWith(2, "release-svp-config.json", "trunk");
                expect(Manifest.forComponent).toHaveBeenCalledWith(expect.anything(), expect.anything(), "trunk", "project-b", "b", ["b"], undefined);
            });

            it("falls back to the default branch's config when the target branch has none", async () => {
                const retrieveFileContents = vi.fn()
                    .mockResolvedValueOnce({
                        parsedContent: JSON.stringify({
                            targetBranch: "trunk",
                            components: [{ path: "a", component: "project-a", releaseType: "rust" }],
                        }),
                    })
                    .mockRejectedValueOnce(new FileNotFoundError("release-svp-config.json"));
                createGithubMock({ retrieveDefaultBranch: vi.fn().mockResolvedValue("main"), retrieveFileContents });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent).mockReturnValue({ prepare: vi.fn().mockResolvedValue(undefined) } as unknown as Manifest);
                vi.spyOn(logger, "warn");

                await result!.prepare();

                expect(logger.warn).toHaveBeenCalledWith("'release-svp-config.json' not found on target branch 'trunk', falling back to the copy on default branch 'main'");
                expect(Manifest.forComponent).toHaveBeenCalledWith(expect.anything(), expect.anything(), "trunk", "project-a", "a", ["a"], undefined);
            });

            it("warns and ignores a nested targetBranch declared by the target branch's own config", async () => {
                const retrieveFileContents = vi.fn()
                    .mockResolvedValueOnce({
                        parsedContent: JSON.stringify({
                            targetBranch: "trunk",
                            components: [{ path: "a", component: "project-a", releaseType: "rust" }],
                        }),
                    })
                    .mockResolvedValueOnce({
                        parsedContent: JSON.stringify({
                            targetBranch: "another-branch",
                            components: [{ path: "b", component: "project-b", releaseType: "rust" }],
                        }),
                    });
                createGithubMock({ retrieveDefaultBranch: vi.fn().mockResolvedValue("main"), retrieveFileContents });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent).mockReturnValue({ prepare: vi.fn().mockResolvedValue(undefined) } as unknown as Manifest);
                vi.spyOn(logger, "warn");

                await result!.prepare();

                expect(logger.warn).toHaveBeenCalledWith(
                    "'release-svp-config.json' on target branch 'trunk' declares a different 'targetBranch' ('another-branch'), ignoring it to avoid a redirect loop",
                );
                expect(Manifest.forComponent).toHaveBeenCalledWith(expect.anything(), expect.anything(), "trunk", "project-b", "b", ["b"], undefined);
            });

            it("computes migration options per component from the config's 'migration' block", async () => {
                createGithubMock({
                    retrieveDefaultBranch: vi.fn().mockResolvedValue("main"),
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "a", component: "project-a", releaseType: "rust" },
                                { path: "b", component: "project-b", releaseType: "rust" },
                            ],
                            migration: {
                                cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01",
                                legacyRootSuccessor: "project-a",
                                legacyAnchorTag: "v1.4.0",
                                bootstrapVersions: { "project-b": "0.1.0" },
                            },
                        }),
                    }),
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent).mockReturnValue({
                    prepare: vi.fn().mockResolvedValue(undefined),
                } as unknown as Manifest);

                await result!.prepare();

                // "project-a" is the declared legacy successor: cutoverCommit + legacyAnchorTagName, no bootstrapVersion.
                expect(Manifest.forComponent).toHaveBeenCalledWith(
                    expect.anything(), expect.anything(), "main", "project-a", "a", ["a", "b"],
                    { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", legacyAnchorTagName: "v1.4.0" },
                );
                // "project-b" has no legacy history: cutoverCommit + its declared bootstrapVersion.
                expect(Manifest.forComponent).toHaveBeenCalledWith(
                    expect.anything(), expect.anything(), "main", "project-b", "b", ["a", "b"],
                    { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", bootstrapVersion: Version.parse("0.1.0") },
                );
            });
        });
    });

    describe("#prepare", () => {
        it("calls prepare for every component, isolating failures", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockResolvedValue({
                    parsedContent: JSON.stringify({
                        components: [
                            { path: "a", component: "project-a", releaseType: "rust" },
                            { path: "b", component: "project-b", releaseType: "rust" },
                        ],
                        separatePullRequests: true,
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            const computeCandidateA = vi.fn().mockRejectedValue(new Error("boom"));
            const computeCandidateB = vi.fn().mockResolvedValue({ componentName: "project-b", releaseVersion: Version.parse("1.0.0"), changelog: "", updates: [] });
            const openOrUpdatePullRequestB = vi.fn().mockResolvedValue(undefined);
            vi.mocked(Manifest.forComponent)
                .mockReturnValueOnce({ computeCandidate: computeCandidateA } as unknown as Manifest)
                .mockReturnValueOnce({ computeCandidate: computeCandidateB, openOrUpdatePullRequest: openOrUpdatePullRequestB } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await result!.prepare();

            expect(computeCandidateA).toHaveBeenCalledWith("rust");
            expect(computeCandidateB).toHaveBeenCalledWith("rust");
            expect(openOrUpdatePullRequestB).toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith("Failed to prepare release for component 'project-a'", expect.any(Error));
        });

        it("returns false when any component fails to prepare", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockResolvedValue({
                    parsedContent: JSON.stringify({
                        components: [
                            { path: "a", component: "project-a", releaseType: "rust" },
                            { path: "b", component: "project-b", releaseType: "rust" },
                        ],
                        separatePullRequests: true,
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            vi.mocked(Manifest.forComponent)
                .mockReturnValueOnce({ computeCandidate: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as Manifest)
                .mockReturnValueOnce({
                    computeCandidate: vi.fn().mockResolvedValue({ componentName: "project-b", releaseVersion: Version.parse("1.0.0"), changelog: "", updates: [] }),
                    openOrUpdatePullRequest: vi.fn().mockResolvedValue(undefined),
                } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await expect(result!.prepare()).resolves.toBe(false);
        });

        it("returns true when every component prepares successfully", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockResolvedValue({
                    parsedContent: JSON.stringify({
                        components: [
                            { path: "a", component: "project-a", releaseType: "rust" },
                            { path: "b", component: "project-b", releaseType: "rust" },
                        ],
                        separatePullRequests: true,
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            vi.mocked(Manifest.forComponent).mockReturnValue({
                computeCandidate: vi.fn().mockResolvedValue({ componentName: "project-a", releaseVersion: Version.parse("1.0.0"), changelog: "", updates: [] }),
                openOrUpdatePullRequest: vi.fn().mockResolvedValue(undefined),
            } as unknown as Manifest);

            await expect(result!.prepare()).resolves.toBe(true);
        });

        it("returns false and refuses to open any pull request when two components' updates target the same path", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockResolvedValue({
                    parsedContent: JSON.stringify({
                        components: [
                            { path: "a", component: "project-a", releaseType: "rust" },
                            { path: "b", component: "project-b", releaseType: "rust" },
                        ],
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            const sharedUpdate = { path: "CHANGELOG.md", createIfMissing: true, updater: { updateContent: vi.fn() } };
            const openOrUpdatePullRequestA = vi.fn().mockResolvedValue(undefined);
            const openOrUpdatePullRequestB = vi.fn().mockResolvedValue(undefined);
            vi.mocked(Manifest.forComponent)
                .mockReturnValueOnce({
                    computeCandidate: vi.fn().mockResolvedValue({ componentName: "project-a", releaseVersion: Version.parse("1.0.0"), changelog: "", updates: [sharedUpdate] }),
                    openOrUpdatePullRequest: openOrUpdatePullRequestA,
                } as unknown as Manifest)
                .mockReturnValueOnce({
                    computeCandidate: vi.fn().mockResolvedValue({ componentName: "project-b", releaseVersion: Version.parse("1.0.0"), changelog: "", updates: [sharedUpdate] }),
                    openOrUpdatePullRequest: openOrUpdatePullRequestB,
                } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await expect(result!.prepare()).resolves.toBe(false);

            expect(logger.error).toHaveBeenCalledWith("Update path collision: 'CHANGELOG.md' would be written by multiple components [project-a, project-b] — refusing to prepare any release this run, since combining them would let one component's changes silently overwrite another's");
            expect(openOrUpdatePullRequestA).not.toHaveBeenCalled();
            expect(openOrUpdatePullRequestB).not.toHaveBeenCalled();
        });

        it("labels the implicit root component as '<root>' in log output", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockRejectedValue(new FileNotFoundError("release-svp-config.json")),
            });

            const result = await ManifestRunner.create("owner/repo", token, "rust", logger);
            expect(result).not.toBeNull();

            vi.mocked(Manifest.forComponent).mockReturnValue({
                computeCandidate: vi.fn().mockRejectedValue(new Error("boom")),
            } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await result!.prepare();

            expect(logger.error).toHaveBeenCalledWith("Failed to prepare release for component '<root>'", expect.any(Error));
        });

        describe("combined pull requests", () => {
            function candidateFor(componentName: string, path: string) {
                return {
                    componentName,
                    releaseVersion: Version.parse("1.0.0"),
                    changelog: `Release notes for ${componentName}`,
                    updates: [{ path, createIfMissing: true, updater: { updateContent: vi.fn() } }],
                };
            }

            it("opens one combined pull request for two ungrouped components", async () => {
                const pullRequestIterator = vi.fn().mockImplementation(async function* () {});
                const createPullRequest = vi.fn().mockResolvedValue({ number: 42 });
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "a", component: "project-a", releaseType: "rust" },
                                { path: "b", component: "project-b", releaseType: "rust" },
                            ],
                        }),
                    }),
                    pullRequestIterator,
                    createPullRequest,
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-a", "a/Cargo.toml")) } as unknown as Manifest)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-b", "b/Cargo.toml")) } as unknown as Manifest);

                await expect(result!.prepare()).resolves.toBe(true);

                expect(createPullRequest).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                        title: "Release repo",
                        headBranchName: "release-svp--branches-main--combined",
                        baseBranchName: "main",
                        labels: ["autorelease: pending (project-a)", "autorelease: pending (project-b)"],
                    }),
                    "Release repo",
                    [
                        { path: "a/Cargo.toml", createIfMissing: true, updater: expect.anything() },
                        { path: "b/Cargo.toml", createIfMissing: true, updater: expect.anything() },
                    ],
                );
            });

            it("updates the existing combined pull request, carrying forward a member with no new candidate this run", async () => {
                const existingBody = "<!-- release-svp:component:project-a -->\nOld notes for project-a\n<!-- /release-svp:component:project-a -->";
                const existingPullRequest = {
                    number: 7,
                    title: "Release repo",
                    body: `:bowtie: I have created a release\n---\n\n\n${existingBody}\n\n---\nThis pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).`,
                    permalink: "unused",
                    headBranchName: "release-svp--branches-main--combined",
                    baseBranchName: "main",
                    labels: ["autorelease: pending (project-a)"],
                };
                const pullRequestIterator = vi.fn().mockImplementation(async function* () {
                    yield existingPullRequest;
                });
                const updatePullRequest = vi.fn().mockResolvedValue({ number: 7 });
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "a", component: "project-a", releaseType: "rust" },
                                { path: "b", component: "project-b", releaseType: "rust" },
                            ],
                        }),
                    }),
                    pullRequestIterator,
                    updatePullRequest,
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                // project-a has no new candidate this run (nothing unreleased); only project-b does.
                vi.mocked(Manifest.forComponent)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(undefined) } as unknown as Manifest)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-b", "b/Cargo.toml")) } as unknown as Manifest);

                await expect(result!.prepare()).resolves.toBe(true);

                expect(updatePullRequest).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                        headBranchName: "release-svp--branches-main--combined",
                        labels: ["autorelease: pending (project-a)", "autorelease: pending (project-b)"],
                        body: expect.stringContaining("Old notes for project-a"),
                    }),
                    "Release repo",
                    [{ path: "b/Cargo.toml", createIfMissing: true, updater: expect.anything() }],
                );
            });

            it("fails loudly and does not touch any pull request when the existing pull request has an orphaned component section", async () => {
                const existingBody = "<!-- release-svp:component:project-c -->\nOld notes for project-c\n<!-- /release-svp:component:project-c -->";
                const existingPullRequest = {
                    number: 7,
                    title: "Release repo",
                    body: `:bowtie: I have created a release\n---\n\n\n${existingBody}\n\n---\nThis pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).`,
                    permalink: "unused",
                    headBranchName: "release-svp--branches-main--combined",
                    baseBranchName: "main",
                    labels: ["autorelease: pending (project-c)"],
                };
                const pullRequestIterator = vi.fn().mockImplementation(async function* () {
                    yield existingPullRequest;
                });
                const updatePullRequest = vi.fn().mockResolvedValue({ number: 7 });
                const createPullRequest = vi.fn().mockResolvedValue({ number: 7 });
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "a", component: "project-a", releaseType: "rust" },
                                { path: "b", component: "project-b", releaseType: "rust" },
                            ],
                        }),
                    }),
                    pullRequestIterator,
                    updatePullRequest,
                    createPullRequest,
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-a", "a/Cargo.toml")) } as unknown as Manifest)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-b", "b/Cargo.toml")) } as unknown as Manifest);
                vi.spyOn(logger, "error");

                await expect(result!.prepare()).resolves.toBe(false);

                expect(logger.error).toHaveBeenCalledWith(
                    "Failed to prepare release for release unit 'combined'",
                    expect.objectContaining({ message: expect.stringContaining("project-c") }),
                );
                expect(updatePullRequest).not.toHaveBeenCalled();
                expect(createPullRequest).not.toHaveBeenCalled();
            });

            it("aborts the whole run when a component is already tracked by a conflicting pull request on another branch", async () => {
                const legacyPullRequest = {
                    number: 3,
                    title: "Release v1.0.0",
                    body: "<!-- release-svp:component:project-a -->\nLegacy notes\n<!-- /release-svp:component:project-a -->",
                    permalink: "unused",
                    headBranchName: "release-svp--branches-main--project-a",
                    baseBranchName: "main",
                    labels: ["autorelease: pending (project-a)"],
                };
                const pullRequestIterator = vi.fn().mockImplementation(async function* () {
                    yield legacyPullRequest;
                });
                const createPullRequest = vi.fn().mockResolvedValue({ number: 42 });
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "a", component: "project-a", releaseType: "rust" },
                                { path: "b", component: "project-b", releaseType: "rust" },
                            ],
                        }),
                    }),
                    pullRequestIterator,
                    createPullRequest,
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-a", "a/Cargo.toml")) } as unknown as Manifest)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-b", "b/Cargo.toml")) } as unknown as Manifest);
                vi.spyOn(logger, "error");

                await expect(result!.prepare()).resolves.toBe(false);

                expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("already tracked by pull request #3"));
                expect(createPullRequest).not.toHaveBeenCalled();
            });

            it("opens a combined pull request titled after the releaseGroup for a named group, end-to-end", async () => {
                const pullRequestIterator = vi.fn().mockImplementation(async function* () {});
                const createPullRequest = vi.fn().mockResolvedValue({ number: 42 });
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "ios", component: "ios-client", releaseType: "rust", releaseGroup: "mobile" },
                                { path: "android", component: "android-client", releaseType: "rust", releaseGroup: "mobile" },
                            ],
                        }),
                    }),
                    pullRequestIterator,
                    createPullRequest,
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("ios-client", "ios/version.txt")) } as unknown as Manifest)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("android-client", "android/version.txt")) } as unknown as Manifest);

                await expect(result!.prepare()).resolves.toBe(true);

                expect(createPullRequest).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                        title: "Release mobile",
                        headBranchName: "release-svp--branches-main--mobile",
                        baseBranchName: "main",
                        labels: ["autorelease: pending (ios-client)", "autorelease: pending (android-client)"],
                    }),
                    "Release mobile",
                    [
                        { path: "ios/version.txt", createIfMissing: true, updater: expect.anything() },
                        { path: "android/version.txt", createIfMissing: true, updater: expect.anything() },
                    ],
                );
            });

            it("handles a combined group and an ungrouped singleton independently within the same run", async () => {
                const pullRequestIterator = vi.fn().mockImplementation(async function* () {});
                const createPullRequest = vi.fn().mockResolvedValue({ number: 42 });
                const openOrUpdatePullRequestBackend = vi.fn().mockResolvedValue(undefined);
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "ios", component: "ios-client", releaseType: "rust", releaseGroup: "mobile" },
                                { path: "android", component: "android-client", releaseType: "rust", releaseGroup: "mobile" },
                                { path: "backend", component: "backend", releaseType: "rust" },
                            ],
                        }),
                    }),
                    pullRequestIterator,
                    createPullRequest,
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                vi.mocked(Manifest.forComponent)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("ios-client", "ios/version.txt")) } as unknown as Manifest)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("android-client", "android/version.txt")) } as unknown as Manifest)
                    .mockReturnValueOnce({
                        computeCandidate: vi.fn().mockResolvedValue(candidateFor("backend", "backend/version.txt")),
                        openOrUpdatePullRequest: openOrUpdatePullRequestBackend,
                    } as unknown as Manifest);

                await expect(result!.prepare()).resolves.toBe(true);

                // The mobile group gets its own combined pull request...
                expect(createPullRequest).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({ title: "Release mobile", headBranchName: "release-svp--branches-main--mobile" }),
                    "Release mobile",
                    expect.anything(),
                );
                // ...while the ungrouped 'backend' component keeps its own independent, unchanged pull request path.
                expect(openOrUpdatePullRequestBackend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ componentName: "backend" }));
            });

            it("excludes a member with no candidate this run and no existing section from the combined pull request's labels and updates", async () => {
                const pullRequestIterator = vi.fn().mockImplementation(async function* () {});
                const createPullRequest = vi.fn().mockResolvedValue({ number: 42 });
                createGithubMock({
                    retrieveFileContents: vi.fn().mockResolvedValue({
                        parsedContent: JSON.stringify({
                            components: [
                                { path: "a", component: "project-a", releaseType: "rust" },
                                { path: "b", component: "project-b", releaseType: "rust" },
                            ],
                        }),
                    }),
                    pullRequestIterator,
                    createPullRequest,
                });

                const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
                expect(result).not.toBeNull();

                // project-b has never released before: no candidate this run, and (since there's no existing
                // pull request at all) no carried-forward section either — it must not appear in the combined
                // pull request at all.
                vi.mocked(Manifest.forComponent)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(candidateFor("project-a", "a/Cargo.toml")) } as unknown as Manifest)
                    .mockReturnValueOnce({ computeCandidate: vi.fn().mockResolvedValue(undefined) } as unknown as Manifest);

                await expect(result!.prepare()).resolves.toBe(true);

                expect(createPullRequest).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                        labels: ["autorelease: pending (project-a)"],
                        body: expect.not.stringContaining("project-b"),
                    }),
                    "Release repo",
                    [{ path: "a/Cargo.toml", createIfMissing: true, updater: expect.anything() }],
                );
            });
        });
    });

    describe("#release", () => {
        it("calls release for every component, isolating failures", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockResolvedValue({
                    parsedContent: JSON.stringify({
                        components: [
                            { path: "a", component: "project-a", releaseType: "rust" },
                            { path: "b", component: "project-b", releaseType: "rust" },
                        ],
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            const releaseA = vi.fn().mockResolvedValue(undefined);
            const releaseB = vi.fn().mockRejectedValue(new Error("boom"));
            vi.mocked(Manifest.forComponent)
                .mockReturnValueOnce({ release: releaseA } as unknown as Manifest)
                .mockReturnValueOnce({ release: releaseB } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await result!.release();

            expect(releaseA).toHaveBeenCalledOnce();
            expect(releaseB).toHaveBeenCalledOnce();
            expect(logger.error).toHaveBeenCalledWith("Failed to create release(s) for component 'project-b'", expect.any(Error));
        });

        it("returns false when any component fails to release", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockResolvedValue({
                    parsedContent: JSON.stringify({
                        components: [
                            { path: "a", component: "project-a", releaseType: "rust" },
                            { path: "b", component: "project-b", releaseType: "rust" },
                        ],
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            vi.mocked(Manifest.forComponent)
                .mockReturnValueOnce({ release: vi.fn().mockResolvedValue(undefined) } as unknown as Manifest)
                .mockReturnValueOnce({ release: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await expect(result!.release()).resolves.toBe(false);
        });

        it("returns true when every component releases successfully", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockResolvedValue({
                    parsedContent: JSON.stringify({
                        components: [
                            { path: "a", component: "project-a", releaseType: "rust" },
                            { path: "b", component: "project-b", releaseType: "rust" },
                        ],
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            vi.mocked(Manifest.forComponent).mockReturnValue({ release: vi.fn().mockResolvedValue(undefined) } as unknown as Manifest);

            await expect(result!.release()).resolves.toBe(true);
        });
    });
});

function createGithubMock(overrides?: Partial<Github>) {
    const mock: Partial<Github> = {
        retrieveDefaultBranch: vi.fn().mockResolvedValue("main"),
        retrieveFileContents: vi.fn(),
        pullRequestIterator: vi.fn().mockImplementation(async function* () {}),
        ...overrides,
    };

    vi.mocked(Github).mockImplementation(function GithubMock(this: any) {
        Object.assign(this, mock);
    });
    return mock as Github;
}
