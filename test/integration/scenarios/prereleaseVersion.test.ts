// A component's pre-release status is now driven purely by its config (`prereleaseType`, see
// manifestConfig.ts) — see src/manifest.ts (`applyPrereleaseType`) and README.md ("Pre-releases"). A baseline
// tag that happens to carry SemVer pre-release metadata (e.g. "v0.1.0-beta", from a manual tag predating that
// config field) no longer keeps a component in pre-release mode by itself: without `prereleaseType` configured,
// the very next release graduates straight to stable, published as a regular (non-pre-)release.
import { afterEach, describe, expect, it } from "vitest";
import { cargoToml, createHarness, IntegrationHarness, mergeLabeledPullRequest } from "../harness";

describe("scenario: pre-release version baseline with no prereleaseType configured", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("graduates to a stable release on the next bump, discarding the old pre-release metadata", async () => {
        harness = await createHarness();
        const { state } = harness;

        const initialSha = state.seedCommit({ message: "chore: initial commit", files: { "Cargo.toml": cargoToml("root", "0.1.0-beta") } });
        state.seedTag("v0.1.0-beta", initialSha, new Date().toISOString());

        mergeLabeledPullRequest(state, {
            branch: "fix-widget",
            files: { "src/widget.rs": "// a widget, fixed\n" },
            label: "fix",
            message: "Correct the widget rendering",
        });

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        const pullRequest = state.pullRequests.find(pr => pr.state === "open");
        // Graduated: same numeric target as the old "0.1.0-beta" tag, just without the "-beta" suffix — a
        // trivial fix alone would only justify "0.0.1" from a true stable baseline, but the version must never
        // move backwards relative to what "0.1.0-beta" already committed to (see src/manifest.ts, `higherNumericTarget`).
        expect(pullRequest?.title).toContain("0.1.0");

        state.mergePullRequest(pullRequest!.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.releases).toHaveLength(1);
        expect(state.releases[0].tagName).toBe("v0.1.0");
        expect(state.releases[0].prerelease).toBe(false);
    });
});
