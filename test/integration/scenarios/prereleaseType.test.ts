// End-to-end demonstration of the config-driven `prereleaseType` feature (see manifestConfig.ts,
// src/manifest.ts `applyPrereleaseType`, README.md "Pre-releases"): a component configured with
// `prereleaseType: "beta"` is released as a SemVer pre-release, its identifier incrementing ("beta" -> "beta.1")
// across successive releases that are still governed by the same config, and it graduates straight to a stable
// release the moment `prereleaseType` is removed from config — without any extra numeric bump.
import { afterEach, describe, expect, it } from "vitest";
import { ManifestConfig } from "../../../src/manifestConfig";
import { componentFiles, configFileContent, createHarness, IntegrationHarness, mergeLabeledPullRequest, rustComponent } from "../harness";

describe("scenario: prereleaseType config", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("publishes a pre-release train while configured, then graduates to stable once prereleaseType is removed", async () => {
        harness = await createHarness();
        const { state } = harness;

        const root = rustComponent("root", { path: "" });
        const configWithBeta: ManifestConfig = { components: [{ ...root, prereleaseType: "beta" }] };
        state.seedCommit({
            message: "chore: initial commit",
            files: { ...componentFiles(root), "release-svp-config.json": configFileContent(configWithBeta) },
        });

        // --- Round 1: first release, "prereleaseType" configured — starts the pre-release train at "-beta" ---
        mergeLabeledPullRequest(state, { branch: "add-widget", files: { "src/widget.rs": "// a widget\n" }, label: "feat" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);
        state.mergePullRequest(state.pullRequests.find(pr => pr.state === "open")!.number);
        expect(await (await harness.createRunner()).release()).toBe(true);

        expect(state.releases.map(release => release.tagName)).toEqual(["root-v0.1.0-beta"]);
        expect(state.releases[0].prerelease).toBe(true);

        // --- Round 2: still configured — continues the SAME train, incrementing the identifier ---
        mergeLabeledPullRequest(state, { branch: "add-gadget", files: { "src/gadget.rs": "// a gadget\n" }, label: "feat" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);
        state.mergePullRequest(state.pullRequests.find(pr => pr.state === "open")!.number);
        expect(await (await harness.createRunner()).release()).toBe(true);

        expect(state.releases.map(release => release.tagName)).toEqual(["root-v0.1.0-beta", "root-v0.1.0-beta.1"]);
        expect(state.releases[1].prerelease).toBe(true);

        // --- Round 3: "prereleaseType" removed from config — the very next release graduates straight to
        // stable, at the SAME numeric target (no further bump), and is published as a regular (non-pre-)release. ---
        const configWithoutBeta: ManifestConfig = { components: [root] };
        state.seedCommit({ message: "chore: graduate to stable", files: { "release-svp-config.json": configFileContent(configWithoutBeta) } });
        mergeLabeledPullRequest(state, { branch: "fix-widget", files: { "src/widget.rs": "// a widget, fixed\n" }, label: "fix" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);
        state.mergePullRequest(state.pullRequests.find(pr => pr.state === "open")!.number);
        expect(await (await harness.createRunner()).release()).toBe(true);

        expect(state.releases.map(release => release.tagName)).toEqual(["root-v0.1.0-beta", "root-v0.1.0-beta.1", "root-v0.1.0"]);
        expect(state.releases[2].prerelease).toBe(false);
    });
});
