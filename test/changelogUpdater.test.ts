import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { ChangelogUpdater } from "../src/changelogUpdater";

const fixturesPath = "./test/fixtures";

describe("updateContent", () => {
    const changelogEntry = `### 0.3.0 (2025-08-08)\n\n### Bug Fixes\n- New fix\n`;
    const updater = new ChangelogUpdater(changelogEntry);

    it("inserts content at the right location if CHANGELOG exists", () => {
        const oldChangelog = readFileSync(resolve(fixturesPath, "./CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");
        const expectedChangelog = readFileSync(resolve(fixturesPath, "./CHANGELOG-updated.md"), "utf8").replace(/\r\n/g, "\n");

        const changelogEntry = `### 0.3.0 (2025-08-08)\n\n### Bug Fixes\n- New fix\n`;
        const updatedChangelog = updater.updateContent(oldChangelog);

        expect(updatedChangelog).toBe(expectedChangelog);
    });

    it("creates content if no CHANGELOG exists", () => {
        const changelogEntry = `### 0.3.0 (2025-08-08)\n\n### Bug Fixes\n- New fix\n`;
        const updatedChangelog = updater.updateContent("");

        const expectedChangelog = readFileSync(resolve(fixturesPath, "./CHANGELOG-new.md"), "utf8").replace(/\r\n/g, "\n");
        expect(updatedChangelog).toBe(expectedChangelog);
    });

    it("prepends content if a different style is found", () => {
        const oldChangelog = readFileSync(resolve(fixturesPath, "./CHANGELOG-non-conforming.md"), "utf8").replace(/\r\n/g, "\n");
        const expectedChangelog = readFileSync(resolve(fixturesPath, "./CHANGELOG-non-conforming-updated.md"), "utf8").replace(/\r\n/g, "\n");

        const changelogEntry = `### 0.3.0 (2025-08-08)\n\n### Bug Fixes\n- New fix\n`;
        const updatedChangelog = updater.updateContent(oldChangelog);

        expect(updatedChangelog).toBe(expectedChangelog);
    });
});
