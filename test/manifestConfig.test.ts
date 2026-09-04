import { describe, expect, it } from "vitest";
import { ManifestConfigError, parseManifestConfig } from "../src/manifestConfig";

describe("parseManifestConfig", () => {
    it("parses a valid config with a single component", () => {
        const config = parseManifestConfig(JSON.stringify({
            components: [
                { path: "a/something", component: "project-a", releaseType: "rust" },
            ],
        }));

        expect(config.targetBranch).toBeUndefined();
        expect(config.components).toEqual([
            { path: "a/something", component: "project-a", releaseType: "rust" },
        ]);
    });

    it("parses a valid config with multiple components and an explicit target branch", () => {
        const config = parseManifestConfig(JSON.stringify({
            targetBranch: "trunk",
            components: [
                { path: "a/something", component: "project-a", releaseType: "rust" },
                { path: "b", component: "project-b", releaseType: "rust" },
            ],
        }));

        expect(config.targetBranch).toBe("trunk");
        expect(config.components).toHaveLength(2);
    });

    it("normalizes a root path ('', '.', or trailing/leading slashes) to an empty string", () => {
        for (const path of ["", ".", "/", "./", "b/"]) {
            const config = parseManifestConfig(JSON.stringify({
                components: [{ path, component: "root", releaseType: "rust" }],
            }));

            const expected = path === "b/" ? "b" : "";
            expect(config.components[0].path).toBe(expected);
        }
    });

    it("throws for invalid JSON", () => {
        expect(() => parseManifestConfig("{not json")).toThrow(ManifestConfigError);
    });

    it("throws when the top-level value is not an object", () => {
        expect(() => parseManifestConfig("[]")).toThrow(ManifestConfigError);
        expect(() => parseManifestConfig('"a string"')).toThrow(ManifestConfigError);
    });

    it("throws when 'components' is missing or empty", () => {
        expect(() => parseManifestConfig("{}")).toThrow(/'components' must be a non-empty array/);
        expect(() => parseManifestConfig(JSON.stringify({ components: [] }))).toThrow(/'components' must be a non-empty array/);
    });

    it("throws when 'targetBranch' is present but not a non-empty string", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            targetBranch: "",
            components: [{ path: "b", component: "project-b", releaseType: "rust" }],
        }))).toThrow(/'targetBranch' must be a non-empty string/);
    });

    it("throws when a component is missing required fields", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [{ path: "b" }],
        }))).toThrow(ManifestConfigError);
    });

    it("throws when 'releaseType' is not a known strategy", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [{ path: "b", component: "project-b", releaseType: "unknown" }],
        }))).toThrow(/'releaseType' must be one of \[rust\]/);
    });

    it("throws when 'component' contains invalid characters", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [{ path: "b", component: "project a/b", releaseType: "rust" }],
        }))).toThrow(/'component' must only contain letters, digits/);
    });

    it("throws when 'component' is the reserved name 'combined'", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [{ path: "b", component: "combined", releaseType: "rust" }],
        }))).toThrow(/'combined' is a reserved component name/);
    });

    it("throws when a component path is absolute", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [{ path: "/etc", component: "project-a", releaseType: "rust" }],
        }))).toThrow(/'path' must be relative, not absolute/);
    });

    it("throws when a component path contains '..'", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [{ path: "../secrets", component: "project-a", releaseType: "rust" }],
        }))).toThrow(/'path' must not contain '\.\.'/);
    });

    it("throws when two components share the same component name", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [
                { path: "a", component: "project", releaseType: "rust" },
                { path: "b", component: "project", releaseType: "rust" },
            ],
        }))).toThrow(/duplicate component name 'project'/);
    });

    it("throws when two components share the same normalized path", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [
                { path: "b/", component: "project-a", releaseType: "rust" },
                { path: "b", component: "project-b", releaseType: "rust" },
            ],
        }))).toThrow(/duplicate path 'b'/);
    });

    it("collects multiple issues in a single error", () => {
        try {
            parseManifestConfig(JSON.stringify({
                components: [
                    { path: "a", component: "project", releaseType: "rust" },
                    { path: "a", component: "project", releaseType: "rust" },
                ],
            }));
            expect.fail("expected parseManifestConfig to throw");
        } catch (e) {
            expect(e).toBeInstanceOf(ManifestConfigError);
            const error = e as ManifestConfigError;
            expect(error.issues).toEqual([
                "components[1]: duplicate component name 'project'",
                "components[1]: duplicate path 'a'",
            ]);
        }
    });

    describe("migration", () => {
        const baseComponents = [
            { path: "a", component: "project-a", releaseType: "rust" },
            { path: "b", component: "project-b", releaseType: "rust" },
        ];

        it("parses a valid migration config with a legacy successor and bootstrap versions", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: {
                    cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01",
                    legacyRootSuccessor: "project-a",
                    legacyAnchorTag: "v1.4.0",
                    bootstrapVersions: { "project-b": "0.1.0" },
                },
            }));

            expect(config.migration).toEqual({
                cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01",
                legacyRootSuccessor: "project-a",
                legacyAnchorTag: "v1.4.0",
                bootstrapVersions: { "project-b": "0.1.0" },
            });
        });

        it("parses a valid migration config without a legacy successor (bootstrapping every component)", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: {
                    cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01",
                    bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0" },
                },
            }));

            expect(config.migration?.legacyRootSuccessor).toBeUndefined();
            expect(config.migration?.legacyAnchorTag).toBeUndefined();
        });

        it("throws when 'cutoverCommit' is missing or not a valid SHA", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0" } },
            }))).toThrow(/'migration\.cutoverCommit' must be a full commit SHA/);

            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "not-a-sha", bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0" } },
            }))).toThrow(/'migration\.cutoverCommit' must be a full commit SHA/);
        });

        it("throws when 'cutoverCommit' is an abbreviated SHA", () => {
            // Abbreviated SHAs must be rejected: `truncateAtCutover` compares this value verbatim against full
            // commit OIDs from the GitHub API, so an abbreviation would never match and would silently defeat
            // the cutover truncation (see manifestConfig.ts COMMIT_SHA_PATTERN comment).
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "abc1234", bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0" } },
            }))).toThrow(/'migration\.cutoverCommit' must be a full commit SHA \(40 hex characters\), not an abbreviation/);
        });

        it("throws when 'legacyRootSuccessor' does not reference a configured component", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", legacyRootSuccessor: "unknown", legacyAnchorTag: "v1.0.0" },
            }))).toThrow(/'migration\.legacyRootSuccessor' must reference a configured component \(got 'unknown'\)/);
        });

        it("throws when 'legacyRootSuccessor' is set without a 'legacyAnchorTag'", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", legacyRootSuccessor: "project-a", bootstrapVersions: { "project-b": "0.1.0" } },
            }))).toThrow(/'migration\.legacyAnchorTag' is required.*when 'legacyRootSuccessor' is set/);
        });

        it("throws when 'legacyAnchorTag' is set without a 'legacyRootSuccessor'", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", legacyAnchorTag: "v1.0.0", bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0" } },
            }))).toThrow(/'migration\.legacyAnchorTag' is only meaningful together with 'legacyRootSuccessor'/);
        });

        it("throws when a bootstrapVersions entry references an unknown component", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0", unknown: "0.1.0" } },
            }))).toThrow(/'migration\.bootstrapVersions': 'unknown' is not a configured component/);
        });

        it("throws when a bootstrapVersions entry is for the legacy successor", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: {
                    cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01",
                    legacyRootSuccessor: "project-a",
                    legacyAnchorTag: "v1.0.0",
                    bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0" },
                },
            }))).toThrow(/'project-a' is the legacy root successor and inherits its baseline from 'legacyAnchorTag'/);
        });

        it("throws when a bootstrapVersions value is not a valid version string", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", bootstrapVersions: { "project-a": "not-a-version", "project-b": "0.1.0" } },
            }))).toThrow(/'migration\.bootstrapVersions\.project-a' must be a semantic version string/);
        });

        it("throws when a non-successor component has no bootstrap version", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                migration: { cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01", bootstrapVersions: { "project-a": "0.1.0" } },
            }))).toThrow(/'migration\.bootstrapVersions' is missing a starting version for component 'project-b'/);
        });
    });

    describe("separatePullRequests", () => {
        const baseComponents = [
            { path: "a/something", component: "project-a", releaseType: "rust" },
        ];

        it("is undefined when absent", () => {
            const config = parseManifestConfig(JSON.stringify({ components: baseComponents }));
            expect(config.separatePullRequests).toBeUndefined();
        });

        it("parses 'true'", () => {
            const config = parseManifestConfig(JSON.stringify({ components: baseComponents, separatePullRequests: true }));
            expect(config.separatePullRequests).toBe(true);
        });

        it("parses 'false'", () => {
            const config = parseManifestConfig(JSON.stringify({ components: baseComponents, separatePullRequests: false }));
            expect(config.separatePullRequests).toBe(false);
        });

        it("throws when not a boolean", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: baseComponents,
                separatePullRequests: "true",
            }))).toThrow(/'separatePullRequests' must be a boolean/);
        });
    });

    describe("releaseGroup", () => {
        it("is undefined when absent", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust" }],
            }));
            expect(config.components[0].releaseGroup).toBeUndefined();
        });

        it("parses a valid group name", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: [
                    { path: "a", component: "ios-client", releaseType: "rust", releaseGroup: "product-a" },
                    { path: "b", component: "android-client", releaseType: "rust", releaseGroup: "product-a" },
                ],
            }));
            expect(config.components[0].releaseGroup).toBe("product-a");
            expect(config.components[1].releaseGroup).toBe("product-a");
        });

        it("throws when present but empty", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", releaseGroup: "" }],
            }))).toThrow(/'releaseGroup' must be a non-empty string/);
        });

        it("throws when it contains invalid characters", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", releaseGroup: "product a" }],
            }))).toThrow(/'releaseGroup' must only contain letters, digits/);
        });

        it("throws when it matches a configured component's name", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [
                    { path: "a", component: "project-a", releaseType: "rust", releaseGroup: "project-b" },
                    { path: "b", component: "project-b", releaseType: "rust" },
                ],
            }))).toThrow(/'releaseGroup' value 'project-b' \(on component 'project-a'\) must not match a configured component name/);
        });

        it("throws when combined with 'separatePullRequests: true'", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [
                    { path: "a", component: "ios-client", releaseType: "rust", releaseGroup: "product-a" },
                    { path: "b", component: "android-client", releaseType: "rust", releaseGroup: "product-a" },
                ],
                separatePullRequests: true,
            }))).toThrow(/'separatePullRequests: true' cannot be combined with 'releaseGroup'/);
        });

        it("does not throw when combined with 'separatePullRequests: false' — only 'true' is exclusive", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: [
                    { path: "a", component: "ios-client", releaseType: "rust", releaseGroup: "product-a" },
                    { path: "b", component: "android-client", releaseType: "rust", releaseGroup: "product-a" },
                ],
                separatePullRequests: false,
            }));
            expect(config.separatePullRequests).toBe(false);
            expect(config.components[0].releaseGroup).toBe("product-a");
        });
    });
});
