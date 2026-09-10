// In-memory model of "just enough GitHub" for release-svp's integration tests: git refs/commits/trees/blobs,
// pull requests, labels, and releases. This deliberately does NOT model the real GitHub API in general — only
// the exact subset of state and transitions release-svp (and the `code-suggester` library it uses to open pull
// requests) actually reads or writes. See fakeGithub/server.ts for the HTTP surface built on top of this.

export interface FakeCommit {
    sha: string;
    treeSha: string;
    parents: string[];
    message: string;
}

// Trees are stored already-flattened (as if `recursive=true` had been fully resolved) rather than as a real
// nested tree-of-trees graph. release-svp only ever reads trees recursively (via git-file-utils) and only ever
// writes them via `code-suggester`'s flat changeset-overlay approach (see RepoState#createTree) — a real
// nested-subtree model would add complexity with no behavior this tool actually exercises.
export interface FakeTreeEntry {
    path: string;
    mode: string;
    type: "blob";
    sha: string;
}

export interface FakePullRequest {
    number: number;
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
    state: "open" | "closed";
    labels: string[];
    merged: boolean;
    mergeCommitSha?: string;
    // Paths of files this pull request changes, relative to the repo root — mirrors GitHub's real
    // `pullRequest.files` GraphQL field, which release-svp's component path filtering depends on (see
    // componentPathFilter.ts). Fixtures set this via `createPullRequest`'s `changedFilePaths` option; a PR with
    // none is a legitimate empty diff and is (correctly, matching production behaviour) excluded from every
    // component's unreleased commits.
    changedFilePaths: string[];
}

export interface FakeTag {
    name: string;
    commitSha: string;
    committedDate: string;
}

export interface FakeRelease {
    id: number;
    tagName: string;
    name: string;
    body: string;
    prerelease: boolean;
}

export interface SeedCommitOptions {
    // Files present *after* this commit, as a full path -> content snapshot (not a diff) — simplest possible
    // authoring model for fixtures, since integration tests build up a repo's history from scratch anyway.
    files: Record<string, string>;
    message: string;
    // Defaults to the current default branch's head, i.e. "the next commit on top of history so far".
    parentSha?: string;
}

// Thrown by operations that mirror a real GitHub 404 (e.g. a ref lookup for a branch that doesn't exist yet).
// Mirrors the shape callers already check for (`err.status === 404`) via octokit's own RequestError.
export class FakeNotFoundError extends Error {
    status = 404;
}

// Thrown by operations that mirror a real GitHub 422 "already exists" (e.g. creating a release for a tag that
// already has one) — the one error shape `Github.createRelease` specifically detects and rethrows as
// `DuplicateReleaseError`.
export class FakeAlreadyExistsError extends Error {
    status = 422;
    code = "already_exists";
}

let shaCounter = 0;
// Fake SHAs only need to be unique and 40-hex-char-shaped (several call sites/tests may sanity-check length);
// they are never meant to be verifiable git object hashes.
function nextSha(): string {
    shaCounter += 1;
    return shaCounter.toString(16).padStart(40, "0");
}

export class RepoState {
    readonly owner: string;
    readonly repo: string;
    readonly defaultBranch: string;

    // branch name -> head commit sha
    readonly branches = new Map<string, string>();
    readonly commits = new Map<string, FakeCommit>();
    readonly trees = new Map<string, FakeTreeEntry[]>();
    readonly blobs = new Map<string, string>();
    readonly tags = new Map<string, FakeTag>();
    readonly pullRequests: FakePullRequest[] = [];
    readonly releases: FakeRelease[] = [];
    private nextPullRequestNumber = 1;

    constructor(options: { owner: string; repo: string; defaultBranch?: string }) {
        this.owner = options.owner;
        this.repo = options.repo;
        this.defaultBranch = options.defaultBranch ?? "main";
    }

    // ---- Fixture-authoring API (called directly by test setup, not over HTTP) ----

    // Creates a commit (and the blobs/tree it needs) on top of `parentSha` (defaulting to the default branch's
    // current head) and moves the default branch to point at it. Returns the new commit sha.
    seedCommit(options: SeedCommitOptions): string {
        const parentSha = options.parentSha ?? this.branches.get(this.defaultBranch);
        const baseEntries = parentSha ? this.getRecursiveTree(this.getCommitOrThrow(parentSha).treeSha) : [];
        const entries = this.overlayFiles(baseEntries, options.files);
        const treeSha = this.storeTree(entries);
        const commitSha = this.storeCommit({
            treeSha,
            parents: parentSha ? [parentSha] : [],
            message: options.message,
        });
        this.branches.set(this.defaultBranch, commitSha);
        return commitSha;
    }

    seedTag(name: string, commitSha: string, committedDate: string): void {
        this.tags.set(name, { name, commitSha, committedDate });
    }

    setBranchHead(branch: string, commitSha: string): void {
        this.branches.set(branch, commitSha);
    }

    // Reads a single file's content at a branch's current head — used by scenario tests to assert on actual
    // release-file content (Cargo.toml/Cargo.lock/CHANGELOG.md), not just labels/tags/releases. Returns
    // `undefined` if the branch or path doesn't exist, mirroring "not found" rather than throwing, since a test
    // asserting a file was NOT touched is just as legitimate as one asserting it was.
    getFileContent(branch: string, path: string): string | undefined {
        const headSha = this.branches.get(branch);
        if (!headSha) {
            return undefined;
        }
        const entry = this.getRecursiveTree(this.getCommitOrThrow(headSha).treeSha).find(e => e.path === path);
        return entry ? this.blobs.get(entry.sha) : undefined;
    }

    // ---- Git data API (mirrors github.com/repos/{owner}/{repo}/git/*) ----

    getRef(ref: string): string {
        const branch = stripHeadsPrefix(ref);
        const sha = this.branches.get(branch);
        if (!sha) {
            throw new FakeNotFoundError(`No ref found for ${ref}`);
        }
        return sha;
    }

    createRef(ref: string, sha: string): void {
        const branch = stripHeadsPrefix(ref);
        this.getCommitOrThrow(sha);
        this.branches.set(branch, sha);
    }

    updateRef(ref: string, sha: string): void {
        const branch = stripHeadsPrefix(ref);
        this.getCommitOrThrow(sha);
        this.branches.set(branch, sha);
    }

    getCommitOrThrow(sha: string): FakeCommit {
        const commit = this.commits.get(sha);
        if (!commit) {
            throw new FakeNotFoundError(`No commit found for sha ${sha}`);
        }
        return commit;
    }

    // `base` is either a tree sha or a commit-ish (branch name/commit sha) — mirrors `git.getTree`'s `tree_sha`
    // accepting both, which `git-file-utils` relies on (it calls `getTree(branch)` directly).
    getRecursiveTreeByReference(base: string): FakeTreeEntry[] {
        const branchHead = this.branches.get(base);
        if (branchHead) {
            return this.getRecursiveTree(this.getCommitOrThrow(branchHead).treeSha);
        }
        const commit = this.commits.get(base);
        if (commit) {
            return this.getRecursiveTree(commit.treeSha);
        }
        return this.getRecursiveTree(base);
    }

    getBlob(sha: string): string {
        const content = this.blobs.get(sha);
        if (content === undefined) {
            throw new FakeNotFoundError(`No blob found for sha ${sha}`);
        }
        return content;
    }

    // Mirrors `code-suggester`'s tree-building: a flat list of changed-file entries overlaid onto `baseTreeSha`
    // (deletions expressed as `sha: null`). Returns the new tree's sha.
    createTree(baseTreeSha: string, entries: { path: string; mode: string; content?: string; sha?: string | null }[]): string {
        const base = this.getRecursiveTree(baseTreeSha);
        const byPath = new Map(base.map(entry => [entry.path, entry]));
        for (const entry of entries) {
            if (entry.sha === null) {
                byPath.delete(entry.path);
                continue;
            }
            const blobSha = entry.content !== undefined ? this.storeBlob(entry.content) : nextSha();
            byPath.set(entry.path, { path: entry.path, mode: entry.mode, type: "blob", sha: blobSha });
        }
        return this.storeTree([...byPath.values()]);
    }

    createCommit(options: { treeSha: string; parents: string[]; message: string }): string {
        return this.storeCommit(options);
    }

    // ---- Pull requests (mirrors REST pulls.* + issues.* label/comment endpoints) ----

    findOpenPullRequestByHeadBranch(headBranch: string): FakePullRequest | undefined {
        return this.pullRequests.find(pr => pr.headBranch === headBranch && pr.state === "open");
    }

    createPullRequest(options: { title: string; body: string; headBranch: string; baseBranch: string; labels?: string[]; changedFilePaths?: string[] }): FakePullRequest {
        const pr: FakePullRequest = {
            number: this.nextPullRequestNumber++,
            title: options.title,
            body: options.body,
            headBranch: options.headBranch,
            baseBranch: options.baseBranch,
            state: "open",
            labels: options.labels ?? [],
            merged: false,
            changedFilePaths: options.changedFilePaths ?? [],
        };
        this.pullRequests.push(pr);
        return pr;
    }

    getPullRequestOrThrow(number: number): FakePullRequest {
        const pr = this.pullRequests.find(p => p.number === number);
        if (!pr) {
            throw new FakeNotFoundError(`No pull request found for number ${number}`);
        }
        return pr;
    }

    updatePullRequest(number: number, patch: Partial<Pick<FakePullRequest, "title" | "body" | "state">>): FakePullRequest {
        const pr = this.getPullRequestOrThrow(number);
        Object.assign(pr, patch);
        return pr;
    }

    addLabels(number: number, labels: string[]): void {
        const pr = this.getPullRequestOrThrow(number);
        for (const label of labels) {
            if (!pr.labels.includes(label)) {
                pr.labels.push(label);
            }
        }
    }

    removeLabel(number: number, label: string): void {
        const pr = this.getPullRequestOrThrow(number);
        pr.labels = pr.labels.filter(existing => existing !== label);
    }

    // Merges a pull request as if a human had clicked "Merge" on GitHub: fast-forwards the base branch to a new
    // merge commit and marks the PR merged. Test fixtures call this directly (no "merge" REST endpoint is
    // exercised by release-svp itself, so the fake server doesn't need to expose one over HTTP).
    mergePullRequest(number: number): FakePullRequest {
        const pr = this.getPullRequestOrThrow(number);
        const headSha = this.getRef(`heads/${pr.headBranch}`);
        const baseSha = this.getRef(`heads/${pr.baseBranch}`);
        const mergeCommitSha = this.storeCommit({
            treeSha: this.getCommitOrThrow(headSha).treeSha,
            parents: [baseSha, headSha],
            message: `Merge pull request #${pr.number} from ${pr.headBranch}`,
        });
        this.branches.set(pr.baseBranch, mergeCommitSha);
        pr.state = "closed";
        pr.merged = true;
        pr.mergeCommitSha = mergeCommitSha;
        return pr;
    }

    createRelease(options: { tagName: string; name: string; body: string; targetCommitish: string; prerelease: boolean }): FakeRelease {
        if (this.releases.some(release => release.tagName === options.tagName)) {
            throw new FakeAlreadyExistsError(`Release already exists for tag ${options.tagName}`);
        }
        if (!this.tags.has(options.tagName)) {
            // Mirrors real GitHub: creating a release for a tag that doesn't exist yet creates a lightweight tag.
            this.seedTag(options.tagName, options.targetCommitish, new Date().toISOString());
        }
        const release: FakeRelease = {
            id: this.releases.length + 1,
            tagName: options.tagName,
            name: options.name,
            body: options.body,
            prerelease: options.prerelease,
        };
        this.releases.push(release);
        return release;
    }

    // ---- internals ----

    private getRecursiveTree(treeSha: string): FakeTreeEntry[] {
        const tree = this.trees.get(treeSha);
        if (!tree) {
            throw new FakeNotFoundError(`No tree found for sha ${treeSha}`);
        }
        return tree;
    }

    private overlayFiles(base: FakeTreeEntry[], files: Record<string, string>): FakeTreeEntry[] {
        const byPath = new Map(base.map(entry => [entry.path, entry]));
        for (const [path, content] of Object.entries(files)) {
            byPath.set(path, { path, mode: "100644", type: "blob", sha: this.storeBlob(content) });
        }
        return [...byPath.values()];
    }

    private storeBlob(content: string): string {
        const sha = nextSha();
        this.blobs.set(sha, content);
        return sha;
    }

    private storeTree(entries: FakeTreeEntry[]): string {
        const sha = nextSha();
        this.trees.set(sha, entries);
        return sha;
    }

    private storeCommit(options: { treeSha: string; parents: string[]; message: string }): string {
        const sha = nextSha();
        this.commits.set(sha, { sha, ...options });
        return sha;
    }
}

function stripHeadsPrefix(ref: string): string {
    return ref.replace(/^(refs\/)?heads\//, "");
}
