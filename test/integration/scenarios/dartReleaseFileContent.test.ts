// Dart counterpart to releaseFileContent.test.ts: confirms `prepare()`/`release()` rewrite `pubspec.yaml`'s
// top-level "version" (keeping an existing `+build` number on the first release and incrementing it on every
// release after that, leaving comments and a nested dependency "version" untouched) and CHANGELOG.md's new
// entry, across successive releases, a pre-release train, and adoption by an already-released app.
import { afterEach, describe, expect, it } from "vitest";
import { ManifestConfig } from "../../../src/manifestConfig";
import { configFileContent, createHarness, IntegrationHarness, mergeLabeledPullRequest, pubspecYaml } from "../harness";

describe("scenario: dart release file content", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("bumps pubspec.yaml and CHANGELOG.md in single-project mode", async () => {
        harness = await createHarness();
        const { state } = harness;

        state.seedCommit({ message: "chore: initial commit", files: { "pubspec.yaml": pubspecYaml("app", "0.0.0") } });
        mergeLabeledPullRequest(state, { branch: "add-widget", files: { "lib/widget.dart": "// a widget\n" }, label: "feature" });

        expect(await (await harness.createRunner("dart")).prepare()).toBe(true);
        const pr = state.pullRequests.find(p => p.state === "open")!;

        expect(state.getFileContent(pr.headBranch, "pubspec.yaml")).toEqual(pubspecYaml("app", "0.1.0"));
        const changelog = state.getFileContent(pr.headBranch, "CHANGELOG.md")!;
        expect(changelog).toContain("## v0.1.0");
        expect(changelog).toContain("### Features");

        state.mergePullRequest(pr.number);
        expect(await (await harness.createRunner("dart")).release()).toBe(true);

        expect(state.getFileContent(state.defaultBranch, "pubspec.yaml")).toEqual(pubspecYaml("app", "0.1.0"));
        expect(state.getFileContent(state.defaultBranch, "CHANGELOG.md")).toEqual(changelog);
        expect(state.releases.map(release => release.tagName)).toEqual(["v0.1.0"]);
    });

    it("keeps the build number on the first release, then increments it once per merged release", async () => {
        harness = await createHarness();
        const { state } = harness;

        const component = { path: "app", component: "app", releaseType: "dart", prereleaseType: "rc" };
        const config: ManifestConfig = { components: [component] };
        state.seedCommit({
            message: "chore: initial commit",
            files: { "app/pubspec.yaml": pubspecYaml("app", "0.0.0+1"), "release-svp-config.json": configFileContent(config) },
        });

        // --- Release 1 (rc): nothing was released yet, so the build number in pubspec.yaml is used as-is. The
        // open pull request is recomputed from the default branch on every run, so preparing twice must still
        // propose +1, not +2 ---
        mergeLabeledPullRequest(state, { branch: "add-widget", files: { "app/lib/widget.dart": "// a widget\n" }, label: "feat" });
        expect(await (await harness.createRunner()).prepare()).toBe(true);
        expect(await (await harness.createRunner()).prepare()).toBe(true);

        const pr1 = state.pullRequests.find(p => p.state === "open")!;
        expect(state.getFileContent(pr1.headBranch, "app/pubspec.yaml")).toEqual(pubspecYaml("app", "0.1.0-rc+1"));
        expect(state.getFileContent(state.defaultBranch, "app/pubspec.yaml")).toEqual(pubspecYaml("app", "0.0.0+1"));

        state.mergePullRequest(pr1.number);
        expect(await (await harness.createRunner()).release()).toBe(true);
        expect(state.getFileContent(state.defaultBranch, "app/pubspec.yaml")).toEqual(pubspecYaml("app", "0.1.0-rc+1"));

        // --- Release 2 (rc.1): +1 -> +2 ---
        mergeLabeledPullRequest(state, { branch: "add-gadget", files: { "app/lib/gadget.dart": "// a gadget\n" }, label: "feat" });
        expect(await (await harness.createRunner()).prepare()).toBe(true);
        const pr2 = state.pullRequests.find(p => p.state === "open")!;
        expect(state.getFileContent(pr2.headBranch, "app/pubspec.yaml")).toEqual(pubspecYaml("app", "0.1.0-rc.1+2"));

        state.mergePullRequest(pr2.number);
        expect(await (await harness.createRunner()).release()).toBe(true);
        expect(state.releases.map(release => release.tagName)).toEqual(["app-v0.1.0-rc", "app-v0.1.0-rc.1"]);

        // --- Release 3: graduate to stable by removing prereleaseType: +2 -> +3 ---
        const stableConfig: ManifestConfig = { components: [{ path: "app", component: "app", releaseType: "dart" }] };
        state.seedCommit({ message: "chore: graduate", files: { "release-svp-config.json": configFileContent(stableConfig) } });
        mergeLabeledPullRequest(state, { branch: "fix-widget", files: { "app/lib/widget.dart": "// fixed\n" }, label: "fix" });
        expect(await (await harness.createRunner()).prepare()).toBe(true);
        const pr3 = state.pullRequests.find(p => p.state === "open")!;
        expect(state.getFileContent(pr3.headBranch, "app/pubspec.yaml")).toEqual(pubspecYaml("app", "0.1.0+3"));

        state.mergePullRequest(pr3.number);
        expect(await (await harness.createRunner()).release()).toBe(true);
        expect(state.releases.map(release => release.tagName)).toEqual(["app-v0.1.0-rc", "app-v0.1.0-rc.1", "app-v0.1.0"]);
        expect(state.releases[2].prerelease).toBe(false);
    });

    it("continues an already-released app from its tagged version and pubspec.yaml build number", async () => {
        harness = await createHarness();
        const { state } = harness;

        // Adopting release-svp: the app already shipped 1.4.0 (build 57), and that commit is tagged as v1.4.0
        const initialSha = state.seedCommit({ message: "chore: initial commit", files: { "pubspec.yaml": pubspecYaml("app", "1.4.0+57") } });
        state.seedTag("v1.4.0", initialSha, new Date().toISOString());
        mergeLabeledPullRequest(state, { branch: "fix-widget", files: { "lib/widget.dart": "// fixed\n" }, label: "fix" });

        expect(await (await harness.createRunner("dart")).prepare()).toBe(true);
        const pr = state.pullRequests.find(p => p.state === "open")!;
        expect(state.getFileContent(pr.headBranch, "pubspec.yaml")).toEqual(pubspecYaml("app", "1.4.1+58"));

        state.mergePullRequest(pr.number);
        expect(await (await harness.createRunner("dart")).release()).toBe(true);
        expect(state.releases.map(release => release.tagName)).toEqual(["v1.4.1"]);
    });
});
