// Smoke test for harness.ts itself: drives a real `ManifestRunner` end to end (prepare → merge → release, then
// a second prepare → merge → release cycle) against the fake GitHub server for the simplest possible fixture
// (single-project mode, no config file, one implicit root component) — the same shape scenario 1's full test
// (bootstrap + incremental + idempotency) will build on. This test's job is just to prove the harness's wiring
// is correct; scenario-level assertions and idempotency checks live in the dedicated scenario test files.
import { afterEach, describe, expect, it } from "vitest";
import { cargoToml, createHarness, IntegrationHarness, mergeLabeledPullRequest } from "./harness";

describe("integration test harness", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("drives a single-project bootstrap release, then an incremental release, through the real ManifestRunner", async () => {
        harness = await createHarness();
        const { state } = harness;

        state.seedCommit({ message: "chore: initial commit", files: { "Cargo.toml": cargoToml("root", "0.0.0") } });
        mergeLabeledPullRequest(state, {
            branch: "add-widget",
            files: { "src/widget.rs": "// a widget\n" },
            label: "feat",
            message: "feat: add a widget",
        });

        const prepareRunner = await harness.createRunner("rust");
        expect(await prepareRunner.prepare()).toBe(true);

        const openPrs = state.pullRequests.filter(candidate => candidate.state === "open");
        expect(openPrs).toHaveLength(1);
        const pr = openPrs[0];
        expect(pr.labels).toContain("autorelease: pending");
        expect(pr.title).toContain("0.1.0"); // a "feat"-labeled merge against 0.0.0 bumps the minor version

        state.mergePullRequest(pr.number);

        const releaseRunner = await harness.createRunner("rust");
        expect(await releaseRunner.release()).toBe(true);

        expect(state.releases).toHaveLength(1);
        expect(state.releases[0].tagName).toContain("0.1.0");
        expect(state.tags.has(state.releases[0].tagName)).toBe(true);
        expect(state.getPullRequestOrThrow(pr.number).labels).toContain("autorelease: tagged");
        expect(state.getPullRequestOrThrow(pr.number).labels).not.toContain("autorelease: pending");

        // Second cycle: a further merged commit should produce a second, independent incremental release.
        mergeLabeledPullRequest(state, {
            branch: "fix-widget",
            files: { "src/widget.rs": "// a widget, fixed\n" },
            label: "fix",
            message: "fix: correct widget rendering",
        });

        const secondPrepareRunner = await harness.createRunner("rust");
        expect(await secondPrepareRunner.prepare()).toBe(true);
        const secondOpenPrs = state.pullRequests.filter(candidate => candidate.state === "open");
        expect(secondOpenPrs).toHaveLength(1);
        const secondPr = secondOpenPrs[0];
        expect(secondPr.title).toContain("0.1.1"); // a "fix"-labeled merge against 0.1.0 bumps the patch version

        state.mergePullRequest(secondPr.number);

        const secondReleaseRunner = await harness.createRunner("rust");
        expect(await secondReleaseRunner.release()).toBe(true);
        expect(state.releases).toHaveLength(2);
        expect(state.releases[1].tagName).toContain("0.1.1");
    });
});
