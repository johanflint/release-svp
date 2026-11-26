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

    it("throws when neither 'components' nor 'releaseGroups' declares a component", () => {
        const message = /'components' and 'releaseGroups' must declare at least one component between them/;
        expect(() => parseManifestConfig("{}")).toThrow(message);
        expect(() => parseManifestConfig(JSON.stringify({ components: [] }))).toThrow(message);
        expect(() => parseManifestConfig(JSON.stringify({ components: [], releaseGroups: [] }))).toThrow(message);
        expect(() => parseManifestConfig(JSON.stringify({ targetBranch: "" }))).toThrow(message);
    });

    it("throws when 'components' is present but not an array", () => {
        expect(() => parseManifestConfig(JSON.stringify({ components: {} }))).toThrow(/'components' must be an array when present/);
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
        }))).toThrow(/'releaseType' must be one of \[dart, node, rust\]/);
    });

    it("throws when 'component' contains invalid characters", () => {
        expect(() => parseManifestConfig(JSON.stringify({
            components: [{ path: "b", component: "project a/b", releaseType: "rust" }],
        }))).toThrow(/'component' must only contain letters, digits/);
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
        it.each([true, false])("throws when set to %s, since it was removed", value => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust" }],
                separatePullRequests: value,
            }))).toThrow(/'separatePullRequests' is no longer supported/);
        });
    });

    describe("releaseGroups", () => {
        const a = { path: "a", component: "project-a", releaseType: "rust" };
        const b = { path: "b", component: "project-b", releaseType: "rust" };
        const c = { path: "c", component: "project-c", releaseType: "rust" };

        it("is empty when absent", () => {
            const config = parseManifestConfig(JSON.stringify({ components: [a] }));
            expect(config.releaseGroups).toEqual([]);
        });

        it("parses release groups next to ungrouped components", () => {
            const config = parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a, b] }],
                components: [c],
            }));

            expect(config.releaseGroups).toEqual([{ name: "platform", components: [a, b] }]);
            expect(config.components).toEqual([c]);
        });

        it("accepts a config with only release groups", () => {
            const config = parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a, b] }],
            }));

            expect(config.releaseGroups).toHaveLength(1);
            expect(config.components).toEqual([]);
        });

        it("throws when not an array", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: {},
                components: [a],
            }))).toThrow(/'releaseGroups' must be an array when present/);
        });

        it("throws when an entry is not an object", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: ["platform"],
                components: [a],
            }))).toThrow(/releaseGroups\[0\]: expected an object/);
        });

        it("throws when 'name' is missing or empty", () => {
            for (const group of [{ components: [a, b] }, { name: "", components: [a, b] }]) {
                expect(() => parseManifestConfig(JSON.stringify({
                    releaseGroups: [group],
                }))).toThrow(/releaseGroups\[0\]: 'name' must be a non-empty string/);
            }
        });

        it("throws when 'name' contains invalid characters", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "plat form", components: [a, b] }],
            }))).toThrow(/releaseGroups\[0\]: 'name' must only contain letters, digits/);
        });

        it("throws when 'components' is missing", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform" }],
                components: [a],
            }))).toThrow(/releaseGroups\[0\]: 'components' must be an array/);
        });

        it("throws for an empty group", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [] }],
                components: [a],
            }))).toThrow(/releaseGroups\[0\]: a release group must have at least 2 components$/m);
        });

        it("throws for a group with one component, suggesting to move it to the top-level 'components'", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a] }],
            }))).toThrow(/releaseGroups\[0\]: a release group must have at least 2 components — move 'project-a' to the top-level 'components' \(merge or close this group's open release pull request first\)/);
        });

        it("omits the move hint when the group's only component is invalid", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [{ ...a, releaseType: "cobol" }] }],
            }))).toThrow(/releaseGroups\[0\]: a release group must have at least 2 components$/m);
        });

        it("throws for duplicate group names", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [
                    { name: "platform", components: [a, b] },
                    { name: "platform", components: [c, { path: "d", component: "project-d", releaseType: "rust" }] },
                ],
            }))).toThrow(/releaseGroups: duplicate release group name 'platform'/);
        });

        it.each([
            ["a grouped", { releaseGroups: [{ name: "project-a", components: [a, b] }] }],
            ["an ungrouped", { releaseGroups: [{ name: "project-c", components: [a, b] }], components: [c] }],
        ])("throws when a group name matches %s component's name", (_, config) => {
            expect(() => parseManifestConfig(JSON.stringify(config)))
                .toThrow(/releaseGroups: release group name 'project-[ac]' must not match a configured component name/);
        });

        it("throws for a component name used both in a group and at the top level", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a, b] }],
                components: [{ ...c, component: "project-a" }],
            }))).toThrow(/components\[0\]: duplicate component name 'project-a'/);
        });

        it("throws for a path used both in a group and at the top level", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a, b] }],
                components: [{ ...c, path: "b" }],
            }))).toThrow(/components\[0\]: duplicate path 'b'/);
        });

        it("throws for a component name used in two groups", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [
                    { name: "platform", components: [a, b] },
                    { name: "tools", components: [c, { ...a, path: "d" }] },
                ],
            }))).toThrow(/releaseGroups\[1\]\.components\[1\]: duplicate component name 'project-a'/);
        });

        it("reports a group member's issues at its location within the group", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a, { ...b, releaseType: "cobol" }] }],
            }))).toThrow(/releaseGroups\[0\]\.components\[1\]: 'releaseType' must be one of/);
        });

        it("validates 'migration' against grouped components too", () => {
            const config = parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a, b] }],
                components: [c],
                migration: {
                    cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01",
                    bootstrapVersions: { "project-a": "0.1.0", "project-b": "0.1.0", "project-c": "0.1.0" },
                },
            }));
            expect(config.migration?.bootstrapVersions).toEqual({ "project-a": "0.1.0", "project-b": "0.1.0", "project-c": "0.1.0" });

            expect(() => parseManifestConfig(JSON.stringify({
                releaseGroups: [{ name: "platform", components: [a, b] }],
                components: [c],
                migration: {
                    cutoverCommit: "abcdef0123456789abcdef0123456789abcdef01",
                    bootstrapVersions: { "project-a": "0.1.0", "project-c": "0.1.0" },
                },
            }))).toThrow(/'migration\.bootstrapVersions' is missing a starting version for component 'project-b'/);
        });

        it("throws when a component still sets the removed 'releaseGroup'", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ ...a, releaseGroup: "platform" }, b],
            }))).toThrow(/components\[0\]: 'releaseGroup' is no longer supported — move the component into a 'releaseGroups' entry instead/);
        });
    });

    describe("prereleaseType", () => {
        it("is undefined when absent", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust" }],
            }));
            expect(config.components[0].prereleaseType).toBeUndefined();
        });

        it("parses a bare word identifier", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", prereleaseType: "beta" }],
            }));
            expect(config.components[0].prereleaseType).toBe("beta");
        });

        it("parses a dot-separated identifier", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", prereleaseType: "rc.1" }],
            }));
            expect(config.components[0].prereleaseType).toBe("rc.1");
        });

        it("allows different components to have different (or no) pre-release identifiers", () => {
            const config = parseManifestConfig(JSON.stringify({
                components: [
                    { path: "a", component: "project-a", releaseType: "rust", prereleaseType: "beta" },
                    { path: "b", component: "project-b", releaseType: "rust", prereleaseType: "rc" },
                    { path: "c", component: "project-c", releaseType: "rust" },
                ],
            }));
            expect(config.components[0].prereleaseType).toBe("beta");
            expect(config.components[1].prereleaseType).toBe("rc");
            expect(config.components[2].prereleaseType).toBeUndefined();
        });

        it("throws when present but not a string", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", prereleaseType: 1 }],
            }))).toThrow(/'prereleaseType' must be a valid SemVer pre-release identifier/);
        });

        it("throws when present but empty", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", prereleaseType: "" }],
            }))).toThrow(/'prereleaseType' must be a valid SemVer pre-release identifier/);
        });

        it("throws when it has a leading zero in a numeric identifier", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", prereleaseType: "01" }],
            }))).toThrow(/'prereleaseType' must be a valid SemVer pre-release identifier/);
        });

        it("throws when it contains characters outside the SemVer identifier alphabet", () => {
            expect(() => parseManifestConfig(JSON.stringify({
                components: [{ path: "a", component: "project-a", releaseType: "rust", prereleaseType: "beta 1" }],
            }))).toThrow(/'prereleaseType' must be a valid SemVer pre-release identifier/);
        });
    });
});
