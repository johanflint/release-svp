import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { PackageJson } from "../../../src/updaters/node/packageJson";
import { Version } from "../../../src/version";

const fixturesPath = "./test/fixtures";

describe("PackageJson", () => {
    const releaseVersion = Version.parse("1.2.3");
    const updater = new PackageJson(releaseVersion);

    it("updates the content", async () => {
        const oldPackageJson = readFileSync(resolve(fixturesPath, "./package.json"), "utf8").replace(/\r\n/g, "\n");
        const updatedPackageJson = updater.updateContent(oldPackageJson);

        await expect(updatedPackageJson).toMatchFileSnapshot("../../fixtures/package-snapshot.json");
    });

    it("only updates the top-level version, not an unrelated nested \"version\" key", () => {
        const content = `{
  "name": "package",
  "version": "0.1.0",
  "config": {
    "version": "should-not-change"
  }
}
`;

        const updatedContent = updater.updateContent(content);

        expect(updatedContent).toContain('"version": "1.2.3"');
        expect(updatedContent).toContain('"version": "should-not-change"');
    });

    it("throws if the content has no version field", () => {
        const content = `{
  "name": "package"
}
`;

        expect(() => updater.updateContent(content)).toThrow(/Expected a string at path version/);
    });

    it("throws if the version field is not a string", () => {
        const content = `{
  "name": "package",
  "version": 1
}
`;

        expect(() => updater.updateContent(content)).toThrow(/Expected a string at path version/);
    });

    it("returns an empty string if the content is undefined", () => {
        const updatedContent = updater.updateContent(undefined);
        expect(updatedContent).toBe("");
    });
});
