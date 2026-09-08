// Public entry point for release-svp's integration tests: spin up an in-process fake GitHub API server backed
// by a fresh `RepoState`, point `Github`/`ManifestRunner.create()` at it via the `baseUrl` DI seam, drive the
// CLI/library flow for real, then assert on the resulting `RepoState` (open PRs, tags, releases, file
// contents) — see repoState.ts and server.ts for what's modeled and why.
export { RepoState } from "./repoState";
export { startFakeGithubServer, FakeGithubServer } from "./server";
