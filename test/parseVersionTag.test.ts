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
});
