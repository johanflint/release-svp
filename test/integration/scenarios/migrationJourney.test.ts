// The cumulative "migration journey" — one repository evolving through two separate migrations, reusing the same
// fixture across three release cycles:
//   1. Single-project repository (no config), one ordinary release.
//   2. First migration: split into two standalone components — "core" (the legacy successor, inheriting the
//      pre-migration release history) and "api" (a brand-new component, starting from a bootstrap baseline).
//      This is scenario 2's setup, replayed here as a stepping stone rather than the end state.
//   3. Second migration: "core" and "api" are folded into one release group ("platform"), and two more
//      brand-new standalone components ("web", "docs") are added alongside it.
//
// Confirms the whole system holds together across repeated config evolutions on one repository: nothing from
// an earlier phase (its old tags, its old migration config) gets confused or re-triggered by a later one, and
// every component's tag lineage stays independently correct throughout.
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

describe("scenario: cumulative migration journey", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("evolves a single-project repository through two migrations, preserving independent tag lineage at every step", async () => {
        harness = await createHarness();
        const { state } = harness;

        // ===== Phase 1: single-project repository, one ordinary release =====
        state.seedCommit({ message: "chore: initial commit", files: { "Cargo.toml": cargoToml("root", "0.0.0") } });
        mergeLabeledPullRequest(state, { branch: "add-widget", files: { "src/widget.rs": "// a widget\n" }, label: "feat" });

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        state.mergePullRequest(state.pullRequests.find(pr => pr.state === "open")!.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.releases.map(release => release.tagName)).toEqual(["v0.1.0"]);

        // ===== Phase 2: first migration — split into "core" (legacy successor) and "api" (new) =====
        const core = rustComponent("core", { path: "" });
        const api = rustComponent("api");

        const firstCutoverCommit = seedCutoverCommit(state, componentFiles(api, "0.1.0"));
        const configV2: ManifestConfig = {
            components: [core, api],
            separatePullRequests: true,
            migration: {
                cutoverCommit: firstCutoverCommit,
                legacyRootSuccessor: "core",
                legacyAnchorTag: "v0.1.0",
                bootstrapVersions: { api: "0.1.0" },
            },
        };
        state.seedCommit({ message: "chore: migrate to multi-component config", files: { "release-svp-config.json": configFileContent(configV2) } });

        mergeLabeledPullRequest(state, { branch: "core-fix-1", files: { "src/lib.rs": "// fixed\n" }, label: "fix" });
        mergeLabeledPullRequest(state, { branch: "api-feature-1", files: { "api/src/main.rs": "// a new endpoint\n" }, label: "feat" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);
        state.pullRequests.filter(pr => pr.state === "open").forEach(pr => state.mergePullRequest(pr.number));
        expect(await (await harness.createRunner()).release()).toBe(true);

        expect(state.releases.map(release => release.tagName).sort()).toEqual(["v0.1.0", "core-v0.1.1", "api-v0.2.0"].sort());

        // ===== Phase 3: second migration — group "core" + "api" into "platform", add "web" and "docs" =====
        const groupedCore = rustComponent("core", { path: "", releaseGroup: "platform" });
        const groupedApi = rustComponent("api", { releaseGroup: "platform" });
        const web = rustComponent("web");
        const docs = rustComponent("docs");

        // No self-reference problem here (unlike the very first migration): `cutoverCommit` still points at
        // `firstCutoverCommit` from phase 2 — it doesn't need to reference this commit's own sha — so the new
        // scaffolding and the updated config can land in one single commit.
        const configV3: ManifestConfig = {
            components: [groupedCore, groupedApi, web, docs],
            migration: {
                cutoverCommit: firstCutoverCommit,
                legacyRootSuccessor: "core",
                legacyAnchorTag: "v0.1.0",
                bootstrapVersions: { api: "0.1.0", web: "0.1.0", docs: "0.1.0" },
            },
        };
        state.seedCommit({
            message: "chore: group core+api, add web and docs components",
            files: {
                ...componentFiles(web, "0.0.0"),
                ...componentFiles(docs, "0.0.0"),
                "release-svp-config.json": configFileContent(configV3),
            },
        });

        mergeLabeledPullRequest(state, { branch: "core-fix-2", files: { "src/lib.rs": "// fixed again\n" }, label: "fix" });
        mergeLabeledPullRequest(state, { branch: "api-feature-2", files: { "api/src/main.rs": "// another endpoint\n" }, label: "feat" });
        mergeLabeledPullRequest(state, { branch: "web-feature", files: { "web/src/main.rs": "// the web frontend\n" }, label: "feat" });
        mergeLabeledPullRequest(state, { branch: "docs-fix", files: { "docs/README.md": "docs fix\n" }, label: "fix" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);

        const openPrs = state.pullRequests.filter(pr => pr.state === "open");
        expect(openPrs).toHaveLength(3); // one combined PR for "platform", one each for "web" and "docs"

        const platformPr = openPrs.find(pr => pr.title === "Release platform")!;
        expect(platformPr).toBeDefined();
        expect(platformPr.labels.sort()).toEqual([pendingLabel("core"), pendingLabel("api")].sort());

        const webPr = openPrs.find(pr => pr.title.startsWith("Release web"))!;
        const docsPr = openPrs.find(pr => pr.title.startsWith("Release docs"))!;
        expect(webPr).toBeDefined();
        expect(docsPr).toBeDefined();
        expect(webPr.title).toContain("0.2.0"); // "feat" against the 0.1.0 bootstrap baseline bumps the minor version
        expect(docsPr.title).toContain("0.1.1"); // "fix" against the 0.1.0 bootstrap baseline bumps the patch version

        openPrs.forEach(pr => state.mergePullRequest(pr.number));
        expect(await (await harness.createRunner()).release()).toBe(true);

        const finalTags = state.releases.map(release => release.tagName).sort();
        expect(finalTags).toEqual([
            "v0.1.0", // phase 1's untouched, pre-migration release
            "core-v0.1.1", "api-v0.2.0", // phase 2's releases
            "core-v0.1.2", "api-v0.3.0", "web-v0.2.0", "docs-v0.1.1", // phase 3's releases
        ].sort());
    });
});
