import { defineConfig } from "vitest/config"
import stringPlugin from "vite-plugin-string";

// Separate config for release-svp's integration tests (test/integration/**): these drive real `Github`/
// `ManifestRunner` code against an in-process fake GitHub API server (test/integration/fakeGithub) rather than
// mocking individual methods, so they're slower and more scenario-shaped than the default unit test suite (see
// vite.config.ts, which explicitly excludes this directory). Run via `npm run test:integration`; not part of
// the default `npm test`.
export default defineConfig({
    test: {
        environment: "node",
        include: ["test/integration/**/*.test.ts"],
        // Scenario tests drive multi-step `prepare`/`release` CLI flows (several HTTP round-trips each); the
        // default 5s unit-test timeout is tuned for mocked, single-call tests and is too tight here.
        testTimeout: 30_000,
    },
    plugins: [
        stringPlugin({
            include: "**/*.graphql",
            compress: false,
        }),
    ],
});
