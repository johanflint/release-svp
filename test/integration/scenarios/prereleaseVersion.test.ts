// A component whose baseline tag already carries SemVer pre-release metadata (e.g. "v0.1.0-beta") must have
// that metadata preserved through the version bump (see src/versioningStrategy.ts, each VersionUpdater keeps
// `preRelease`/`build`) AND must be published to GitHub as a pre-release rather than a stable release (see
// src/release.ts `buildReleaseForComponent` and src/github.ts `createRelease`).
import { afterEach, describe, expect, it } from "vitest";
import { cargoToml, createHarness, IntegrationHarness, mergeLabeledPullRequest } from "../harness";

describe("scenario: pre-release version baseline", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("preserves pre-release metadata through the bump and publishes the release as a GitHub pre-release", async () => {
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
        expect(pullRequest?.title).toContain("0.1.1-beta"); // "fix" bumps patch only, pre-release metadata carries over

        state.mergePullRequest(pullRequest!.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.releases).toHaveLength(1);
        expect(state.releases[0].tagName).toBe("v0.1.1-beta");
        expect(state.releases[0].prerelease).toBe(true);
    });
});
