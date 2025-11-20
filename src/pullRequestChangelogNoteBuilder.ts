import { ChangelogEntry, ChangelogNoteBuilder } from "./changelogBuilder";
import { Commit } from "./commit";

export class PullRequestChangelogNoteBuilder implements ChangelogNoteBuilder {
    buildNote(commit: Commit, sections: string[], defaultSection: string): ChangelogEntry | null {
        const pullRequest = commit.pullRequest;
        // Only keep the merge pull requests
        if (!pullRequest || pullRequest.sha !== pullRequest.mergeCommitOid) {
            return null;
        }

        const label = pullRequest.labels.find(label => sections.includes(label));
        const note = linkPullRequestReference(commit.message.split('\n')[0], commit.pullRequest!.permalink)
        return {
            type: label ?? defaultSection,
            note,
        };
    }
}

function linkPullRequestReference(
    text: string,
    permalink: string,
): string {
    return text.replace(
        /\(#(\d+)\)/,
        `([#$1](${permalink}))`
    );
}
