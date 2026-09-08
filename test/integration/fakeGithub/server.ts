// Minimal HTTP surface for the fake GitHub server: routes only the exact REST endpoints and GraphQL queries
// release-svp (and the `code-suggester` library it calls into) actually issues — see repoState.ts for what's
// modeled and why, and see the endpoint inventory in the session history for how this list was derived (every
// `octokit.rest.*`/`octokit.graphql` call in src/github.ts, plus every octokit call `code-suggester` and
// `@google-automations/git-file-utils` make on release-svp's behalf).
//
// Anything not explicitly routed here fails loudly (a clear 501 naming the method+path) rather than silently
// returning an empty/default response — a missing endpoint should show up as an obvious test failure, not a
// mysteriously "empty" result that looks like valid GitHub state.
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { FakeAlreadyExistsError, FakeNotFoundError, RepoState } from "./repoState";

interface RouteMatch {
    method: string;
    pattern: RegExp;
    handle: (params: string[], body: any, url: URL) => unknown;
}

export class FakeGithubServer {
    private readonly server: Server;
    private readonly routes: RouteMatch[];

    constructor(readonly state: RepoState) {
        this.routes = buildRoutes(state);
        this.server = createServer((req, res) => this.handleRequest(req, res));
    }

    async listen(): Promise<string> {
        await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
        const address = this.server.address() as AddressInfo;
        return `http://127.0.0.1:${address.port}`;
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => this.server.close(err => (err ? reject(err) : resolve())));
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        // Decode the pathname once up front: octokit percent-encodes slashes inside path parameters (e.g. a
        // git ref like "heads/my-branch" becomes ".../git/refs/heads%2Fmy-branch"), so routes below can match
        // plain "heads/my-branch" text without each one needing its own decoding logic.
        const pathname = decodeURIComponent(url.pathname);
        try {
            const body = await readJsonBody(req);
            const match = matchPath(this.routes, req.method ?? "GET", pathname);
            if (!match) {
                // 404, not 501: octokit's built-in retry plugin retries any error status except a small
                // allow-list (400/401/403/404/410/422/451) — a 5xx-shaped "not implemented" response would
                // silently retry 3 times with backoff before failing, turning a fast, clear test failure into a
                // multi-second timeout. 404 fails immediately and is still an accurate "this doesn't exist".
                respondJson(res, 404, {
                    message: `Fake GitHub server has no route for ${req.method} ${pathname} — add it to fakeGithub/server.ts if release-svp now needs it.`,
                });
                return;
            }
            const result = match.handle(match.params, body, url);
            respondJson(res, 200, result);
        } catch (e) {
            if (e instanceof FakeNotFoundError) {
                respondJson(res, 404, { message: e.message });
            } else if (e instanceof FakeAlreadyExistsError) {
                respondJson(res, 422, { message: e.message, errors: [{ code: e.code }] });
            } else {
                respondJson(res, 500, { message: e instanceof Error ? e.message : String(e) });
            }
        }
    }
}

export async function startFakeGithubServer(state: RepoState): Promise<{ server: FakeGithubServer; url: string }> {
    const server = new FakeGithubServer(state);
    const url = await server.listen();
    return { server, url };
}

function matchPath(routes: RouteMatch[], method: string, pathname: string): { handle: RouteMatch["handle"]; params: string[] } | undefined {
    for (const route of routes) {
        if (route.method !== method) {
            continue;
        }
        const match = route.pattern.exec(pathname);
        if (match) {
            return { handle: route.handle, params: match.slice(1) };
        }
    }
    return undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : undefined;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body ?? {});
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(payload);
}

// ---- Route table ----

function buildRoutes(state: RepoState): RouteMatch[] {
    const repoPath = `/repos/${state.owner}/${state.repo}`;
    const escapedRepoPath = repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return [
        // GET /repos/{owner}/{repo}
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}$`),
            handle: () => ({ default_branch: state.defaultBranch }),
        },
        // GET /repos/{owner}/{repo}/branches/{branch}
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}/branches/(.+)$`),
            handle: params => ({ commit: { sha: state.getRef(`heads/${params[0]}`) } }),
        },
        // GET /repos/{owner}/{repo}/git/ref/heads/{branch}   (octokit passes ref = "heads/{branch}")
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}/git/ref/(heads/.+)$`),
            handle: params => ({ ref: `refs/${params[0]}`, object: { sha: state.getRef(params[0]) } }),
        },
        // POST /repos/{owner}/{repo}/git/refs
        {
            method: "POST",
            pattern: new RegExp(`^${escapedRepoPath}/git/refs$`),
            handle: (_params, body) => {
                state.createRef(body.ref, body.sha);
                return { ref: body.ref, object: { sha: body.sha }, url: `${repoPath}/git/${body.ref}` };
            },
        },
        // PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}
        {
            method: "PATCH",
            pattern: new RegExp(`^${escapedRepoPath}/git/refs/(heads/.+)$`),
            handle: (params, body) => {
                state.updateRef(params[0], body.sha);
                return { ref: `refs/${params[0]}`, object: { sha: body.sha } };
            },
        },
        // GET /repos/{owner}/{repo}/git/commits/{sha}
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}/git/commits/([0-9a-f]+)$`),
            handle: params => {
                const commit = state.getCommitOrThrow(params[0]);
                return { sha: commit.sha, tree: { sha: commit.treeSha }, message: commit.message, parents: commit.parents.map(sha => ({ sha })) };
            },
        },
        // POST /repos/{owner}/{repo}/git/trees
        {
            method: "POST",
            pattern: new RegExp(`^${escapedRepoPath}/git/trees$`),
            handle: (_params, body) => ({ sha: state.createTree(body.base_tree, body.tree) }),
        },
        // POST /repos/{owner}/{repo}/git/commits
        {
            method: "POST",
            pattern: new RegExp(`^${escapedRepoPath}/git/commits$`),
            handle: (_params, body) => {
                const sha = state.createCommit({ treeSha: body.tree, parents: body.parents ?? [], message: body.message });
                return { sha, url: `${repoPath}/git/commits/${sha}` };
            },
        },
        // GET /repos/{owner}/{repo}/git/trees/{sha}
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}/git/trees/([0-9a-zA-Z-_]+)$`),
            handle: params => ({ tree: state.getRecursiveTreeByReference(params[0]), truncated: false }),
        },
        // GET /repos/{owner}/{repo}/git/blobs/{sha}
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}/git/blobs/([0-9a-f]+)$`),
            handle: params => ({ sha: params[0], content: Buffer.from(state.getBlob(params[0]), "utf8").toString("base64"), encoding: "base64" }),
        },
        // GET /repos/{owner}/{repo}/pulls?head=owner:branch&state=open|closed|all
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}/pulls$`),
            handle: (_params, _body, url) => {
                const head = url.searchParams.get("head");
                const headBranch = head?.includes(":") ? head.split(":")[1] : head;
                // Real GitHub defaults this endpoint to `state=open` when the query omits it — code-suggester's
                // own existing-PR reuse check (github/open-pull-request.js) relies on that default (it never
                // passes `state` itself) to only ever find a still-open PR on the branch, never a previously
                // merged/closed one from an earlier release cycle on that same, reused branch name.
                const stateFilter = url.searchParams.get("state") ?? "open";
                return state.pullRequests
                    .filter(pr => !headBranch || pr.headBranch === headBranch)
                    .filter(pr => stateFilter === "all" || pr.state === stateFilter)
                    .map(pr => toPullRequestResponse(pr, state.owner));
            },
        },
        // POST /repos/{owner}/{repo}/pulls
        {
            method: "POST",
            pattern: new RegExp(`^${escapedRepoPath}/pulls$`),
            handle: (_params, body) => {
                const headBranch = (body.head as string).includes(":") ? (body.head as string).split(":")[1] : body.head;
                const pr = state.createPullRequest({ title: body.title, body: body.body ?? "", headBranch, baseBranch: body.base });
                return toPullRequestResponse(pr, state.owner);
            },
        },
        // PATCH /repos/{owner}/{repo}/pulls/{number}
        {
            method: "PATCH",
            pattern: new RegExp(`^${escapedRepoPath}/pulls/(\\d+)$`),
            handle: (params, body) => toPullRequestResponse(state.updatePullRequest(Number(params[0]), body), state.owner),
        },
        // GET /repos/{owner}/{repo}/pulls/{number}
        {
            method: "GET",
            pattern: new RegExp(`^${escapedRepoPath}/pulls/(\\d+)$`),
            handle: params => toPullRequestResponse(state.getPullRequestOrThrow(Number(params[0])), state.owner),
        },
        // POST /repos/{owner}/{repo}/releases
        {
            method: "POST",
            pattern: new RegExp(`^${escapedRepoPath}/releases$`),
            handle: (_params, body) => {
                const release = state.createRelease({
                    tagName: body.tag_name,
                    name: body.name ?? body.tag_name,
                    body: body.body ?? "",
                    targetCommitish: body.target_commitish ?? state.defaultBranch,
                });
                return { id: release.id, html_url: `https://example.invalid/${state.owner}/${state.repo}/releases/tag/${release.tagName}` };
            },
        },
        // POST /repos/{owner}/{repo}/issues/{number}/comments
        {
            method: "POST",
            pattern: new RegExp(`^${escapedRepoPath}/issues/(\\d+)/comments$`),
            handle: params => ({ html_url: `https://example.invalid/${state.owner}/${state.repo}/issues/${params[0]}#comment` }),
        },
        // POST /repos/{owner}/{repo}/issues/{number}/labels
        {
            method: "POST",
            pattern: new RegExp(`^${escapedRepoPath}/issues/(\\d+)/labels$`),
            handle: (params, body) => {
                state.addLabels(Number(params[0]), body.labels ?? []);
                return state.getPullRequestOrThrow(Number(params[0])).labels.map(name => ({ name }));
            },
        },
        // DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}
        {
            method: "DELETE",
            pattern: new RegExp(`^${escapedRepoPath}/issues/(\\d+)/labels/(.+)$`),
            handle: params => {
                state.removeLabel(Number(params[0]), params[1]);
                return {};
            },
        },
        // POST /graphql
        {
            method: "POST",
            pattern: /^\/graphql$/,
            // Real GraphQL responses are wrapped in a `{ data: ... }` envelope, which `octokit.graphql()` unwraps
            // itself — returning the payload unwrapped here would make every GraphQL call resolve to `undefined`.
            handle: (_params, body) => ({ data: handleGraphQl(state, body.query as string, body.variables ?? {}) }),
        },
    ];
}

function toPullRequestResponse(pr: ReturnType<RepoState["getPullRequestOrThrow"]>, owner: string) {
    return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        merged: pr.merged,
        // `label` must be "owner:branch" (matching real GitHub's REST API), not just the bare branch name —
        // `code-suggester`'s own existing-PR reuse check (github/open-pull-request.js) matches on this exact
        // format (`${origin.owner}:${origin.branch}`), so a bare branch name here would make it never find an
        // already-open PR on the same branch and always create a duplicate instead of updating it.
        head: { ref: pr.headBranch, label: `${owner}:${pr.headBranch}` },
        base: { ref: pr.baseBranch },
        labels: pr.labels.map(name => ({ name })),
        _links: { html: { href: `https://example.invalid/pull/${pr.number}` } },
    };
}

// GraphQL queries are matched by name (the fixed set release-svp ships in src/graphql/*.graphql — see the
// `query <name>(...)` declaration in each file) rather than by parsing/executing a real GraphQL schema, since
// release-svp only ever sends these four specific documents.
function handleGraphQl(state: RepoState, query: string, variables: Record<string, any>): unknown {
    const name = /query\s+(\w+)/.exec(query)?.[1];
    switch (name) {
        case "latestTags":
            return handleLatestTags(state, variables);
        case "pullRequestsSince":
            return handlePullRequestsSince(state, variables);
        case "mergedPullRequests":
            return handleMergedPullRequests(state, variables);
        case "pullRequestFiles":
            return handlePullRequestFiles(state, variables);
        default:
            throw new Error(`Fake GitHub server received an unrecognized GraphQL query (no case for name '${name}') — add it to handleGraphQl in fakeGithub/server.ts.`);
    }
}

function handleLatestTags(state: RepoState) {
    const tags = [...state.tags.values()].sort((a, b) => b.committedDate.localeCompare(a.committedDate));
    return {
        repository: {
            refs: {
                nodes: tags.map(tag => ({
                    name: tag.name,
                    target: { oid: tag.commitSha, committedDate: tag.committedDate, messageHeadline: state.commits.get(tag.commitSha)?.message ?? "" },
                })),
                pageInfo: { hasNextPage: false, endCursor: undefined },
            },
        },
    };
}

// Walks the target branch's history back from its current head via commit parents. Only follows first parents,
// which is enough for the fake's linear/merge-commit history shapes (see RepoState#mergePullRequest) — release-svp
// itself only ever needs "commits reachable on this branch", not a full merge-graph traversal.
function walkHistory(state: RepoState, targetBranch: string): ReturnType<RepoState["getCommitOrThrow"]>[] {
    const headSha = state.branches.get(targetBranch);
    const history: ReturnType<RepoState["getCommitOrThrow"]>[] = [];
    let cursor = headSha;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const commit = state.commits.get(cursor);
        if (!commit) {
            break;
        }
        history.push(commit);
        cursor = commit.parents[0];
    }
    return history;
}

function handlePullRequestsSince(state: RepoState, variables: Record<string, any>) {
    const history = walkHistory(state, variables.targetBranch);
    const associatedPrByMergeSha = new Map(state.pullRequests.filter(pr => pr.mergeCommitSha).map(pr => [pr.mergeCommitSha, pr]));
    return {
        repository: {
            ref: {
                target: {
                    history: {
                        nodes: history.map(commit => {
                            const pr = associatedPrByMergeSha.get(commit.sha);
                            return {
                                sha: commit.sha,
                                message: commit.message,
                                associatedPullRequests: { nodes: pr ? [toGraphQlPullRequest(pr)] : [] },
                            };
                        }),
                        pageInfo: { hasNextPage: false, endCursor: undefined },
                    },
                },
            },
        },
    };
}

function handleMergedPullRequests(state: RepoState, variables: Record<string, any>) {
    const states: string[] = variables.states ?? ["MERGED"];
    const matches = state.pullRequests.filter(pr => {
        if (pr.baseBranch !== variables.targetBranch) {
            return false;
        }
        if (states.includes("MERGED")) {
            return pr.merged;
        }
        if (states.includes("OPEN")) {
            return pr.state === "open";
        }
        if (states.includes("CLOSED")) {
            return pr.state === "closed";
        }
        return false;
    });
    return {
        repository: {
            pullRequests: {
                nodes: matches.map(toGraphQlPullRequest),
                pageInfo: { hasNextPage: false, endCursor: undefined },
            },
        },
    };
}

function handlePullRequestFiles() {
    // release-svp only falls back to this query when a PR's file list didn't fully fit on the first page of
    // `mergedPullRequests`/`pullRequestsSince` (see fetchRemainingChangedFilePaths in src/github.ts). None of the
    // fake's fixtures produce PRs with >100 changed files, so this path is intentionally unimplemented for now —
    // fail loudly rather than guess a shape, so a future oversized-PR fixture surfaces this as a clear gap.
    throw new Error("Fake GitHub server does not implement pullRequestFiles pagination yet (no fixture needs >100 changed files per PR).");
}

function toGraphQlPullRequest(pr: ReturnType<RepoState["getPullRequestOrThrow"]>) {
    return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        permalink: `https://example.invalid/pull/${pr.number}`,
        baseRefName: pr.baseBranch,
        headRefName: pr.headBranch,
        mergeCommit: pr.mergeCommitSha ? { oid: pr.mergeCommitSha } : null,
        labels: { nodes: pr.labels.map(name => ({ name })) },
        files: { nodes: pr.changedFilePaths.map(path => ({ path })), pageInfo: { hasNextPage: false, endCursor: undefined } },
    };
}
