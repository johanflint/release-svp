import { describe, expect, it } from "vitest";
import { PubspecYaml } from "../../../src/updaters/dart/pubspecYaml";
import { Version } from "../../../src/version";

function update(releaseVersion: string, content: string | undefined): string {
    return new PubspecYaml(Version.parse(releaseVersion)).updateContent(content);
}

describe("PubspecYaml", () => {
    it("replaces the version and leaves the rest of the file untouched", () => {
        const content = "# My app\nname: my_app\nversion: 1.2.3\n\ndependencies:\n  http: ^1.0.0\n";
        expect(update("1.3.0", content)).toBe("# My app\nname: my_app\nversion: 1.3.0\n\ndependencies:\n  http: ^1.0.0\n");
    });

    it("keeps quotes and a trailing comment", () => {
        expect(update("1.3.0", "version: \"1.2.3\" # current\n")).toBe("version: \"1.3.0\" # current\n");
        expect(update("1.3.0", "version: '1.2.3'\n")).toBe("version: '1.3.0'\n");
    });

    it("keeps CRLF line endings", () => {
        expect(update("1.3.0", "name: a\r\nversion: 1.2.3\r\n")).toBe("name: a\r\nversion: 1.3.0\r\n");
    });

    it("only updates the top-level version", () => {
        const content = "version: 1.2.3\ndependencies:\n  foo:\n    version: 1.0.0\n";
        expect(update("2.0.0", content)).toBe("version: 2.0.0\ndependencies:\n  foo:\n    version: 1.0.0\n");
    });

    it("writes a pre-release version", () => {
        expect(update("1.3.0-rc.1", "version: 1.2.3\n")).toBe("version: 1.3.0-rc.1\n");
    });

    it("replaces a pre-release version", () => {
        expect(update("1.3.0", "version: 1.3.0-rc.1\n")).toBe("version: 1.3.0\n");
    });

    describe("build number", () => {
        it("increments a numeric build number", () => {
            expect(update("1.3.0", "version: 1.2.3+4\n")).toBe("version: 1.3.0+5\n");
        });

        it("increments the build number of a pre-release version", () => {
            expect(update("1.3.0", "version: 1.3.0-rc.1+7\n")).toBe("version: 1.3.0+8\n");
        });

        it("keeps a non-numeric build", () => {
            expect(update("1.3.0", "version: 1.2.3+abc\n")).toBe("version: 1.3.0+abc\n");
        });

        it("does not add a build number when there was none", () => {
            expect(update("1.3.0", "version: 1.2.3\n")).toBe("version: 1.3.0\n");
        });

        it("ignores the build of the release version", () => {
            expect(update("1.3.0+9", "version: 1.2.3+4\n")).toBe("version: 1.3.0+5\n");
            expect(update("1.3.0+9", "version: 1.2.3\n")).toBe("version: 1.3.0\n");
        });
    });

    it("throws if there is no top-level version", () => {
        expect(() => update("1.3.0", "name: my_app\n")).toThrow("Expected a top-level 'version' field in pubspec.yaml");
        expect(() => update("1.3.0", "  version: 1.2.3\n")).toThrow("Expected a top-level 'version' field in pubspec.yaml");
    });

    it("returns an empty string if the content is undefined or empty", () => {
        expect(update("1.3.0", undefined)).toBe("");
        expect(update("1.3.0", "")).toBe("");
    });
});
