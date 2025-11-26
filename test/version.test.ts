import { describe, expect, test } from "vitest";
import { Version } from "../src/version";

describe("Version", () => {
   describe("parse", () => {
       test("accepts a semantic version", () => {
           const version = Version.parse("1.2.3");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBeUndefined();
           expect(version.build).toBeUndefined();
       });

       test("accepts a SNAPSHOT version", () => {
           const version = Version.parse("1.2.3-SNAPSHOT");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("SNAPSHOT");
           expect(version.build).toBeUndefined();
       });

       test("accepts a beta version", () => {
           const version = Version.parse("1.2.3-beta");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("beta");
           expect(version.build).toBeUndefined();
       });

       test("accepts a beta snapshot version", () => {
           const version = Version.parse("1.2.3-beta-SNAPSHOT");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("beta-SNAPSHOT");
           expect(version.build).toBeUndefined();
       });

       test("accepts a semantic version with a build number", () => {
           const version = Version.parse("1.2.3+456");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBeUndefined();
           expect(version.build).toBe("456");
       });

       test("accepts a semantic version with an alphanumeric build number", () => {
           const version = Version.parse("1.2.3+456abc");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBeUndefined();
           expect(version.build).toBe("456abc");
       });

       test("accepts a semantic version with pre-release and a build number", () => {
           const version = Version.parse("1.2.3-beta+456");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("beta");
           expect(version.build).toBe("456");
       });

       test("throws for an invalid version number", () => {
           expect(() => Version.parse("1.2")).toThrow("Unable to parse version string: 1.2");
       });
   });

    describe("toString", () => {
        test("returns a string without prefix", () => {
            const version = Version.parse("1.2.3-beta+456");

            expect(`${version}`).toBe("1.2.3-beta+456")
        });
    });
});