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
                    }),
                }),
            });

            const result = await ManifestRunner.create("owner/repo", token, undefined, logger);
            expect(result).not.toBeNull();

            const prepareA = vi.fn().mockRejectedValue(new Error("boom"));
            const prepareB = vi.fn().mockResolvedValue(undefined);
            vi.mocked(Manifest.forComponent)
                .mockReturnValueOnce({ prepare: prepareA } as unknown as Manifest)
                .mockReturnValueOnce({ prepare: prepareB } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await result!.prepare();

            expect(prepareA).toHaveBeenCalledWith("rust");
            expect(prepareB).toHaveBeenCalledWith("rust");
            expect(logger.error).toHaveBeenCalledWith("Failed to prepare release for component 'project-a'", expect.any(Error));
        });

        it("labels the implicit root component as '<root>' in log output", async () => {
            createGithubMock({
                retrieveFileContents: vi.fn().mockRejectedValue(new FileNotFoundError("release-svp-config.json")),
            });

            const result = await ManifestRunner.create("owner/repo", token, "rust", logger);
            expect(result).not.toBeNull();

            vi.mocked(Manifest.forComponent).mockReturnValue({
                prepare: vi.fn().mockRejectedValue(new Error("boom")),
            } as unknown as Manifest);
            vi.spyOn(logger, "error");

            await result!.prepare();

            expect(logger.error).toHaveBeenCalledWith("Failed to prepare release for component '<root>'", expect.any(Error));
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
    });
});

function createGithubMock(overrides?: Partial<Github>) {
    const mock: Partial<Github> = {
        retrieveDefaultBranch: vi.fn().mockResolvedValue("main"),
        retrieveFileContents: vi.fn(),
        ...overrides,
    };

    vi.mocked(Github).mockImplementation(function GithubMock(this: any) {
        Object.assign(this, mock);
    });
    return mock as Github;
}
