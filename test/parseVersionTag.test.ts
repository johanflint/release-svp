import { describe, it, test } from "vitest";
import { parseVersionTag } from "../src/parseVersionTag";
import { Version } from "../src/version";

describe("parseVersionTag", () => {
    const cases = [
        { input: "1.2.3", expected: new Version(1, 2, 3) },
        { input: "1.2.3-beta", expected: new Version(1, 2, 3, "beta") },
        { input: "1.2.3-beta+45", expected: new Version(1, 2, 3, "beta", "45") },
        { input: "v1.2.3-beta+45", expected: new Version(1, 2, 3, "beta", "45") },
    ]
    test.for(cases)("parses valid version $input", ({ input, expected }, { expect }) => {
        expect(parseVersionTag(input)).toEqual(expected);
    });

    it("parses a version prefixed with v", ({ expect }) => {
        expect(parseVersionTag("v1.2.3-beta+45")).toEqual(new Version(1, 2, 3, "beta", "45"));
    });

    it("returns undefined otherwise", ({ expect }) => {
        expect(parseVersionTag("my-tag")).toEqual(undefined);
    });

    describe("with a component prefix", () => {
        it("parses a tag matching the component prefix", ({ expect }) => {
            expect(parseVersionTag("api-v1.2.3", "api-")).toEqual(new Version(1, 2, 3));
        });

        it("returns undefined for the unprefixed (root) tag format", ({ expect }) => {
            expect(parseVersionTag("v1.2.3", "api-")).toEqual(undefined);
        });

        it("returns undefined for another component's tag", ({ expect }) => {
            expect(parseVersionTag("web-v1.2.3", "api-")).toEqual(undefined);
        });

        it("does not match a component whose name is a prefix of another component's tag", ({ expect }) => {
            expect(parseVersionTag("api-v2-v1.2.3", "api-")).toEqual(undefined);
        });

        it("does not match a root tag when no component prefix is given", ({ expect }) => {
            expect(parseVersionTag("api-v1.2.3")).toEqual(undefined);
        });
    });
});
