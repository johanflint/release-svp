import { describe, expect, it } from "vitest";
import { incrementPrereleaseIdentifier, isValidPrereleaseIdentifier, Version } from "../src/version";

describe("Version", () => {
   describe("parse", () => {
       it("accepts a semantic version", () => {
           const version = Version.parse("1.2.3");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBeUndefined();
           expect(version.build).toBeUndefined();
       });

       it("accepts a SNAPSHOT version", () => {
           const version = Version.parse("1.2.3-SNAPSHOT");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("SNAPSHOT");
           expect(version.build).toBeUndefined();
       });

       it("accepts a beta version", () => {
           const version = Version.parse("1.2.3-beta");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("beta");
           expect(version.build).toBeUndefined();
       });

       it("accepts a beta snapshot version", () => {
           const version = Version.parse("1.2.3-beta-SNAPSHOT");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("beta-SNAPSHOT");
           expect(version.build).toBeUndefined();
       });

       it("accepts a semantic version with a build number", () => {
           const version = Version.parse("1.2.3+456");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBeUndefined();
           expect(version.build).toBe("456");
       });

       it("accepts a semantic version with an alphanumeric build number", () => {
           const version = Version.parse("1.2.3+456abc");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBeUndefined();
           expect(version.build).toBe("456abc");
       });

       it("accepts a semantic version with pre-release and a build number", () => {
           const version = Version.parse("1.2.3-beta+456");

           expect(version.major).toBe(1);
           expect(version.minor).toBe(2);
           expect(version.patch).toBe(3);
           expect(version.preRelease).toBe("beta");
           expect(version.build).toBe("456");
       });

       it("throws for an invalid version number", () => {
           expect(() => Version.parse("1.2")).toThrow("Unable to parse version string: 1.2");
       });

       it("throws for a version with a leading prefix", () => {
           expect(() => Version.parse("junk1.2.3")).toThrow("Unable to parse version string: junk1.2.3");
       });

       it("throws for a version with a trailing suffix", () => {
           expect(() => Version.parse("1.2.3garbage")).toThrow("Unable to parse version string: 1.2.3garbage");
       });

       it("throws for a version with a dangling pre-release separator", () => {
           expect(() => Version.parse("1.2.3-")).toThrow("Unable to parse version string: 1.2.3-");
       });

       it("throws for a version with a dangling build separator", () => {
           expect(() => Version.parse("1.2.3+")).toThrow("Unable to parse version string: 1.2.3+");
       });

       it("throws for a version with a leading zero in a numeric component", () => {
           expect(() => Version.parse("01.2.3")).toThrow("Unable to parse version string: 01.2.3");
       });

       it("throws for a version with whitespace", () => {
           expect(() => Version.parse(" 1.2.3")).toThrow("Unable to parse version string:  1.2.3");
           expect(() => Version.parse("1.2.3 ")).toThrow("Unable to parse version string: 1.2.3 ");
       });
   });

    describe("toString", () => {
        it("returns a string without prefix", () => {
            const version = Version.parse("1.2.3-beta+456");

            expect(`${version}`).toBe("1.2.3-beta+456")
        });
    });
});

describe("isValidPrereleaseIdentifier", () => {
    it("accepts a bare word identifier", () => {
        expect(isValidPrereleaseIdentifier("beta")).toBe(true);
    });

    it("accepts a dot-separated identifier", () => {
        expect(isValidPrereleaseIdentifier("beta.1")).toBe(true);
        expect(isValidPrereleaseIdentifier("rc.9")).toBe(true);
    });

    it("accepts an alphanumeric identifier with a trailing number", () => {
        expect(isValidPrereleaseIdentifier("beta1")).toBe(true);
    });

    it("rejects an empty string", () => {
        expect(isValidPrereleaseIdentifier("")).toBe(false);
    });

    it("rejects a numeric identifier with a leading zero", () => {
        expect(isValidPrereleaseIdentifier("01")).toBe(false);
        expect(isValidPrereleaseIdentifier("beta.01")).toBe(false);
    });

    it("rejects an empty dot-separated segment", () => {
        expect(isValidPrereleaseIdentifier("rc..1")).toBe(false);
        expect(isValidPrereleaseIdentifier(".beta")).toBe(false);
        expect(isValidPrereleaseIdentifier("beta.")).toBe(false);
    });

    it("rejects whitespace", () => {
        expect(isValidPrereleaseIdentifier("beta 1")).toBe(false);
    });

    it("rejects characters outside the SemVer identifier alphabet", () => {
        expect(isValidPrereleaseIdentifier("beta+meta")).toBe(false);
        expect(isValidPrereleaseIdentifier("beta/1")).toBe(false);
    });
});

describe("incrementPrereleaseIdentifier", () => {
    it("appends '.1' when there is no trailing number", () => {
        expect(incrementPrereleaseIdentifier("beta")).toBe("beta.1");
    });

    it("increments a dot-separated trailing number", () => {
        expect(incrementPrereleaseIdentifier("beta.1")).toBe("beta.2");
        expect(incrementPrereleaseIdentifier("rc.9")).toBe("rc.10");
    });

    it("increments a directly-appended trailing number", () => {
        expect(incrementPrereleaseIdentifier("beta1")).toBe("beta2");
    });

    it("preserves zero-padding on the incremented number", () => {
        expect(incrementPrereleaseIdentifier("beta01")).toBe("beta02");
        expect(incrementPrereleaseIdentifier("beta.09")).toBe("beta.10");
    });

    it("appends '.1' when the identifier has no trailing digits at all", () => {
        expect(incrementPrereleaseIdentifier("alpha1beta")).toBe("alpha1beta.1");
    });
});