import { GitHubFileContents } from "@google-automations/git-file-utils";

export interface Update {
    cachedFileContents?: GitHubFileContents;
    createIfMissing: boolean;
    path: string;
    updater: Updater;
}

export interface Updater {
    updateContent(content: string | undefined): string;
}
