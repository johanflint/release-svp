import { describe, expect, it } from "vitest";
import { ChangelogUpdater } from "../../src/changelogUpdater";
import { Github } from "../../src/github";
import { logger } from "../../src/logger";
import { DartStrategy } from "../../src/strategies/dart";
import { UpdateOptions } from "../../src/strategy";
import { PubspecYaml } from "../../src/updaters/dart/pubspecYaml";
import { Version } from "../../src/version";

describe("DartStrategy", () => {
    const github = new Github({ repo: "repo", owner: "owner" }, "token", logger);
    const strategy = new DartStrategy({ github });
    const updateOptions: UpdateOptions = {
        changelogEntry: "# 1.0.0",
        releaseVersion: Version.parse("1.0.0"),
        targetBranch: "main",
        isFirstRelease: false,
    };

    it("returns the changelog updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "CHANGELOG.md",
            createIfMissing: true,
            updater: expect.any(ChangelogUpdater),
        });
    });

    it("returns the pubspec.yaml updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "pubspec.yaml",
            createIfMissing: false,
            updater: expect.any(PubspecYaml),
        });
    });

    it("keeps the pubspec.yaml build number on the first release", async () => {
        const updates = await strategy.determineUpdates({ ...updateOptions, isFirstRelease: true });
        const pubspec = updates.find(update => update.path === "pubspec.yaml");
        expect(pubspec?.updater.updateContent("version: 0.0.0+1\n")).toBe("version: 1.0.0+1\n");
    });

    it("increments the pubspec.yaml build number after the first release", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        const pubspec = updates.find(update => update.path === "pubspec.yaml");
        expect(pubspec?.updater.updateContent("version: 0.9.0+1\n")).toBe("version: 1.0.0+2\n");
    });

    describe("with a component path", () => {
        const componentStrategy = new DartStrategy({ github, componentPath: "a" });

        it("prefixes the changelog path", async () => {
            const updates = await componentStrategy.determineUpdates(updateOptions);
            expect(updates).toContainEqual({
                path: "a/CHANGELOG.md",
                createIfMissing: true,
                updater: expect.any(ChangelogUpdater),
            });
        });

        it("prefixes the pubspec.yaml path", async () => {
            const updates = await componentStrategy.determineUpdates(updateOptions);
            expect(updates).toContainEqual({
                path: "a/pubspec.yaml",
                createIfMissing: false,
                updater: expect.any(PubspecYaml),
            });
        });
    });
});
