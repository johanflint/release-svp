import { describe, expect, test } from "vitest";
import { Version } from "../src/version";
import { MajorVersionUpdate, MinorVersionUpdate, PatchVersionUpdate } from "../src/versioningStrategy";

describe("MajorVersionUpdate", () => {
    test("bumps the major version", () => {
        const version = new MajorVersionUpdate().bump(Version.parse("0.1.2"));
        expect(version).toStrictEqual(Version.parse("1.0.0"));
    });
});

describe("MinorVersionUpdate", () => {
    test("bumps the minor version", () => {
        const version = new MinorVersionUpdate().bump(Version.parse("0.1.2"));
        expect(version).toStrictEqual(Version.parse("0.2.0"));
    });
});

describe("PatchVersionUpdate", () => {
    test("bumps the patch version", () => {
        const version = new PatchVersionUpdate().bump(Version.parse("0.1.2"));
        expect(version).toStrictEqual(Version.parse("0.1.3"));
    });
});
