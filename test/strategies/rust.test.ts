import { GitHubFileContents } from "@google-automations/git-file-utils";
import init from "@rainbowatcher/toml-edit-js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChangelogUpdater } from "../../src/changelogUpdater";
import { Github } from "../../src/github";
import { logger } from "../../src/logger";
import { RustStrategy } from "../../src/strategies/rust";
import { UpdateOptions } from "../../src/strategy";
import { CargoLock } from "../../src/updaters/rust/cargoLock";
import { CargoToml } from "../../src/updaters/rust/cargoToml";
import { Version } from "../../src/version";

vi.mock("../../src/strategy", () => {
    const methods = ['getData', 'saveData'];
    return {
        MyService: vi.fn().mockImplementation(() => {
            const mockObj: any = {};
            methods.forEach(m => mockObj[m] = vi.fn());
            return mockObj;
        })
    };
});
vi.mock("../../src/updaters/rust/cargoLock", () => ({
    CargoLock: vi.fn(),
}));


describe("RustStrategy", () => {
    const github = new Github({ repo: "repo", owner: "owner" }, "token", logger)
    const strategy = new RustStrategy({ github });
    const updateOptions: UpdateOptions = {
        changelogEntry: "# 1.0.0",
        releaseVersion: Version.parse("1.0.0"),
        targetBranch: "main",
    };

    beforeEach(async () => {
        await init();

        const response: GitHubFileContents = {
            sha: "",
            content: "",
            parsedContent: "[package]\nname = 'my-package'\n",
            mode: ""
        }
        vi.spyOn(github, "retrieveFileContents").mockResolvedValue(response);
    });

    test("returns the changelog updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "CHANGELOG.md",
            createIfMissing: true,
            updater: expect.any(ChangelogUpdater),
        });
    });

    test("returns the Cargo.toml updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "Cargo.toml",
            createIfMissing: false,
            updater: expect.any(CargoToml),
        });
    });

    test("returns the Cargo.lock updater", async () => {
        const updates = await strategy.determineUpdates(updateOptions);
        expect(updates).toContainEqual({
            path: "Cargo.lock",
            createIfMissing: false,
            updater: expect.any(CargoLock),
        });

        const versionsMap = new Map([["my-package", updateOptions.releaseVersion]]);
        expect(CargoLock).toHaveBeenCalledWith(versionsMap);
    });
});
