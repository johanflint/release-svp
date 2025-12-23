import init from "@rainbowatcher/toml-edit-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { CargoLock } from "../../../src/updaters/rust/cargoLock";
import { Version } from "../../../src/version";

const fixturesPath = "./test/fixtures";

describe("CargoLock", () => {
    const releaseVersion = Version.parse("1.2.3");
    const versionsMap = new Map<string, Version>([["package", releaseVersion]]);
    const updater = new CargoLock(versionsMap);

    it("updates the content", async () => {
        await init();

        const oldCargoLock = readFileSync(resolve(fixturesPath, "./Cargo.lock"), "utf8").replace(/\r\n/g, "\n")
        const updatedCargoLock = updater.updateContent(oldCargoLock);

        await expect(updatedCargoLock).toMatchFileSnapshot("../../fixtures/Cargo-snapshot.lock")
    });
});
