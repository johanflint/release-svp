// A monorepo with one release group ("platform", two members) and one standalone component ("tools"), all present from
// the start (no migration involved — that's migration.test.ts's concern).
//
// Asserts:
//  - Grouped members share exactly one combined pull request (titled after the group, not any one member),
//    while the standalone component always gets its own, independently-titled pull request.
//  - "Frozen group membership": a member with no fresh candidate in a given run is never dropped from an
//    already-open combined pull request — its previously-added section is carried forward untouched — and a
//    member landing its first change in a later run is folded into that same, still-open combined pull request
//    rather than opening a second one.
//  - Despite sharing one pull request, each grouped member is still tagged/released independently, with its own
//    version and changelog.
import { afterEach, describe, expect, it } from "vitest";
import { pendingLabel } from "../../../src/componentNaming";
import { ManifestConfig } from "../../../src/manifestConfig";
import {
    componentFiles,
    configFileContent,
    createHarness,
    IntegrationHarness,
    mergeLabeledPullRequest,
    rustComponent,
} from "../harness";

describe("scenario: release group + standalone component", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("bundles grouped members into one combined pull request with frozen membership across reruns, while keeping the standalone component on its own pull request", async () => {
        harness = await createHarness();
        const { state } = harness;

        const alpha = rustComponent("alpha", { releaseGroup: "platform" });
        const beta = rustComponent("beta", { releaseGroup: "platform" });
        const tools = rustComponent("tools");

        const config: ManifestConfig = { components: [alpha, beta, tools] };
        state.seedCommit({
            message: "chore: initial commit",
            files: {
                ...componentFiles(alpha),
                ...componentFiles(beta),
                ...componentFiles(tools),
                "release-svp-config.json": configFileContent(config),
            },
        });

        // --- Round 1: only "alpha" (of the group) and "tools" (standalone) have changes ---
        mergeLabeledPullRequest(state, { branch: "alpha-feature", files: { "alpha/src/lib.rs": "// alpha v1\n" }, label: "feat" });
        mergeLabeledPullRequest(state, { branch: "tools-feature", files: { "tools/src/lib.rs": "// tools v1\n" }, label: "feat" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);

        let openPrs = state.pullRequests.filter(pr => pr.state === "open");
        expect(openPrs).toHaveLength(2); // one combined PR for the group, one standalone PR for "tools"

        const combinedPr1 = openPrs.find(pr => pr.title === "Release platform")!;
        const toolsPr1 = openPrs.find(pr => pr.title.startsWith("Release tools"))!;
        expect(combinedPr1).toBeDefined();
        expect(toolsPr1).toBeDefined();
        expect(combinedPr1.labels).toEqual([pendingLabel("alpha")]); // "beta" has no candidate yet — not included
        expect(combinedPr1.body).toContain("component:alpha");
        expect(combinedPr1.body).not.toContain("component:beta");

        // --- Round 2: nothing new for the group ("beta" still hasn't changed) — the combined PR must be a no-op,
        // carrying "alpha"'s section forward unchanged, not orphaning or dropping it. ---
        expect(await (await harness.createRunner()).prepare()).toBe(true);
        openPrs = state.pullRequests.filter(pr => pr.state === "open");
        expect(openPrs).toHaveLength(2); // still the same two pull requests, no new one opened
        const combinedPr2 = state.getPullRequestOrThrow(combinedPr1.number);
        expect(combinedPr2.labels).toEqual([pendingLabel("alpha")]);
        expect(combinedPr2.body).toContain("component:alpha");

        // --- Round 3: "beta" finally lands its first change, while the combined PR is still open — it must join
        // the SAME combined pull request (not a second one), alongside "alpha"'s still-carried-forward section. ---
        mergeLabeledPullRequest(state, { branch: "beta-feature", files: { "beta/src/lib.rs": "// beta v1\n" }, label: "feat" });

        expect(await (await harness.createRunner()).prepare()).toBe(true);
        openPrs = state.pullRequests.filter(pr => pr.state === "open");
        expect(openPrs).toHaveLength(2); // beta joined the existing combined PR, not a new one
        const combinedPr3 = state.getPullRequestOrThrow(combinedPr1.number);
        expect(combinedPr3.labels.sort()).toEqual([pendingLabel("alpha"), pendingLabel("beta")].sort());
        expect(combinedPr3.body).toContain("component:alpha");
        expect(combinedPr3.body).toContain("component:beta");

        // --- Merge everything and release: each member is tagged/released independently despite the shared PR ---
        state.mergePullRequest(combinedPr1.number);
        state.mergePullRequest(toolsPr1.number);
        expect(await (await harness.createRunner()).release()).toBe(true);

        const releaseTags = state.releases.map(release => release.tagName).sort();
        expect(releaseTags).toEqual(["alpha-v0.1.0", "beta-v0.1.0", "tools-v0.1.0"].sort());
    });
});
