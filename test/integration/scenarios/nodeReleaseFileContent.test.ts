// Node counterpart to releaseFileContent.test.ts: confirms `prepare()`/`release()` actually rewrite
// `package.json`'s "version", `package-lock.json`'s root version fields (both the top-level "version" and
// `packages[""].version` — see updaters/node/packageLockJson.ts) and CHANGELOG.md's new entry, while leaving
// an unrelated dependency's own lockfile "version" untouched.
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, IntegrationHarness, mergeLabeledPullRequest, packageJson, packageLockJson } from "../harness";

describe("scenario: node release file content", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("bumps package.json, package-lock.json and CHANGELOG.md with the correct version and changelog entry", async () => {
        harness = await createHarness();
        const { state } = harness;

        state.seedCommit({
            message: "chore: initial commit",
            files: {
                "package.json": packageJson("root", "0.0.0"),
                "package-lock.json": packageLockJson("root", "0.0.0"),
            },
        });

        mergeLabeledPullRequest(state, {
            branch: "add-widget",
            files: { "src/widget.ts": "// a widget\n" },
            label: "feature",
            message: "Add a widget",
        });

        expect(await (await harness.createRunner("node")).prepare()).toBe(true);
        const pr = state.pullRequests.find(p => p.state === "open")!;

        // --- Content on the still-open release pull request's branch ---
        expect(state.getFileContent(pr.headBranch, "package.json")).toContain('"version": "0.1.0"');
        const prPackageLock = state.getFileContent(pr.headBranch, "package-lock.json")!;
        expect(JSON.parse(prPackageLock)).toMatchObject({
            version: "0.1.0",
            packages: {
                "": { version: "0.1.0" },
                "node_modules/left-pad": { version: "1.3.0" },
            },
        });
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
        expect(await (await harness.createRunner("node")).release()).toBe(true);

        expect(state.getFileContent(state.defaultBranch, "package.json")).toContain('"version": "0.1.0"');
        expect(JSON.parse(state.getFileContent(state.defaultBranch, "package-lock.json")!)).toMatchObject({
            version: "0.1.0",
            packages: {
                "": { version: "0.1.0" },
                "node_modules/left-pad": { version: "1.3.0" },
            },
        });
        expect(state.getFileContent(state.defaultBranch, "CHANGELOG.md")).toEqual(prChangelog);
    });
});
