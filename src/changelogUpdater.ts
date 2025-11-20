import { Updater } from "./update";

const DEFAULT_VERSION_HEADER_REGEX = '\n###? v?[0-9[]';

const HEADER = "# Changelog\n";

export class ChangelogUpdater implements Updater {
    constructor(private readonly changelogEntry: string) {}

    updateContent(content: string | undefined): string {
        content = content || "";

        const index = content.search(DEFAULT_VERSION_HEADER_REGEX);
        if (index === -1) {
            if (content) {
                return `${HEADER}\n${this.changelogEntry}\n${content}`;
            }
            return `${HEADER}\n${this.changelogEntry}`;
        } else {
            const before = content.slice(0, index);
            const after = content.slice(index);
            const result = `${before}\n${this.changelogEntry}${after}`.trim();
            return result.replace(/\n*$/, "") + "\n";
        }
    }

}
