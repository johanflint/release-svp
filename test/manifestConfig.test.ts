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
});
