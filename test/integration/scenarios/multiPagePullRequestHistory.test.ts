// A merge-commit/pull-request history spanning more than one GraphQL page: the fake GitHub server (like real
// GitHub) pages results in the same 10-item pages release-svp's iterators request (see `count: 10` in
// github.ts), so any scenario with 11+ merged pull requests forces a real follow-up request — this is the one
// scenario test that actually exercises that path; every other scenario test's history fits on a single page,
// so a broken/regressed cursor (e.g. reintroducing today's silently-hardcoded "hasNextPage: false" in the fake
// server, or a real off-by-one in `paginate()`/`MemoizedAsyncIterable`) would go unnoticed by the rest of the
// suite.
import { afterEach, describe, expect, it } from "vitest";
import { taggedLabel } from "../../../src/componentNaming";
import { cargoToml, createHarness, IntegrationHarness, mergeLabeledPullRequest } from "../harness";

describe("scenario: pull request history spanning multiple pages", () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
        await harness?.close();
    });

    it("walks every merge commit and every merged pull request across pages, not just the first page of 10", async () => {
        harness = await createHarness();
        const { state } = harness;

        state.seedCommit({ message: "chore: initial commit", files: { "Cargo.toml": cargoToml("root", "0.0.0") } });

        // --- 12 merge commits before the very first release: `mergeCommitIterator` (backed by the
        // `pullRequestsSince` query) walks this branch's history newest-first, so the OLDEST of these (merged
        // first, "01") only appears on the *second* page — its changelog note surviving into the release pull
        // request proves the walk didn't stop after page 1. ---
        for (let i = 1; i <= 12; i++) {
            const n = i.toString().padStart(2, "0");
            mergeLabeledPullRequest(state, { branch: `fix-${n}`, files: { "src/lib.rs": `// change ${n}\n` }, label: "fix" });
        }

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        const bootstrapPr = state.pullRequests.find(pr => pr.state === "open")!;
        expect(bootstrapPr.body).toContain("fix-01"); // oldest commit, only reachable via page 2
        expect(bootstrapPr.body).toContain("fix-12"); // newest commit, on page 1

        state.mergePullRequest(bootstrapPr.number);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);
        expect(state.releases).toHaveLength(1);

        // --- 12 more merge commits, all merged AFTER the just-tagged release pull request. `determineReleases`
        // (backed by `pullRequestIterator`/the `mergedPullRequests` query, ordered newest-first by UPDATED_AT)
        // now has to page past all twelve of these before it would ever see an older, still-relevant pull
        // request — exercising that same pagination on the release() side. ---
        for (let i = 13; i <= 24; i++) {
            mergeLabeledPullRequest(state, { branch: `fix-${i}`, files: { "src/lib.rs": `// change ${i}\n` }, label: "fix" });
        }

        expect(await (await harness.createRunner("rust")).prepare()).toBe(true);
        const secondPr = state.pullRequests.find(pr => pr.state === "open")!;
        state.mergePullRequest(secondPr.number);

        // 26 merged pull requests now exist on the branch (1 bootstrap release PR + 12 + 12 fix PRs + this one)
        // — comfortably more than one page — before release() scans for the one still labeled pending.
        expect(state.pullRequests.filter(pr => pr.merged)).toHaveLength(26);
        expect(await (await harness.createRunner("rust")).release()).toBe(true);

        expect(state.releases).toHaveLength(2);
        expect(state.getPullRequestOrThrow(secondPr.number).labels).toEqual([taggedLabel("")]);
    });
});
