// The SemVer 2.0 grammar for a version's body (everything after any "v"/"[" prefix a caller may
// strip itself), without anchors — exported so other modules (e.g. release.ts, extracting a
// version out of a larger changelog heading) can match exactly the same valid-version substring
// instead of inventing their own looser pattern. Follows
// https://semver.org/#backusnaur-form-grammar-for-valid-semver-versions: no leading zeros in
// numeric identifiers, and pre-release/build metadata must be non-empty dot-separated identifiers.
export const VERSION_PATTERN_SOURCE = "(?<major>0|[1-9]\\d*)\\.(?<minor>0|[1-9]\\d*)\\.(?<patch>0|[1-9]\\d*)(?:-(?<preRelease>(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+(?<build>[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?";

// Anchored (^...$) so the whole string must match, e.g. "junk1.2.3" or "1.2.3-" are rejected
// rather than matched via an embedded substring.
const VERSION_REGEX = new RegExp(`^${VERSION_PATTERN_SOURCE}$`);

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