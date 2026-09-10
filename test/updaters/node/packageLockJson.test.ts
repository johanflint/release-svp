import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { PackageLockJson } from "../../../src/updaters/node/packageLockJson";
import { Version } from "../../../src/version";

const fixturesPath = "./test/fixtures";

describe("PackageLockJson", () => {
    const releaseVersion = Version.parse("1.2.3");
    const updater = new PackageLockJson(releaseVersion);

    it("updates the content", async () => {
        const oldPackageLockJson = readFileSync(resolve(fixturesPath, "./package-lock.json"), "utf8").replace(/\r\n/g, "\n");
        const updatedPackageLockJson = updater.updateContent(oldPackageLockJson);

        await expect(updatedPackageLockJson).toMatchFileSnapshot("../../fixtures/package-lock-snapshot.json");
    });

    it("updates both root version fields but leaves dependency versions untouched (lockfileVersion 2/3)", () => {
        const content = `{
  "name": "package",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "package",
      "version": "0.1.0"
    },
    "node_modules/dep": {
      "version": "2.3.4"
    }
  }
}
`;

        const updatedContent = updater.updateContent(content);

        expect(JSON.parse(updatedContent)).toMatchObject({
            version: "1.2.3",
            packages: {
                "": { version: "1.2.3" },
                "node_modules/dep": { version: "2.3.4" },
            },
        });
    });

    it("only updates the root version field for lockfileVersion 1", () => {
        const content = `{
  "name": "package",
  "version": "0.1.0",
  "lockfileVersion": 1,
  "dependencies": {
    "dep": {
      "version": "2.3.4"
    }
  }
}
`;

        const updatedContent = updater.updateContent(content);

        expect(JSON.parse(updatedContent)).toMatchObject({
            version: "1.2.3",
            dependencies: { dep: { version: "2.3.4" } },
        });
    });

    it("throws for an unsupported lockfileVersion", () => {
        const content = `{
  "name": "package",
  "version": "0.1.0",
  "lockfileVersion": 4
}
`;

        expect(() => updater.updateContent(content)).toThrow(/Unsupported package-lock.json lockfileVersion: 4/);
    });

    it("throws if packages[\"\"].version is missing for lockfileVersion 2/3", () => {
        const content = `{
  "name": "package",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "package"
    }
  }
}
`;

        expect(() => updater.updateContent(content)).toThrow(/Expected a string at path packages\.\.version/);
    });

    it("returns an empty string if the content is undefined", () => {
        const updatedContent = updater.updateContent(undefined);
        expect(updatedContent).toBe("");
    });
});
