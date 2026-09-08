// A single-project repository migrating to a two-component monorepo, where one component ("core") is the legacy root
// successor (inherits the pre-migration repository's release history via `migration.legacyAnchorTag`) and the other
// ("api") is abrand-new component with no history to inherit (starts from `migration.bootstrapVersions`).
//
// Asserts tag/version lineage at the cutover boundary specifically:
//  - "core"'s first post-migration release bumps forward from the pre-migration (unscoped) tag, not from
//    scratch — proving the `legacyAnchorTag` fallback-anchoring works.
//  - "api"'s first release starts from its configured `bootstrapVersions` baseline, not 0.0.0.
//  - Commits at or before `cutoverCommit` are never (re-)attributed to either component.
import { afterEach, describe, expect, it } from "vitest";
import { pendingLabel } from "../../../src/componentNaming";
import { ManifestConfig } from "../../../src/manifestConfig";
import {
    cargoToml,
    componentFiles,
    configFileContent,
    createHarness,
    IntegrationHarness,
    mergeLabeledPullRequest,
    rustComponent,
    seedCutoverCommit,
} from "../harness";

describe("scenario: legacy-successor migration", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("migrates a single-project repository into a legacy successor + a fresh bootstrap component, preserving tag/version lineage at the cutover", async () => {
        harness = await createHarness();
        const { state } = harness;

        // --- Pre-migration: single-project repository with one release already out ---
        state.seedCommit({ message: "chore: initial commit", files: { "Cargo.toml": cargoToml("root", "0.0.0") } });
        mergeLabeledPullRequest(state, {
            branch: "add-widget",
            files: { "src/widget.rs": "// a widget\n" },
            label: "feat",
            message: "feat: add a widget",
        });
        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        state.mergePullRequest(state.pullRequests.find(pr => pr.state === "open")!.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.releases).toHaveLength(1);
        expect(state.releases[0].tagName).toBe("v0.1.0"); // the pre-migration, unscoped baseline "core" inherits

        // --- Migration: split into "core" (legacy successor, stays at the repository root) and "api" (new) ---
        const core = rustComponent("core", { path: "" });
        const api = rustComponent("api");

        // Step 1: land the reorganization (scaffold "api"'s own directory) — this commit becomes the cutover
        // boundary. See `seedCutoverCommit` for why this must be its own, earlier commit.
        const cutoverCommit = seedCutoverCommit(state, componentFiles(api, "0.1.0"));

        // Step 2: add release-svp-config.json, now that the cutover commit's sha is known.
        const config: ManifestConfig = {
            components: [core, api],
            separatePullRequests: true, // keep each component on its own pull request (grouping is scenario 3's concern)
            migration: {
                cutoverCommit,
                legacyRootSuccessor: "core",
                legacyAnchorTag: "v0.1.0",
                bootstrapVersions: { api: "0.1.0" },
            },
        };
        state.seedCommit({
            message: "chore: migrate to multi-component config",
            files: { "release-svp-config.json": configFileContent(config) },
        });

        // --- Post-migration: one change per component ---
        mergeLabeledPullRequest(state, {
            branch: "core-fix",
            files: { "src/lib.rs": "// fixed\n" },
            label: "fix",
            message: "Fix a bug in core",
        });
        mergeLabeledPullRequest(state, {
            branch: "api-feature",
            files: { "api/src/main.rs": "// a new endpoint\n" },
            label: "feat",
            message: "Add a new endpoint",
        });

        expect(await (await harness.createRunner()).prepare()).toBe(true);

        const openPrs = state.pullRequests.filter(pr => pr.state === "open");
        expect(openPrs).toHaveLength(2); // one per component, thanks to separatePullRequests

        const corePr = openPrs.find(pr => pr.labels.includes(pendingLabel("core")))!;
        const apiPr = openPrs.find(pr => pr.labels.includes(pendingLabel("api")))!;
        expect(corePr).toBeDefined();
        expect(apiPr).toBeDefined();
        expect(corePr.title).toContain("0.1.1"); // "fix" against the inherited v0.1.0 anchor bumps the patch version
        expect(apiPr.title).toContain("0.2.0"); // "feat" against the 0.1.0 bootstrap baseline bumps the minor version

        state.mergePullRequest(corePr.number);
        state.mergePullRequest(apiPr.number);
        expect(await (await harness.createRunner()).release()).toBe(true);

        expect(state.releases).toHaveLength(3); // the pre-migration release, plus one per post-migration component
        const releaseTags = state.releases.map(release => release.tagName);
        expect(releaseTags).toContain("v0.1.0"); // untouched pre-migration release
        expect(releaseTags).toContain("core-v0.1.1"); // "core" continues its inherited lineage, now component-scoped
        expect(releaseTags).toContain("api-v0.2.0"); // "api"'s first-ever release, from its bootstrap baseline
    });
});
