// Fixture-authoring and CLI-driving helpers shared by release-svp's scenario integration tests. Combines a
// fresh in-memory `RepoState`/`FakeGithubServer` (test/integration/fakeGithub) with real `ManifestRunner`
// wiring, so a scenario test can seed commits/config, run `prepare()`/`release()` for real (exactly as the CLI
// would, one fresh `ManifestRunner` per invocation), merge a pull request, and assert on the resulting repo
// state (open PRs, tags, releases, file contents) — end to end, with no per-method mocking.
import { Logger } from "../../src/logger";
import { ComponentConfig, ManifestConfig } from "../../src/manifestConfig";
import { ManifestRunner } from "../../src/manifestRunner";
import { FakeGithubServer, startFakeGithubServer } from "./fakeGithub/server";
import { FakePullRequest, RepoState } from "./fakeGithub/repoState";

// Must match `manifestRunner.ts`'s own (private, unexported) `CONFIG_PATH` constant.
export const CONFIG_PATH = "release-svp-config.json";

// A logger that discards everything: scenario tests assert on `RepoState`/return values, not log output, and
// `ManifestRunner` logs fairly verbosely (see manifestRunner.ts) — piping that through to the real console on
// every test run would just be noise.
export function silentLogger(): Logger {
    const noop = () => {};
    return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

export interface IntegrationHarness {
    readonly state: RepoState;
    // Creates a fresh `ManifestRunner`, exactly as the CLI does for one `prepare`/`release` invocation (see
    // src/index.ts) — deliberately not memoized/reused across calls, since a real CLI run never reuses one
    // either, and this is exactly the "per-run" seam integration tests need to exercise repeatedly (e.g.
    // prepare → merge → release → more commits → prepare again).
    createRunner(cliReleaseType?: string): Promise<ManifestRunner>;
    close(): Promise<void>;
}

export async function createHarness(options?: { owner?: string; repo?: string; defaultBranch?: string }): Promise<IntegrationHarness> {
    const owner = options?.owner ?? "owner";
    const repo = options?.repo ?? "repo";
    const state = new RepoState({ owner, repo, defaultBranch: options?.defaultBranch ?? "main" });
    const { server, url } = await startFakeGithubServer(state);

    return {
        state,
        async createRunner(cliReleaseType?: string) {
            const runner = await ManifestRunner.create(`${owner}/${repo}`, "fake-token", cliReleaseType, silentLogger(), {
                baseUrl: url,
                disableThrottling: true,
            });
            if (!runner) {
                throw new Error(
                    "ManifestRunner.create() returned null against the fake GitHub server — check the fixture's seeded config/component state (see this harness's silentLogger: errors are swallowed by design, so failures here need direct debugging, e.g. temporarily swapping in a real logger).",
                );
            }
            return runner;
        },
        close: () => server.close(),
    };
}

// ---- Fixture content builders ----

// Every configured component must declare `releaseType: "rust"` today (the only registered strategy — see
// strategyFactory.ts) and `RustStrategy` unconditionally reads this component's own `Cargo.toml` (see
// strategies/rust.ts), so every component fixture needs one, however minimal.
export function cargoToml(packageName: string, version: string): string {
    return `[package]\nname = "${packageName}"\nversion = "${version}"\nedition = "2021"\n`;
}

// Builds the file snapshot a component needs to exist *before* its first release (a `Cargo.toml` at its own
// path) — merge this into a `seedCommit({ files: ... })` call alongside any other components' files and the
// config file itself (see `configFileContent`).
export function componentFiles(component: ComponentConfig, initialVersion = "0.0.0"): Record<string, string> {
    const prefix = component.path ? `${component.path}/` : "";
    return { [`${prefix}Cargo.toml`]: cargoToml(component.component || component.path || "root", initialVersion) };
}

// Builds a minimal, valid rust-strategy component config. `path` defaults to `component` (the common case: a
// component's directory is named after it) — pass `path` explicitly when they should differ.
export function rustComponent(component: string, overrides?: { path?: string; releaseGroup?: string }): ComponentConfig {
    return {
        path: overrides?.path ?? component,
        component,
        releaseType: "rust",
        releaseGroup: overrides?.releaseGroup,
    };
}

export function configFileContent(config: ManifestConfig): string {
    return JSON.stringify(config, null, 2);
}

// A commit message prefixed like a conventional commit — this is purely cosmetic (changelog entry text/PR
// title copy); it plays NO role in version-bump classification. See `mergeLabeledPullRequest` below for what
// actually drives a bump.
export function conventionalCommit(kind: "feat" | "fix" | "chore", subject: string): string {
    return `${kind}: ${subject}`;
}

// Simulates a real GitHub contribution: opens a topic branch off the current default branch head, commits the
// given file changes, opens a pull request carrying `label`, and merges it — producing a genuine two-parent
// merge commit on the default branch.
//
// `files` must actually change at least one file within the target component's path. Path-based component
// filtering (see componentPathFilter.ts) treats a merged PR with an empty changed-file set as "no-match" for
// every component (not "unknown"/root-attributed) — an empty-diff PR is correctly excluded from version-bump
// and changelog consideration entirely, so a fixture merge with `files: {}` silently never counts, however
// its label is set.
//
// This (NOT the commit message text) is what drives release-svp's version-bump classification: `Manifest`
// looks at each *merge commit's originating pull request's labels* (see versioningStrategy.ts /
// versioningStrategies/semantic.ts) — a label ending in "!" bumps major, "feat"/"feature" bumps minor,
// anything else (including no matching label at all) bumps patch. So a fixture that wants a minor-version
// release must merge a PR labeled "feat" (or "feature"), not merely use a "feat:" commit message.
export function mergeLabeledPullRequest(
    state: RepoState,
    options: { branch: string; files: Record<string, string>; label?: string; message?: string },
): FakePullRequest {
    const baseBranch = state.defaultBranch;
    const baseSha = state.getRef(`heads/${baseBranch}`);
    const baseTreeSha = state.getCommitOrThrow(baseSha).treeSha;
    const treeSha = state.createTree(
        baseTreeSha,
        Object.entries(options.files).map(([path, content]) => ({ path, mode: "100644", content })),
    );
    const message = options.message ?? `${options.label ?? "chore"}: change on ${options.branch}`;
    const commitSha = state.createCommit({ treeSha, parents: [baseSha], message });
    state.setBranchHead(options.branch, commitSha);

    const pr = state.createPullRequest({
        title: message,
        body: "",
        headBranch: options.branch,
        baseBranch,
        labels: options.label ? [options.label] : [],
        changedFilePaths: Object.keys(options.files),
    });
    state.mergePullRequest(pr.number);
    return state.getPullRequestOrThrow(pr.number);
}
