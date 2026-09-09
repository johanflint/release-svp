// A genuine, non-duplicate GitHub API failure part way through `prepare()` for a multi-component repository —
// mirrors retryAfterPartialFailure.test.ts's `release()` coverage, but for the other half of the CLI: opening
// the release pull request itself. Confirms `ManifestRunner.prepare()`'s per-release-unit error isolation (see
// manifestRunner.ts, `prepare()`) end to end: one component's pull-request creation failing must never stop or
// corrupt another component's, must be reflected in the overall `false` return value, and must leave the failed
// component cleanly retryable — no half-created pull request — so simply rerunning `prepare()` afterwards
// finishes the job without any duplication for the component(s) that already succeeded.
import { afterEach, describe, expect, it } from "vitest";
import { pendingLabel } from "../../../src/componentNaming";
import { ManifestConfig } from "../../../src/manifestConfig";
import {
    componentFiles,
    configFileContent,
    createHarness,
    IntegrationHarness,
    mergeLabeledPullRequest,
    rustComponent
} from "../harness";

describe("scenario: retry after a partial prepare failure", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("isolates one component's pull-request creation failure from another's, then completes cleanly on retry with no duplication", async () => {
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

        // Simulate GitHub rejecting the pull request *creation* for "beta" specifically (a genuine, non-
        // duplicate failure — 422, not 5xx, so octokit's retry plugin doesn't silently retry and mask the fault).
        harness.failNextRequest(
            (method, pathname, body) => method === "POST" && pathname === "/repos/owner/repo/pulls" && (body?.title as string)?.startsWith("Release beta"),
            422,
            "Simulated transient GitHub failure",
        );

        expect(await (await harness.createRunner()).prepare()).toBe(false); // overall failure: "beta" failed

        // "alpha" succeeded and has its own, correctly-labeled pull request...
        const alphaPr = state.pullRequests.find(pr => pr.title.startsWith("Release alpha"));
        expect(alphaPr).toBeDefined();
        expect(alphaPr!.labels).toEqual([pendingLabel("alpha")]);

        // ...while "beta" has no pull request at all yet — nothing was half-created for it to clean up.
        expect(state.pullRequests.find(pr => pr.title.startsWith("Release beta"))).toBeUndefined();

        // Retrying (no fault injected this time) finishes the job — "beta" gets its pull request, "alpha" is
        // not touched again (no duplicate/second pull request for it).
        expect(await (await harness.createRunner()).prepare()).toBe(true);

        const openPrs = state.pullRequests.filter(pr => pr.state === "open");
        expect(openPrs).toHaveLength(2);
        expect(openPrs.filter(pr => pr.title.startsWith("Release alpha"))).toHaveLength(1); // still just the one
        const betaPr = openPrs.find(pr => pr.title.startsWith("Release beta"));
        expect(betaPr).toBeDefined();
        expect(betaPr!.labels).toEqual([pendingLabel("beta")]);
    });
});
