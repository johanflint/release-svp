// A single-project repository (no release-svp-config.json, one implicit root component) going through a full, realistic
// lifecycle:
//   1. Bootstrap: first-ever release, computed from the repository's full history (no prior tag).
//   2. Incremental: a further merged change produces a second, independent release on top of the first.
//   3. Idempotency: rerunning `prepare()`/`release()` with nothing new to do is a safe no-op — no duplicate
//      pull requests, releases, or tags, and no error.
//
// This exercises the harness (test/integration/harness.ts) against a real `ManifestRunner`, `Manifest` and
// `Github` — the only thing faked is the GitHub API itself (test/integration/fakeGithub).
import { afterEach, describe, expect, it } from "vitest";
import { pendingLabel, taggedLabel } from "../../../src/componentNaming";
import { cargoToml, createHarness, IntegrationHarness, mergeLabeledPullRequest } from "../harness";

describe("scenario: single component lifecycle", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("bootstraps an initial release, then produces an incremental release, then is idempotent when rerun with nothing new", async () => {
        harness = await createHarness();
        const { state } = harness;

        state.seedCommit({ message: "chore: initial commit", files: { "Cargo.toml": cargoToml("root", "0.0.0") } });

        // --- 1. Bootstrap release ---
        mergeLabeledPullRequest(state, {
            branch: "add-widget",
            files: { "src/widget.rs": "// a widget\n" },
            label: "feat",
            message: "Add a widget",
        });

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        const openAfterFirstPrepare = state.pullRequests.filter(pr => pr.state === "open");
        expect(openAfterFirstPrepare).toHaveLength(1);
        const firstPr = openAfterFirstPrepare[0];
        expect(firstPr.title).toContain("0.1.0"); // "feat" against the unreleased baseline (0.0.0) bumps minor
        expect(firstPr.labels).toEqual([pendingLabel("")]);

        state.mergePullRequest(firstPr.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.releases).toHaveLength(1);
        expect(state.releases[0].tagName).toBe("v0.1.0");
        expect(state.tags.has("v0.1.0")).toBe(true);
        expect(state.getPullRequestOrThrow(firstPr.number).labels).toEqual([taggedLabel("")]);

        // --- 2. Incremental release ---
        mergeLabeledPullRequest(state, {
            branch: "fix-widget",
            files: { "src/widget.rs": "// a widget, fixed\n" },
            label: "fix",
            message: "Correct the widget rendering",
        });

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        const openAfterSecondPrepare = state.pullRequests.filter(pr => pr.state === "open");
        expect(openAfterSecondPrepare).toHaveLength(1);
        const secondPr = openAfterSecondPrepare[0];
        expect(secondPr.title).toContain("0.1.1"); // "fix" against v0.1.0 bumps patch only

        state.mergePullRequest(secondPr.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.releases).toHaveLength(2);
        expect(state.releases[1].tagName).toBe("v0.1.1");
        expect(state.getPullRequestOrThrow(secondPr.number).labels).toEqual([taggedLabel("")]);

        // --- 3. Idempotency: rerunning prepare()/release() with nothing new is a safe no-op ---
        const pullRequestCountBeforeRerun = state.pullRequests.length;

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        expect(state.pullRequests.filter(pr => pr.state === "open")).toHaveLength(0);
        expect(state.pullRequests).toHaveLength(pullRequestCountBeforeRerun); // no new pull request was opened

        expect(await (await harness.createRunner("rust")).release()).toBe(true);
        expect(state.releases).toHaveLength(2); // no new release/tag was created
    });
});
