import { Commit } from "./commit";
import { Version } from "./version";

export function buildChangelog(commits: Commit[], notes: ChangelogNoteBuilder, newVersion: Version): string {
    const sectionsByType = commits.map(commit => notes.buildNote(commit, Object.keys(SECTION_HEADINGS), DEFAULT_SECTION))
        .filter(note => note !== null)
        .reduce<Record<string, string[]>>((changelog, entry) => ({
            ...changelog,
            [entry.type]: [...(changelog[entry.type] || []), entry.note],
        }), {});

    const date = new Date().toLocaleDateString('en-CA');
    let body = `## v${newVersion} (${date})\n`;

    for (const [type, heading] of Object.entries(SECTION_HEADINGS)) {
        const section = sectionsByType[type];
        if (!section) {
            continue;
        }

        body += `\n### ${heading}\n`;
        for (const note of section) {
            body += `\n- ${note}`;
        }
        body += "\n";
    }

    return body;
}

export interface ChangelogNoteBuilder {
    buildNote(commit: Commit, sections: string[], defaultSection: string): ChangelogEntry | null;
}

export interface ChangelogEntry {
    type: string;
    note: string;
}

const SECTION_HEADINGS: Record<string, string> = {
    feature: "Features",
    fix: "Bug Fixes",
    perf: "Performance Improvements",
    deps: "Dependencies",
    revert: "Reverts",
    docs: "Documentation",
    style: "Styles",
    chore: "Miscellaneous Chores",
    refactor: "Code Refactoring",
    test: "Tests",
    build: "Build System",
    ci: "Continuous Integration",
    other: "Other",
};

const DEFAULT_SECTION: keyof typeof SECTION_HEADINGS = "other";
