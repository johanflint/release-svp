import { Updater } from "../../update";
import { Version } from "../../version";

const VERSION_LINE = /^(version:[ \t]*)(["']?)([^\s"'#]+)\2([ \t]*(?:#.*)?)$/m;

export class PubspecYaml implements Updater {
    constructor(private readonly releaseVersion: Version) {}

    updateContent(content: string | undefined): string {
        if (!content) {
            return "";
        }

        const match = VERSION_LINE.exec(content);
        if (!match) {
            throw new Error("Expected a top-level 'version' field in pubspec.yaml");
        }

        const [, key, quote, oldValue, tail] = match;
        const oldBuildNumber = oldValue.split("+")[1]; // Build metadata is whatever follows the first "+"
        const buildNumber = oldBuildNumber === undefined ? "" : /^\d+$/.test(oldBuildNumber) ? `+${parseInt(oldBuildNumber, 10) + 1}` : `+${oldBuildNumber}`;

        // The release version's own build is ignored: the build number is owned by pubspec.yaml
        const { major, minor, patch, preRelease } = this.releaseVersion;
        const version = `${major}.${minor}.${patch}${preRelease ? `-${preRelease}` : ""}`;

        return content.replace(VERSION_LINE, () => `${key}${quote}${version}${buildNumber}${quote}${tail}`);
    }
}
