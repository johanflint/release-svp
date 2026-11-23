import { Updater } from "../../update";
import { Version } from "../../version";

const VERSION_LINE = /^(version:[ \t]*)(["']?)([^\s"'#]+)\2([ \t]*(?:#.*)?)$/m;

export class PubspecYaml implements Updater {
    constructor(private readonly releaseVersion: Version, private readonly isFirstRelease: boolean) {}

    updateContent(content: string | undefined): string {
        if (!content) {
            return "";
        }

        const match = VERSION_LINE.exec(content);
        if (!match) {
            throw new Error("Expected a top-level 'version' field in pubspec.yaml");
        }

        const [, key, quote, oldValue, tail] = match;
        const buildNumber = this.nextBuildNumber(oldValue.split("+")[1]); // Build is whatever follows the first "+"

        // The release version's own build is ignored: the build number is owned by pubspec.yaml
        const { major, minor, patch, preRelease } = this.releaseVersion;
        const version = `${major}.${minor}.${patch}${preRelease ? `-${preRelease}` : ""}`;

        return content.replace(VERSION_LINE, () => `${key}${quote}${version}${buildNumber}${quote}${tail}`);
    }

    // App stores require the build number to go up with every upload, across versions. The first release ships
    // the build declared in pubspec.yaml as-is (so it can be set to continue from an already-published app);
    // every release after that increments it. A non-numeric build is left alone.
    private nextBuildNumber(oldBuildNumber: string | undefined): string {
        if (oldBuildNumber === undefined) {
            return "";
        }
        // Respect the build number for first releases (new app or app already in the store but not tagged)
        if (this.isFirstRelease) {
            return `+${oldBuildNumber}`;
        }
        // Respect any non-numeric build numbers
        if (!/^\d+$/.test(oldBuildNumber)) {
            return `+${oldBuildNumber}`;
        }
        return `+${parseInt(oldBuildNumber, 10) + 1}`;
    }
}
