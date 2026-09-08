// A genuine, non-duplicate GitHub API failure part way through `release()` for a multi-component repository — and the
// retry that follows once the underlying problem is gone.
//
// Confirms `ManifestRunner.release()`'s per-component error isolation (see manifestRunner.ts, `release()`) end
// to end: one component's release failing must never stop or corrupt another component's, must be reflected in
// the overall `false` return value, and must leave the failed component in a clean, retryable state — its pull
// request still pending, no tag/release created for it — so simply rerunning `release()` afterwards finishes
// the job without any duplication for the component(s) that already succeeded.
import { afterEach, describe, expect, it } from "vitest";
import { taggedLabel } from "../../../src/componentNaming";
import { ManifestConfig } from "../../../src/manifestConfig";
import {
    componentFiles,
    configFileContent,
    createHarness,
    IntegrationHarness,
    mergeLabeledPullRequest,
    rustComponent
} from "../harness";

describe("scenario: retry after a partial release failure", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("isolates one component's release failure from another's, then completes cleanly on retry with no duplication", async () => {
        harness = await createHarness();
        const { state } = harness;

        const alpha = rustComponent("alpha");
        const beta = rustComponent("beta");
        const config: ManifestConfig = { components: [alpha, beta], separatePullRequests: true };
        state.seedCommit({
            message: "chore: initial commit",
            files: { ...componentFiles(alpha), ...componentFiles(beta), "release-svp-config.json": configFileContent(config) },
        });

        mergeLabeledPullRequest(state, { branch: "alpha-feature", files: { "alpha/src/lib.rs": "// alpha v1\n" }, label: "feat" });
        mergeLabeledPullRequest(state, { branch: "beta-feature", files: { "beta/src/lib.rs": "// beta v1\n" }, label: "feat" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);
        state.pullRequests.filter(pr => pr.state === "open").forEach(pr => state.mergePullRequest(pr.number));

        // Simulate GitHub rejecting the *next* release creation for "beta" specifically (a genuine, non-
        // duplicate failure — 422 with no "already_exists" error code — so it propagates as a real error rather
        // than being swallowed as `DuplicateReleaseError`, see github.ts `createRelease`).
        harness.failNextRequest(
            (method, pathname, body) => method === "POST" && pathname === "/repos/owner/repo/releases" && body?.tag_name === "beta-v0.1.0",
            422,
            "Simulated transient GitHub failure",
        );

        expect(await (await harness.createRunner()).release()).toBe(false); // overall failure: "beta" failed

        // "alpha" succeeded and is fully tagged/released...
        expect(state.releases.map(release => release.tagName)).toEqual(["alpha-v0.1.0"]);
        const alphaPr = state.pullRequests.find(pr => pr.title.startsWith("Release alpha"))!;
        expect(alphaPr.labels).toEqual([taggedLabel("alpha")]);

        // ...while "beta" is untouched and still cleanly retryable: no release/tag, still pending.
        const betaPr = state.pullRequests.find(pr => pr.title.startsWith("Release beta"))!;
        expect(betaPr.merged).toBe(true); // its pull request was still merged — only the release/tag step failed
        expect(betaPr.labels).not.toContain(taggedLabel("beta"));

        // Retrying (no fault injected this time) finishes the job — "beta" is released, "alpha" is not touched
        // again (no duplicate release/tag for it).
        expect(await (await harness.createRunner()).release()).toBe(true);

        expect(state.releases.map(release => release.tagName).sort()).toEqual(["alpha-v0.1.0", "beta-v0.1.0"].sort());
        expect(state.pullRequests.find(pr => pr.title.startsWith("Release beta"))!.labels).toEqual([taggedLabel("beta")]);
    });
});
