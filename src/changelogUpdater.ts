const DEFAULT_VERSION_HEADER_REGEX = '\n###? v?[0-9[]';

const HEADER = "# Changelog\n";

export function updateContent(content: string | undefined, changelogEntry: string): string {
    content = content || "";

    const index = content.search(DEFAULT_VERSION_HEADER_REGEX);
    if (index === -1) {
        if (content) {
            return `${HEADER}\n${changelogEntry}\n${content}`;
        }
        return `${HEADER}\n${changelogEntry}`;
    } else {
        const before = content.slice(0, index);
        const after = content.slice(index);
        const result = `${before}\n${changelogEntry}${after}`.trim();
        return result.replace(/\n*$/, "") + "\n";
    }
}
