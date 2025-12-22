import { Version } from "./version";

const TAG_PATTERN = /^(?<v>v)?(?<version>\d+\.\d+\.\d+.*)$/;

export function parseVersionTag(tagName: string): Version | undefined {
    const match = tagName.match(TAG_PATTERN);
    if (match?.groups) {
        return Version.parse(match.groups["version"]);
    }

    return;
}
