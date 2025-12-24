import init from "@rainbowatcher/toml-edit-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { CargoToml } from "../../../src/updaters/rust/cargoToml";
import { Version } from "../../../src/version";

const fixturesPath = "./test/fixtures";

describe("CargoToml", () => {
    const releaseVersion = Version.parse("1.2.3");
    const updater = new CargoToml(releaseVersion, "Cargo.toml");

    beforeEach(async () => await init());

    it("updates the content", async () => {
        const oldCargoToml = readFileSync(resolve(fixturesPath, "./Cargo.toml"), "utf8").replace(/\r\n/g, "\n")
        const updatedCargoToml = updater.updateContent(oldCargoToml);

        await expect(updatedCargoToml).toMatchFileSnapshot("../../fixtures/Cargo-snapshot.toml");
    });

    it("returns an empty string if the content is undefined", async () => {
        const updatedCargoToml = updater.updateContent(undefined);
        expect(updatedCargoToml).toBe("");
    })
});
