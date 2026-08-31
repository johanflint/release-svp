import { Version } from "./version";

// `componentPrefix` scopes matching to a single component's tags (e.g. "api-" so "api-v1.2.3" matches but
// "web-v1.2.3" and "v1.2.3" don't). Defaults to "" for the root component's unprefixed "v1.2.3" tags, which
// keeps single-project repositories backward compatible.
export function parseVersionTag(tagName: string, componentPrefix: string = ""): Version | undefined {
    const pattern = new RegExp(`^${escapeRegExp(componentPrefix)}(?<v>v)?(?<version>\\d+\\.\\d+\\.\\d+.*)$`);
    const match = tagName.match(pattern);
    if (match?.groups) {
        return Version.parse(match.groups["version"]);
    }

    return;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
