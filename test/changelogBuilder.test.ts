import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildChangelog, ChangelogEntry, ChangelogNoteBuilder } from "../src/changelogBuilder";
import { Commit } from "../src/commit";
import { Version } from "../src/version";

describe("changelogBuilder", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        const date = new Date(2000, 8, 4, 13);
        vi.setSystemTime(date);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const version = Version.parse("1.2.3");

    test("creates a changelog header with version and date", () => {
        const notes: ChangelogNoteBuilder = {
            buildNote(): ChangelogEntry | null {
                return null;
            }
        };

        const result = buildChangelog([], notes, version);
        expect(result).toBe("## v1.2.3 (2000-09-04)\n");
    });

    test("groups notes by section type and renders headings in a fixed order", () => {
        const notes: ChangelogNoteBuilder = {
            buildNote(commit: Commit): ChangelogEntry | null {
                if (commit.sha === "a") {
                    return { type: "feature", note: "Add shiny thing" };
                }
                if (commit.sha === "b") {
                    return { type: "fix", note: "Fix broken thing" };
                }
                return null;
            }
        };

        const result = buildChangelog([commit("a"), commit("b")], notes, version);
        expect(result).toBe("## v1.2.3 (2000-09-04)\n" +
            "\n" +
            "### Features\n" +
            "\n" +
            "- Add shiny thing\n" +
            "\n" +
            "### Bug Fixes\n" +
            "\n" +
            "- Fix broken thing\n");
    });

    test("skips commits that do not produce a changelog entry", () => {
        const notes: ChangelogNoteBuilder = {
            buildNote(): ChangelogEntry | null {
                return null;
            }
        };

        const result = buildChangelog([commit("a"), commit("b")], notes, version);
        expect(result).toBe("## v1.2.3 (2000-09-04)\n");
    });

    test("renders multiple notes under the same section", () => {
        const notes: ChangelogNoteBuilder = {
            buildNote: () => ({ type: "feature", note: "Another feature" }),
        };

        const result = buildChangelog(
            [commit("a"), commit("b")],
            notes,
            version
        );

        const featureSection = result.split("### Features")[1];

        expect(featureSection).toContain("- Another feature");
        expect(featureSection.match(/- Another feature/g)?.length).toBe(2);
    });

    test("does not render empty sections", () => {
        const notes: ChangelogNoteBuilder = {
            buildNote: () => ({
                type: "docs",
                note: "Update README",
            }),
        };

        const result = buildChangelog([commit("a")], notes, version);

        expect(result).toContain("### Documentation");
        expect(result).not.toContain("### Features");
        expect(result).not.toContain("### Bug Fixes");
    });

    test("passes all section keys and default section to the note builder", () => {
        const buildNote = vi.fn().mockReturnValue(null);
        const notes: ChangelogNoteBuilder = { buildNote };

        buildChangelog([commit("a")], notes, version);

        expect(buildNote).toHaveBeenCalledWith(
            expect.any(Object),
            expect.arrayContaining([
                "feature",
                "fix",
                "perf",
                "other",
            ]),
            "other"
        );
    });
});

function commit(sha: string, message: string = "Message"): Commit {
    return {
        sha,
        message,
        isMergeCommit: false,
    };
}
