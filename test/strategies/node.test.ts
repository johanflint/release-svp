import { describe, expect, it } from "vitest";
import { ChangelogUpdater } from "../../src/changelogUpdater";
import { Github } from "../../src/github";
import { logger } from "../../src/logger";
import { NodeStrategy } from "../../src/strategies/node";
import { UpdateOptions } from "../../src/strategy";
import { PackageJson } from "../../src/updaters/node/packageJson";
import { PackageLockJson } from "../../src/updaters/node/packageLockJson";
import { Version } from "../../src/version";

describe("NodeStrategy", () => {
    const github = new Github({ repo: "repo", owner: "owner" }, "token", logger)
    const strategy = new NodeStrategy({ github });
    const updateOptions: UpdateOptions = {
        changelogEntry: "# 1.0.0",
        releaseVersion: Version.parse("1.0.0"),
        targetBranch: "main",
    };

    it("returns the changelog updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "CHANGELOG.md",
            createIfMissing: true,
            updater: expect.any(ChangelogUpdater),
        });
    });

    it("returns the package.json updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "package.json",
            createIfMissing: false,
            updater: expect.any(PackageJson),
        });
    });

    it("returns the package-lock.json updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "package-lock.json",
            createIfMissing: false,
            updater: expect.any(PackageLockJson),
        });
    });

    describe("with a component path", () => {
        const componentStrategy = new NodeStrategy({ github, componentPath: "a" });

        it("prefixes the changelog path", async () => {
            const updates = await componentStrategy.determineUpdates(updateOptions);
            expect(updates).toContainEqual({
                path: "a/CHANGELOG.md",
                createIfMissing: true,
                updater: expect.any(ChangelogUpdater),
            });
        });

        it("prefixes the package.json path", async () => {
            const updates = await componentStrategy.determineUpdates(updateOptions);
            expect(updates).toContainEqual({
                path: "a/package.json",
                createIfMissing: false,
                updater: expect.any(PackageJson),
            });
        });

        it("prefixes the package-lock.json path", async () => {
            const updates = await componentStrategy.determineUpdates(updateOptions);
            expect(updates).toContainEqual({
                path: "a/package-lock.json",
                createIfMissing: false,
                updater: expect.any(PackageLockJson),
            });
        });
    });
});
