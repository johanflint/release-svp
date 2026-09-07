// Self-test for the fake GitHub server itself: drives it via a real `octokit`/`@octokit/rest` client (the same
// library release-svp uses in production), the same way `Github`'s DI seam (see src/github.ts's `baseUrl`
// option) will. This validates the fake's HTTP surface directly, independent of any release-svp scenario —
// scenario-level integration tests (built in later steps) rely on this being correct.
import { Octokit as RestOctokit } from "@octokit/rest";
import { Octokit } from "octokit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoState } from "./repoState";
import { FakeGithubServer, startFakeGithubServer } from "./server";

describe("FakeGithubServer", () => {
    let state: RepoState;
    let fake: FakeGithubServer;
    let url: string;
    let octokit: Octokit;
    let restOctokit: RestOctokit;

    beforeEach(async () => {
        state = new RepoState({ owner: "owner", repo: "repo", defaultBranch: "main" });
        ({ server: fake, url } = await startFakeGithubServer(state));
        octokit = new Octokit({ baseUrl: url, throttle: { enabled: false } });
        restOctokit = new RestOctokit({ baseUrl: url });
    });

    afterEach(async () => {
        await fake.close();
    });

    it("reports the seeded default branch", async () => {
        const response = await octokit.rest.repos.get({ owner: "owner", repo: "repo" });
        expect(response.data.default_branch).toBe("main");
    });

    it("round-trips a branch through git refs (create, get, 404 before creation)", async () => {
        await expect(octokit.rest.git.getRef({ owner: "owner", repo: "repo", ref: "heads/feature" })).rejects.toMatchObject({ status: 404 });

        const initialSha = state.seedCommit({ message: "root", files: { "a.txt": "hello" } });
        await octokit.rest.git.createRef({ owner: "owner", repo: "repo", ref: "refs/heads/feature", sha: initialSha });

        const response = await octokit.rest.git.getRef({ owner: "owner", repo: "repo", ref: "heads/feature" });
        expect(response.data.object.sha).toBe(initialSha);
    });

    it("creates a tree+commit on top of an existing commit and moves the branch via updateRef", async () => {
        const rootSha = state.seedCommit({ message: "root", files: { "a.txt": "hello", "b.txt": "keep-me" } });
        state.setBranchHead("feature", rootSha);

        const { data: oldCommit } = await restOctokit.git.getCommit({ owner: "owner", repo: "repo", commit_sha: rootSha });
        const { data: tree } = await restOctokit.git.createTree({
            owner: "owner",
            repo: "repo",
            base_tree: oldCommit.tree.sha,
            tree: [{ path: "a.txt", mode: "100644", type: "blob", content: "updated" }],
        });
        const { data: commit } = await restOctokit.git.createCommit({
            owner: "owner",
            repo: "repo",
            message: "update a.txt",
            tree: tree.sha,
            parents: [rootSha],
        });
        await restOctokit.git.updateRef({ owner: "owner", repo: "repo", ref: "heads/feature", sha: commit.sha });

        expect(state.branches.get("feature")).toBe(commit.sha);
        const entries = state.getRecursiveTreeByReference("feature");
        expect(entries.find(e => e.path === "a.txt")).toBeDefined();
        expect(entries.find(e => e.path === "b.txt")).toBeDefined(); // untouched file survives the overlay
    });

    it("fetches recursive tree contents and blob contents (base64-decoded round trip)", async () => {
        state.seedCommit({ message: "root", files: { "dir/file.txt": "some content" } });
        state.setBranchHead("main", state.branches.get("main")!);

        const { data: treeResponse } = await restOctokit.git.getTree({ owner: "owner", repo: "repo", tree_sha: "main", recursive: "true" });
        expect(treeResponse.truncated).toBe(false);
        const entry = treeResponse.tree.find(e => e.path === "dir/file.txt");
        expect(entry).toBeDefined();

        const { data: blob } = await restOctokit.git.getBlob({ owner: "owner", repo: "repo", file_sha: entry!.sha! });
        expect(Buffer.from(blob.content, "base64").toString("utf8")).toBe("some content");
    });

    it("creates a pull request, lists it by head, updates it, and manages labels", async () => {
        const rootSha = state.seedCommit({ message: "root", files: { "a.txt": "hello" } });
        state.setBranchHead("release-branch", rootSha);

        const created = await octokit.rest.pulls.create({
            owner: "owner",
            repo: "repo",
            title: "Release v1.0.0",
            head: "owner:release-branch",
            base: "main",
            body: "notes",
        });
        expect(created.data.number).toBe(1);

        const listed = await octokit.rest.pulls.list({ owner: "owner", repo: "repo", head: "owner:release-branch" });
        expect(listed.data).toHaveLength(1);

        await octokit.rest.pulls.update({ owner: "owner", repo: "repo", pull_number: 1, title: "Release v1.0.1", body: "updated notes" });
        const fetched = await octokit.rest.pulls.get({ owner: "owner", repo: "repo", pull_number: 1 });
        expect(fetched.data.title).toBe("Release v1.0.1");
        expect(fetched.data.body).toBe("updated notes");

        await octokit.rest.issues.addLabels({ owner: "owner", repo: "repo", issue_number: 1, labels: ["autorelease: pending"] });
        await octokit.rest.issues.removeLabel({ owner: "owner", repo: "repo", issue_number: 1, name: "autorelease: pending" });
        expect(state.getPullRequestOrThrow(1).labels).toEqual([]);
    });

    it("creates a release for a new tag, and rejects a duplicate release the same way GitHub does", async () => {
        const rootSha = state.seedCommit({ message: "root", files: { "a.txt": "hello" } });

        const created = await octokit.rest.repos.createRelease({ owner: "owner", repo: "repo", tag_name: "v1.0.0", name: "v1.0.0", target_commitish: rootSha });
        expect(created.data.id).toBeDefined();
        expect(state.tags.get("v1.0.0")?.commitSha).toBe(rootSha);

        await expect(
            octokit.rest.repos.createRelease({ owner: "owner", repo: "repo", tag_name: "v1.0.0", name: "v1.0.0", target_commitish: rootSha }),
        ).rejects.toMatchObject({ status: 422, response: { data: { errors: [{ code: "already_exists" }] } } });
    });

    it("answers the latestTags GraphQL query with seeded tags, newest first", async () => {
        const sha1 = state.seedCommit({ message: "v1", files: { "a.txt": "1" } });
        const sha2 = state.seedCommit({ message: "v2", files: { "a.txt": "2" } });
        state.seedTag("v1.0.0", sha1, "2024-01-01T00:00:00Z");
        state.seedTag("v2.0.0", sha2, "2024-06-01T00:00:00Z");

        const response: any = await octokit.graphql(
            `query latestTags($owner: String!, $repo: String!, $count: Int!, $cursor: String) {
                repository(owner: $owner, name: $repo) { refs(refPrefix: "refs/tags/", first: $count, after: $cursor) { nodes { name target { oid } } pageInfo { hasNextPage endCursor } } }
            }`,
            { owner: "owner", repo: "repo", count: 10 },
        );

        expect(response.repository.refs.nodes.map((n: any) => n.name)).toEqual(["v2.0.0", "v1.0.0"]);
    });

    it("answers the pullRequestsSince GraphQL query by walking branch history and attaching the associated merged PR", async () => {
        const rootSha = state.seedCommit({ message: "root", files: { "a.txt": "1" } });
        state.setBranchHead("release-branch", rootSha);
        const pr = state.createPullRequest({ title: "Release", body: "", headBranch: "release-branch", baseBranch: "main" });
        state.mergePullRequest(pr.number);

        const response: any = await octokit.graphql(
            `query pullRequestsSince($owner: String!, $repo: String!, $count: Int!, $targetBranch: String!, $cursor: String) {
                repository(owner: $owner, name: $repo) { ref(qualifiedName: $targetBranch) { target { ... on Commit { history(first: $count, after: $cursor) {
                    nodes { sha: oid message associatedPullRequests(first: 10) { nodes { number title } } }
                    pageInfo { hasNextPage endCursor }
                } } } } }
            }`,
            { owner: "owner", repo: "repo", count: 10, targetBranch: "main" },
        );

        const mergeCommitNode = response.repository.ref.target.history.nodes.find((n: any) => n.associatedPullRequests.nodes.length > 0);
        expect(mergeCommitNode.associatedPullRequests.nodes[0].number).toBe(pr.number);
    });

    it("fails loudly for a route it doesn't model", async () => {
        await expect(octokit.rest.repos.createFork({ owner: "owner", repo: "repo" })).rejects.toMatchObject({ status: 404 });
    });
});
