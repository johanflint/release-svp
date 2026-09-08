// Confirms `prepare()`/`release()` actually rewrite release-file *content* correctly (Cargo.toml's
// `package.version`, Cargo.lock's matching package entry, and CHANGELOG.md's new entry) — every other scenario
// test only asserts on pull request titles/labels/tags/releases, never on the file content those pull requests
// actually carry, so a content-generation bug (wrong TOML path, wrong changelog section, etc.) could regress
// silently despite full coverage everywhere else.
import { afterEach, describe, expect, it } from "vitest";
import { cargoLock, cargoToml, createHarness, IntegrationHarness, mergeLabeledPullRequest } from "../harness";

describe("scenario: release file content", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("bumps Cargo.toml, Cargo.lock and CHANGELOG.md with the correct version and changelog entry", async () => {
        harness = await createHarness();
        const { state } = harness;

        state.seedCommit({
            message: "chore: initial commit",
            files: {
                "Cargo.toml": cargoToml("root", "0.0.0"),
                "Cargo.lock": cargoLock("root", "0.0.0"),
            },
        });

        mergeLabeledPullRequest(state, {
            branch: "add-widget",
            files: { "src/widget.rs": "// a widget\n" },
            label: "feature",
            message: "Add a widget",
        });

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        const pr = state.pullRequests.find(p => p.state === "open")!;

        // --- Content on the still-open release pull request's branch ---
        expect(state.getFileContent(pr.headBranch, "Cargo.toml")).toContain('version = "0.1.0"');
        expect(state.getFileContent(pr.headBranch, "Cargo.lock")).toContain('version = "0.1.0"');
        const prChangelog = state.getFileContent(pr.headBranch, "CHANGELOG.md")!;
        expect(prChangelog).toContain("# Changelog");
        expect(prChangelog).toContain("## v0.1.0");
        expect(prChangelog).toContain("### Features");
        // The changelog note is the *merge* commit's message (see PullRequestChangelogNoteBuilder), which
        // fakeGithub's `mergePullRequest` derives from the feature branch's name, not the pull request's own
        // title/message — this confirms the real merge-commit-driven note text made it all the way to disk.
        expect(prChangelog).toContain("add-widget");

        // --- Same content lands on the default branch once the release pull request is merged ---
        state.mergePullRequest(pr.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.getFileContent(state.defaultBranch, "Cargo.toml")).toContain('version = "0.1.0"');
        expect(state.getFileContent(state.defaultBranch, "Cargo.lock")).toContain('version = "0.1.0"');
        expect(state.getFileContent(state.defaultBranch, "CHANGELOG.md")).toEqual(prChangelog);
    });
});
