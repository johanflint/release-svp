// The SemVer 2.0 grammar for a single dot-separated run of pre-release identifiers (e.g. "beta", "beta.1",
// "rc.2") — without anchors, exported so it can be reused both inside `VERSION_PATTERN_SOURCE` below and
// wherever a pre-release identifier is validated/parsed on its own (e.g. a `prereleaseType` config value, see
// manifestConfig.ts). Follows https://semver.org/#backusnaur-form-grammar-for-valid-semver-versions: no leading
// zeros in purely-numeric identifiers.
export const PRERELEASE_IDENTIFIER_PATTERN_SOURCE = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*";

// The SemVer 2.0 grammar for a version's body (everything after any "v"/"[" prefix a caller may
// strip itself), without anchors — exported so other modules (e.g. release.ts, extracting a
// version out of a larger changelog heading) can match exactly the same valid-version substring
// instead of inventing their own looser pattern.
export const VERSION_PATTERN_SOURCE = `(?<major>0|[1-9]\\d*)\\.(?<minor>0|[1-9]\\d*)\\.(?<patch>0|[1-9]\\d*)(?:-(?<preRelease>${PRERELEASE_IDENTIFIER_PATTERN_SOURCE}))?(?:\\+(?<build>[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?`;

// Anchored (^...$) so the whole string must match, e.g. "junk1.2.3" or "1.2.3-" are rejected
// rather than matched via an embedded substring.
const VERSION_REGEX = new RegExp(`^${VERSION_PATTERN_SOURCE}$`);
const PRERELEASE_IDENTIFIER_REGEX = new RegExp(`^${PRERELEASE_IDENTIFIER_PATTERN_SOURCE}$`);

// Validates a standalone pre-release identifier (e.g. a `prereleaseType` config value like "beta" or "rc.1"),
// without requiring a full "major.minor.patch-identifier" version string around it.
export function isValidPrereleaseIdentifier(value: string): boolean {
    return PRERELEASE_IDENTIFIER_REGEX.test(value);
}

// Bumps the trailing numeric run of a pre-release identifier, appending ".1" when there isn't one yet, e.g.
// "beta" -> "beta.1", "beta.1" -> "beta.2", "beta1" -> "beta2", "beta01" -> "beta02" (zero-padding preserved).
// Used to continue an already-started pre-release train (see versioningStrategy.ts) without ever needing a
// human to bump the identifier by hand.
export function incrementPrereleaseIdentifier(identifier: string): string {
    const match = identifier.match(/^(?<prefix>.*?)(?<number>\d+)$/);
    if (!match?.groups) {
        return `${identifier}.1`;
    }

    const { prefix, number } = match.groups;
    const incremented = (BigInt(number) + 1n).toString().padStart(number.length, "0");
    return `${prefix}${incremented}`;
}

export class Version {
    static unreleased: Version = new Version(0, 0, 0);

    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly preRelease?: string;
    readonly build?: string;

    constructor(
        major: number,
        minor: number,
        patch: number,
        preRelease?: string,
        build?: string
    ) {
        this.major = major;
        this.minor = minor;
        this.patch = patch;
        this.preRelease = preRelease;
        this.build = build;
    }

    static parse(versionString: string): Version {
        const match = versionString.match(VERSION_REGEX);
        if (!match?.groups) {
            throw Error(`Unable to parse version string: ${versionString}`);
        }

        const major = Number(match.groups.major);
        const minor = Number(match.groups.minor);
        const patch = Number(match.groups.patch);
        const preRelease = match.groups.preRelease;
        const build = match.groups.build;
        return new Version(major, minor, patch, preRelease, build);
    }

    toString(): string {
        const preReleasePart = this.preRelease ? `-${this.preRelease}` : '';
        const buildPart = this.build ? `+${this.build}` : '';
        return `${this.major}.${this.minor}.${this.patch}${preReleasePart}${buildPart}`;
    }
}