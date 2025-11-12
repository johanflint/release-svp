const VERSION_REGEX = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(-(?<preRelease>[^+]+))?(\+(?<build>.*))?/;

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