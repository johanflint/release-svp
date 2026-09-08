import {
    DEFAULT_FILE_MODE,
    FileNotFoundError,
    GitHubFileContents,
    RepositoryFileCache
} from "@google-automations/git-file-utils";
import { Octokit as RestOctokit } from "@octokit/rest";
import { createPullRequest } from "code-suggester";
import { Octokit, RequestError } from "octokit";
import { RequestError as RequestErrorBody } from "@octokit/types";
import { Commit, PullRequest } from "./commit";
import { ConcurrencyLimit } from "./concurrencyLimit";
import associatedPullRequestsQuery from "./graphql/associatedPullRequests.graphql";
import latestTagsQuery from "./graphql/latestTags.graphql";
import mergedPullRequestsQuery from "./graphql/mergedPullRequests.graphql";
import pullRequestFilesQuery from "./graphql/pullRequestFiles.graphql";
import pullRequestLabelsQuery from "./graphql/pullRequestLabels.graphql";
import pullRequestsSinceQuery from "./graphql/pullRequestsSince.graphql";
import { Logger } from "./logger";
import { Release } from "./release";
import { Repository } from "./repository";
import { Tag } from "./tag";
import { Update } from "./update";

// Safety ceiling on how many *additional* pages of changed files to fetch for a single pull request (beyond the
// first page already included in the bulk commit/PR query), so a pathological or misbehaving response can't
// cause an unbounded number of follow-up requests — see fetchRemainingChangedFilePaths below. 50 pages of 100
// files each covers pull requests with up to 5,000 changed files, comfortably more than any real-world PR.
const MAX_ADDITIONAL_CHANGED_FILE_PAGES = 50;

// Bounds how many pull requests' follow-up changed-file pagination (see fetchRemainingChangedFilePaths) can be
// in flight at once. A page of commits/PRs is otherwise mapped fully concurrently (see mergeCommitsGraphQL /
// pullRequestsGraphQL), which is fine for the common case (a PR's files fit on the first page, no extra
// requests needed) but could otherwise let several oversized PRs in the same page each fire off a burst of
// follow-up requests simultaneously, risking GitHub's secondary/abuse rate limiting. Deliberately small and
// conservative — this path is already the rare case, so there's no performance reason to raise it.
const MAX_CONCURRENT_CHANGED_FILE_PAGINATIONS = 2;

// Thrown when a pull request's full changed-file list cannot be obtained (pagination exhausted the safety
// limit, or a follow-up request failed/returned malformed pagination data). Callers must not guess component
// ownership from a partial file list — see extractChangedFilePaths/fetchRemainingChangedFilePaths.
export class PullRequestFilesIncompleteError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "PullRequestFilesIncompleteError";
    }
}

// Mirrors MAX_ADDITIONAL_CHANGED_FILE_PAGES, but for labels: 20 additional pages of 100 covers pull requests
// with up to 2,100 labels (counting the first page already included in the bulk query), comfortably more than
// any real pull request could ever carry.
const MAX_ADDITIONAL_LABEL_PAGES = 20;

// Mirrors MAX_CONCURRENT_CHANGED_FILE_PAGINATIONS, but for the label follow-up pagination below.
const MAX_CONCURRENT_LABEL_PAGINATIONS = 2;

// Thrown when a pull request's full label list cannot be obtained (pagination exhausted the safety limit, or a
// follow-up request failed/returned malformed pagination data). Labels drive both version-bump classification
// and release-pull-request identification (see versioningStrategy.ts, determineReleases.ts) — silently
// proceeding with a truncated label list risks misclassifying a pull request (e.g. missing a "feat"/"!" label
// past the first page) exactly as badly as guessing from a partial changed-file list would — see
// extractLabels/fetchRemainingLabels.
export class PullRequestLabelsIncompleteError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "PullRequestLabelsIncompleteError";
    }
}

// Mirrors MAX_ADDITIONAL_LABEL_PAGES, but for a commit's associated pull requests: 20 additional pages of 100
// covers up to 2,100 pull requests associated with a single commit (counting the first page already included
// in the bulk query) — a generous ceiling, since a commit legitimately having more than a handful of associated
// pull requests (e.g. cherry-picks/backports referencing the same commit) is already unusual.
const MAX_ADDITIONAL_ASSOCIATED_PULL_REQUEST_PAGES = 20;

// Mirrors MAX_CONCURRENT_LABEL_PAGINATIONS, but for the associated-pull-request follow-up pagination below.
const MAX_CONCURRENT_ASSOCIATED_PULL_REQUEST_PAGINATIONS = 2;

// Thrown when a commit's full associated-pull-requests list cannot be obtained (pagination exhausted the
// safety limit, or a follow-up request failed/returned malformed pagination data). mergeCommitsGraphQL uses
// this list to find the pull request whose merge actually produced the commit (matching on mergeCommit.oid) —
// silently proceeding with a truncated list risks missing that match for a commit whose real merge-matching
// pull request fell past the first page, which would wrongly treat the commit as not a merge commit at all
// (see mergeCommitsGraphQL's isMergeCommit) and silently skip its label-driven version bump.
export class AssociatedPullRequestsIncompleteError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "AssociatedPullRequestsIncompleteError";
    }
}

export class Github {
    private readonly repository: Repository;
    private readonly octokit: Octokit;
    private readonly restOctokit: RestOctokit;
    private readonly fileCache: RepositoryFileCache;
    // Shared across every call the instance makes (not per fetched page) — see MAX_CONCURRENT_CHANGED_FILE_PAGINATIONS.
    private readonly changedFilesPaginationLimit = new ConcurrencyLimit(MAX_CONCURRENT_CHANGED_FILE_PAGINATIONS);
    // Shared across every call the instance makes (not per fetched page) — see MAX_CONCURRENT_LABEL_PAGINATIONS.
    private readonly labelsPaginationLimit = new ConcurrencyLimit(MAX_CONCURRENT_LABEL_PAGINATIONS);
    // Shared across every call the instance makes (not per fetched page) — see MAX_CONCURRENT_ASSOCIATED_PULL_REQUEST_PAGINATIONS.
    private readonly associatedPullRequestsPaginationLimit = new ConcurrencyLimit(MAX_CONCURRENT_ASSOCIATED_PULL_REQUEST_PAGINATIONS);
    // Repo-wide tags and a branch's merge commits are identical for every component (neither query is scoped to
    // one component) — one `ManifestRunner` run calls `tagIterator`/`mergeCommitIterator` once per configured
    // component (see manifestRunner.ts, determineReleaseContext.ts, determineReleases.ts), so without this cache
    // a monorepo with N components would re-fetch/re-paginate the exact same tag list and commit history N
    // times over. Caching per `Github` instance (rather than e.g. per call) is deliberate: one instance's
    // lifetime is exactly one CLI invocation (one `prepare()` or `release()` run — see ManifestRunner.create()),
    // so this never risks serving stale data across separate runs.
    private tagsCache?: MemoizedAsyncIterable<Tag>;
    private readonly mergeCommitsCacheByBranch = new Map<string, MemoizedAsyncIterable<Commit>>();

    constructor(
        repository: Repository,
        token: string,
        private readonly logger: Logger,
        // `baseUrl` is only ever set by tests (e.g. to point both clients at an in-process fake GitHub API
        // server); production call sites never pass it, so `undefined` keeps today's real-GitHub-API behavior
        // unchanged. `disableThrottling` is likewise test-only: octokit's default write-request throttling (see
        // `@octokit/plugin-throttling`, a 1 request/sec minimum spacing meant to avoid tripping GitHub's real
        // abuse detection) is exactly the right default against the real API, but serves no purpose — and
        // meaningfully slows down every test run — against an in-process fake server that has no such limits.
        options?: { baseUrl?: string; disableThrottling?: boolean },
    ) {
        this.repository = repository;

        // The plain "octokit" package supplies its own default `throttle: { onRateLimit, onSecondaryRateLimit }`
        // handlers (required by `@octokit/plugin-throttling`, which throws at construction time if they're
        // missing). Passing our own `throttle` object entirely replaces that default rather than merging with
        // it, so `throttle` is only included here when actually disabling throttling for tests — otherwise
        // it's omitted so the package's own (valid) defaults apply untouched.
        this.octokit = new Octokit({
            auth: process.env.GITHUB_TOKEN || token,
            baseUrl: options?.baseUrl,
            ...(options?.disableThrottling ? { throttle: { enabled: false } } : {}),
        });
        this.restOctokit = new RestOctokit({
            auth: process.env.GITHUB_TOKEN || token,
            baseUrl: options?.baseUrl,
        });
        this.fileCache = new RepositoryFileCache(this.restOctokit, this.repository);
    }

    async retrieveDefaultBranch(): Promise<string> {
        const response = await this.octokit.rest.repos.get({ owner: this.repository.owner, repo: this.repository.repo });
        return response.data.default_branch;
    }

    async *tagIterator(maxResults?: number) {
        this.tagsCache ??= new MemoizedAsyncIterable<Tag>(paginate(cursor => this.tagsGraphQL(cursor)));
        yield* truncate(this.tagsCache, maxResults);
    }

    private async tagsGraphQL(cursor?: string): Promise<Tags | null> {
        this.logger.debug(`Fetching tags with cursor '${cursor}...`);
        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            count: 10,
        };
        const response: any = await this.octokit.graphql(latestTagsQuery, parameters);

        if (!response) {
            this.logger.warn(`No response received for query: ${latestTagsQuery}`, parameters)
            return null;
        }

        const refs = response.repository.refs;
        const tags = (refs.nodes || []) as GraphQLTag[];

        const mappedTags = tags.map<Tag>(tag => {
            const target = isLightweightTag(tag) ? tag.target : (tag as AnnotatedTag).target.target;
            return {
                sha: target.oid,
                name: tag.name,
                committedDate: target.committedDate,
            }
        });
        return {
            pageInfo: refs.pageInfo,
            data: mappedTags,
        }
    }

    async *mergeCommitIterator(branch: string, maxResults?: number) {
        let cache = this.mergeCommitsCacheByBranch.get(branch);
        if (!cache) {
            cache = new MemoizedAsyncIterable<Commit>(paginate(cursor => this.mergeCommitsGraphQL(branch, cursor)));
            this.mergeCommitsCacheByBranch.set(branch, cache);
        }
        yield* truncate(cache, maxResults);
    }

    private async mergeCommitsGraphQL(targetBranch: string, cursor?: string): Promise<CommitHistory | null> {
        this.logger.debug(`Fetching merge commits on branch '${targetBranch} with cursor '${cursor}'...`);
        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            count: 10,
            targetBranch,
        };
        const response: any = await this.octokit.graphql(pullRequestsSinceQuery, parameters);

        if (!response) {
            this.logger.warn(`No response received for query: ${pullRequestsSinceQuery}`, parameters)
            return null;
        }

        if (!response.repository?.ref) {
            this.logger.warn(`No commits found for branch '${targetBranch}'`);
            return null;
        }

        const history = response.repository.ref.target.history;
        const commits = (history.nodes || []) as GraphQLCommit[];

        const mappedCommits = await Promise.all(commits.map<Promise<Commit>>(async commit => {
            const associatedPullRequests = await this.extractAssociatedPullRequests(commit);
            const mergePullRequest = associatedPullRequests.find(pr => pr.mergeCommit?.oid === commit.sha);
            const associatedPullRequest = mergePullRequest || associatedPullRequests[0];
            const pullRequest: PullRequest | undefined = associatedPullRequest ? {
                sha: commit.sha,
                number: associatedPullRequest.number,
                title: associatedPullRequest.title,
                body: associatedPullRequest.body,
                permalink: associatedPullRequest.permalink,
                headBranchName: associatedPullRequest.headRefName,
                baseBranchName: associatedPullRequest.baseRefName,
                mergeCommitOid: associatedPullRequest.mergeCommit?.oid,
                labels: await this.extractLabels(associatedPullRequest, associatedPullRequest.number),
                ...await this.extractChangedFilePaths(associatedPullRequest, associatedPullRequest.number),
            } : undefined;

            return {
                sha: commit.sha,
                message: commit.message,
                isMergeCommit: mergePullRequest !== undefined,
                pullRequest,
            };
        }));

        return {
            pageInfo: history.pageInfo,
            data: mappedCommits,
        };
    }

    async createPullRequest(pullRequest: PullRequest, commitMessage: string, updates: Update[]): Promise<PullRequest> {
        const changeSet = await this.buildChangeSet(updates, pullRequest.baseBranchName);
        const pullRequestNumber = await createPullRequest(this.restOctokit, changeSet, {
            upstreamOwner: this.repository.owner,
            upstreamRepo: this.repository.repo,
            title: pullRequest.title,
            description: pullRequest.body,
            branch: pullRequest.headBranchName,
            primary: pullRequest.baseBranchName,
            force: true,
            fork: false,
            message: commitMessage,
            draft: false,
            labels: pullRequest.labels,
        });

        return await this.retrievePullRequest(pullRequestNumber);
    }

    async updatePullRequest(pullRequest: PullRequest, commitMessage: string, updates: Update[]): Promise<PullRequest> {
        const pr = await this.createPullRequest(pullRequest, commitMessage, updates);
        const response = await this.octokit.rest.pulls.update({
            owner: this.repository.owner,
            repo: this.repository.repo,
            pull_number: pr.number,
            title: pullRequest.title,
            body: pullRequest.body,
            state: "open",
        });
        return {
            number: response.data.number,
            title: response.data.title,
            body: response.data.body || "",
            permalink: response.data._links.html.href,
            headBranchName: response.data.head.ref,
            baseBranchName: response.data.base.ref,
            labels: response.data.labels
                .map(label => label.name)
                .filter(name => !!name) as string[],
        };
    }

    private async buildChangeSet(updates: Update[], targetBranch: string): Promise<ChangeSet> {
        const changeSet = new Map();
        for (const update of updates) {
            let content: GitHubFileContents | undefined;
            try {
                content = await this.retrieveFileContents(update.path, targetBranch);
            } catch (e) {
                if (!(e instanceof FileNotFoundError)) {
                    throw e;
                }
                if (!update.createIfMissing) {
                    this.logger.warn(`File '${update.path}' does not exist on branch '${targetBranch}'`);
                    continue;
                }
            }

            const contentText = content
                ? Buffer.from(content.content, "base64").toString('utf8')
                : undefined;
            const updatedContent = update.updater.updateContent(contentText);
            if (updatedContent) {
                changeSet.set(update.path, {
                    content: updatedContent,
                    originalContent: content?.parsedContent || null,
                    mode: content?.mode || DEFAULT_FILE_MODE,
                })
            }
        }

        return changeSet;
    }

    private async retrievePullRequest(pullRequestNumber: number): Promise<PullRequest> {
        const response = await this.octokit.rest.pulls.get({
            owner: this.repository.owner,
            repo: this.repository.repo,
            pull_number: pullRequestNumber,
        });
        return {
            number: response.data.number,
            title: response.data.title,
            body: response.data.body || "",
            permalink: response.data._links.html.href,
            headBranchName: response.data.head.ref,
            baseBranchName: response.data.base.ref,
            labels: response.data.labels
                .map(label => label.name)
                .filter(name => !!name) as string[],
        }
    }

    async *pullRequestIterator(targetBranch: string, status: "OPEN" | "CLOSED" | "MERGED" = "MERGED", maxResults?: number) {
        const fetchPage = (cursor?: string | undefined) => this.pullRequestsGraphQL(targetBranch, status, cursor);
        yield* paginate(fetchPage, maxResults);
    }

    private async pullRequestsGraphQL(targetBranch: string, status: "OPEN" | "CLOSED" | "MERGED" = "MERGED", cursor?: string): Promise<PullRequestHistory | null> {
        this.logger.debug(`Fetching pull requests on branch '${targetBranch}' with cursor '${cursor}'...`);
        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            count: 10,
            targetBranch,
            states: [status]
        };
        const response: any = await this.octokit.graphql(mergedPullRequestsQuery, parameters);

        if (!response?.repository?.pullRequests) {
            this.logger.warn(`Could not find pull requests for branch ${targetBranch}`);
            return null;
        }

        const pullRequests = (response.repository.pullRequests.nodes || []) as GraphQLPullRequest[];

        return {
            pageInfo: response.repository.pullRequests.pageInfo,
            data: await Promise.all(pullRequests.map(async pullRequest => {
                return {
                    sha: pullRequest.mergeCommit?.oid, // already filtered non-merged
                    number: pullRequest.number,
                    title: pullRequest.title,
                    body: pullRequest.body || '',
                    permalink: pullRequest.permalink,
                    headBranchName: pullRequest.headRefName,
                    baseBranchName: pullRequest.baseRefName,
                    mergeCommitOid: pullRequest.mergeCommit?.oid,
                    labels: await this.extractLabels(pullRequest, pullRequest.number),
                    // No changedFilePaths here — mergedPullRequests.graphql deliberately doesn't fetch files;
                    // see the GraphQLPullRequest.files comment.
                };
            })),
        };
    }

    // Extracts the full changed-file path list for a pull request, following GraphQL cursor pagination beyond
    // the bulk query's first page of 100 (see fetchRemainingChangedFilePaths) whenever the pull request touched
    // more files than that. Throws PullRequestFilesIncompleteError if the complete list cannot be obtained —
    // callers must not guess component ownership from a partial file list (see componentPathFilter.ts): for a
    // component release tool, silently assuming every component was touched by an under-fetched giant PR is
    // worse than failing that pull request's release determination outright.
    private async extractChangedFilePaths(pullRequest: GraphQLPullRequest, pullRequestNumber: number): Promise<Pick<PullRequest, "changedFilePaths">> {
        if (!pullRequest.files) {
            return {};
        }

        const firstPagePaths = pullRequest.files.nodes.map(node => node.path);
        if (!pullRequest.files.pageInfo.hasNextPage) {
            return { changedFilePaths: firstPagePaths };
        }

        const firstCursor = pullRequest.files.pageInfo.endCursor;
        if (!firstCursor) {
            throw new PullRequestFilesIncompleteError(`Pull request #${pullRequestNumber} has more changed files than fit on one page, but no pagination cursor was returned`);
        }

        return this.changedFilesPaginationLimit.run(() => this.fetchRemainingChangedFilePaths(pullRequestNumber, firstPagePaths, firstCursor));
    }

    // Follows GraphQL cursor pagination to fetch every remaining page of a pull request's changed files, beyond
    // the first page already fetched by the bulk commit/PR query. Bounded by MAX_ADDITIONAL_CHANGED_FILE_PAGES
    // so a pathological response can't cause unbounded follow-up requests. If that limit is hit, a follow-up
    // request fails outright, or a later page reports `hasNextPage` without an `endCursor` to follow, throws
    // PullRequestFilesIncompleteError rather than silently returning an incomplete file list as if it were
    // complete — see extractChangedFilePaths for why guessing here is unacceptable.
    private async fetchRemainingChangedFilePaths(pullRequestNumber: number, firstPagePaths: string[], firstCursor: string): Promise<Pick<PullRequest, "changedFilePaths">> {
        const paths = [...firstPagePaths];
        let cursor: string | undefined = firstCursor;
        let pagesFetched = 0;

        while (cursor !== undefined) {
            if (pagesFetched === MAX_ADDITIONAL_CHANGED_FILE_PAGES) {
                const maxFiles = (MAX_ADDITIONAL_CHANGED_FILE_PAGES + 1) * 100; // +1 for the first page already fetched
                throw new PullRequestFilesIncompleteError(`Pull request #${pullRequestNumber} has more than ${maxFiles} changed files, giving up on pagination`);
            }

            let page: Response<string> | null;
            try {
                page = await this.pullRequestFilesGraphQL(pullRequestNumber, cursor);
            } catch (e) {
                throw new PullRequestFilesIncompleteError(`Failed to fetch all changed files for pull request #${pullRequestNumber}`, { cause: e });
            }
            pagesFetched++;
            if (!page) {
                throw new PullRequestFilesIncompleteError(`No response fetching additional changed files for pull request #${pullRequestNumber}`);
            }

            paths.push(...page.data);
            if (!page.pageInfo.hasNextPage) {
                cursor = undefined;
            } else if (!page.pageInfo.endCursor) {
                throw new PullRequestFilesIncompleteError(`Pull request #${pullRequestNumber} has more changed files than fit on one page, but no pagination cursor was returned`);
            } else {
                cursor = page.pageInfo.endCursor;
            }
        }

        return { changedFilePaths: paths };
    }

    private async pullRequestFilesGraphQL(pullRequestNumber: number, cursor: string): Promise<Response<string> | null> {
        this.logger.debug(`Fetching additional changed files for pull request #${pullRequestNumber} with cursor '${cursor}'...`);
        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            number: pullRequestNumber,
        };
        const response: any = await this.octokit.graphql(pullRequestFilesQuery, parameters);

        if (!response?.repository?.pullRequest?.files) {
            this.logger.warn(`No response received for query: ${pullRequestFilesQuery}`, parameters);
            return null;
        }

        const files = response.repository.pullRequest.files;
        return {
            data: (files.nodes || []).map((node: { path: string }) => node.path),
            pageInfo: files.pageInfo,
        };
    }

    // Extracts the full label list for a pull request, following GraphQL cursor pagination beyond the bulk
    // query's first page of 100 (see fetchRemainingLabels) whenever the pull request carries more labels than
    // that. Throws PullRequestLabelsIncompleteError if the complete list cannot be obtained — callers must not
    // guess version-bump type or release-pull-request identity from a partial label list (see
    // determineReleases.ts, versioningStrategy.ts): silently proceeding as if an under-fetched label list were
    // complete risks the exact same kind of misclassification that an under-fetched file list would for
    // component ownership.
    private async extractLabels(pullRequest: GraphQLPullRequest, pullRequestNumber: number): Promise<string[]> {
        const firstPageLabels = pullRequest.labels.nodes.map(node => node.name);
        if (!pullRequest.labels.pageInfo.hasNextPage) {
            return firstPageLabels;
        }

        const firstCursor = pullRequest.labels.pageInfo.endCursor;
        if (!firstCursor) {
            throw new PullRequestLabelsIncompleteError(`Pull request #${pullRequestNumber} has more labels than fit on one page, but no pagination cursor was returned`);
        }

        return this.labelsPaginationLimit.run(() => this.fetchRemainingLabels(pullRequestNumber, firstPageLabels, firstCursor));
    }

    // Follows GraphQL cursor pagination to fetch every remaining page of a pull request's labels, beyond the
    // first page already fetched by the bulk commit/PR query. Bounded by MAX_ADDITIONAL_LABEL_PAGES so a
    // pathological response can't cause unbounded follow-up requests. If that limit is hit, a follow-up request
    // fails outright, or a later page reports `hasNextPage` without an `endCursor` to follow, throws
    // PullRequestLabelsIncompleteError rather than silently returning an incomplete label list as if it were
    // complete — see extractLabels for why guessing here is unacceptable.
    private async fetchRemainingLabels(pullRequestNumber: number, firstPageLabels: string[], firstCursor: string): Promise<string[]> {
        const labels = [...firstPageLabels];
        let cursor: string | undefined = firstCursor;
        let pagesFetched = 0;

        while (cursor !== undefined) {
            if (pagesFetched === MAX_ADDITIONAL_LABEL_PAGES) {
                const maxLabels = (MAX_ADDITIONAL_LABEL_PAGES + 1) * 100; // +1 for the first page already fetched
                throw new PullRequestLabelsIncompleteError(`Pull request #${pullRequestNumber} has more than ${maxLabels} labels, giving up on pagination`);
            }

            let page: Response<string> | null;
            try {
                page = await this.pullRequestLabelsGraphQL(pullRequestNumber, cursor);
            } catch (e) {
                throw new PullRequestLabelsIncompleteError(`Failed to fetch all labels for pull request #${pullRequestNumber}`, { cause: e });
            }
            pagesFetched++;
            if (!page) {
                throw new PullRequestLabelsIncompleteError(`No response fetching additional labels for pull request #${pullRequestNumber}`);
            }

            labels.push(...page.data);
            if (!page.pageInfo.hasNextPage) {
                cursor = undefined;
            } else if (!page.pageInfo.endCursor) {
                throw new PullRequestLabelsIncompleteError(`Pull request #${pullRequestNumber} has more labels than fit on one page, but no pagination cursor was returned`);
            } else {
                cursor = page.pageInfo.endCursor;
            }
        }

        return labels;
    }

    private async pullRequestLabelsGraphQL(pullRequestNumber: number, cursor: string): Promise<Response<string> | null> {
        this.logger.debug(`Fetching additional labels for pull request #${pullRequestNumber} with cursor '${cursor}'...`);
        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            number: pullRequestNumber,
        };
        const response: any = await this.octokit.graphql(pullRequestLabelsQuery, parameters);

        if (!response?.repository?.pullRequest?.labels) {
            this.logger.warn(`No response received for query: ${pullRequestLabelsQuery}`, parameters);
            return null;
        }

        const labels = response.repository.pullRequest.labels;
        return {
            data: (labels.nodes || []).map((node: { name: string }) => node.name),
            pageInfo: labels.pageInfo,
        };
    }

    // Extracts a commit's full associated-pull-request node list, following GraphQL cursor pagination beyond
    // the bulk query's first page of 100 (see fetchRemainingAssociatedPullRequests) whenever the commit has
    // more associated pull requests than that. Throws AssociatedPullRequestsIncompleteError if the complete
    // list cannot be obtained — mergeCommitsGraphQL must not guess which pull request actually merged this
    // commit from a partial list (see AssociatedPullRequestsIncompleteError for why).
    private async extractAssociatedPullRequests(commit: GraphQLCommit): Promise<GraphQLPullRequest[]> {
        const firstPageNodes = commit.associatedPullRequests.nodes;
        if (!commit.associatedPullRequests.pageInfo.hasNextPage) {
            return firstPageNodes;
        }

        const firstCursor = commit.associatedPullRequests.pageInfo.endCursor;
        if (!firstCursor) {
            throw new AssociatedPullRequestsIncompleteError(`Commit ${commit.sha} has more associated pull requests than fit on one page, but no pagination cursor was returned`);
        }

        return this.associatedPullRequestsPaginationLimit.run(() => this.fetchRemainingAssociatedPullRequests(commit.sha, firstPageNodes, firstCursor));
    }

    // Follows GraphQL cursor pagination to fetch every remaining page of a commit's associated pull requests,
    // beyond the first page already fetched by the bulk commit query. Bounded by
    // MAX_ADDITIONAL_ASSOCIATED_PULL_REQUEST_PAGES so a pathological response can't cause unbounded follow-up
    // requests. If that limit is hit, a follow-up request fails outright, or a later page reports
    // `hasNextPage` without an `endCursor` to follow, throws AssociatedPullRequestsIncompleteError rather than
    // silently returning an incomplete list as if it were complete — see extractAssociatedPullRequests.
    private async fetchRemainingAssociatedPullRequests(sha: string, firstPageNodes: GraphQLPullRequest[], firstCursor: string): Promise<GraphQLPullRequest[]> {
        const nodes = [...firstPageNodes];
        let cursor: string | undefined = firstCursor;
        let pagesFetched = 0;

        while (cursor !== undefined) {
            if (pagesFetched === MAX_ADDITIONAL_ASSOCIATED_PULL_REQUEST_PAGES) {
                const maxPullRequests = (MAX_ADDITIONAL_ASSOCIATED_PULL_REQUEST_PAGES + 1) * 100; // +1 for the first page already fetched
                throw new AssociatedPullRequestsIncompleteError(`Commit ${sha} has more than ${maxPullRequests} associated pull requests, giving up on pagination`);
            }

            let page: Response<GraphQLPullRequest> | null;
            try {
                page = await this.associatedPullRequestsGraphQL(sha, cursor);
            } catch (e) {
                throw new AssociatedPullRequestsIncompleteError(`Failed to fetch all associated pull requests for commit ${sha}`, { cause: e });
            }
            pagesFetched++;
            if (!page) {
                throw new AssociatedPullRequestsIncompleteError(`No response fetching additional associated pull requests for commit ${sha}`);
            }

            nodes.push(...page.data);
            if (!page.pageInfo.hasNextPage) {
                cursor = undefined;
            } else if (!page.pageInfo.endCursor) {
                throw new AssociatedPullRequestsIncompleteError(`Commit ${sha} has more associated pull requests than fit on one page, but no pagination cursor was returned`);
            } else {
                cursor = page.pageInfo.endCursor;
            }
        }

        return nodes;
    }

    private async associatedPullRequestsGraphQL(sha: string, cursor: string): Promise<Response<GraphQLPullRequest> | null> {
        this.logger.debug(`Fetching additional associated pull requests for commit ${sha} with cursor '${cursor}'...`);
        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            sha,
        };
        const response: any = await this.octokit.graphql(associatedPullRequestsQuery, parameters);

        if (!response?.repository?.object?.associatedPullRequests) {
            this.logger.warn(`No response received for query: ${associatedPullRequestsQuery}`, parameters);
            return null;
        }

        const associatedPullRequests = response.repository.object.associatedPullRequests;
        return {
            data: (associatedPullRequests.nodes || []) as GraphQLPullRequest[],
            pageInfo: associatedPullRequests.pageInfo,
        };
    }

    async retrieveFileContents(path: string, branch: string): Promise<GitHubFileContents> {
        this.logger.debug(`Fetching file '${path}' from branch '${branch}'...`);
        try {
            return await this.fileCache.getFileContents(path, branch);
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                this.logger.error(`Fetching file '${path}' from branch '${branch}'... failed, not found`);
            }
            throw e;
        }
    }

    async createRelease(release: Release) {
        try {
            const response = await this.octokit.rest.repos.createRelease({
                name: release.tag,
                owner: this.repository.owner,
                repo: this.repository.repo,
                tag_name: release.tag,
                body: release.notes,
                draft: false,
                prerelease: false,
                target_commitish: release.sha,
            });

            return {
                id: response.data.id,
                url: response.data.html_url,
                pullRequestNumber: release.pullRequestNumber,
            }
        } catch (e) {
            if (e instanceof RequestError) {
                const body = e.response as { data: RequestErrorBody };
                const errors = body?.data?.errors ?? [];

                if (e.status === 422 && errors.some(error => error.code === "already_exists")) {
                    throw new DuplicateReleaseError(e, release.tag);
                }
            }
            throw e;
        }
    }

    // Used to resume bookkeeping (comment + label swap) for a pull request whose release was already created by
    // an earlier, partially-failed run — see Manifest.release()'s handling of DuplicateReleaseError.
    async retrieveReleaseByTag(tag: string) {
        const response = await this.octokit.rest.repos.getReleaseByTag({
            owner: this.repository.owner,
            repo: this.repository.repo,
            tag,
        });

        return {
            id: response.data.id,
            url: response.data.html_url,
        }
    }

    async commentOnIssue(comment: string, pullRequestNumber: number) {
        const response = await this.octokit.rest.issues.createComment({
            owner: this.repository.owner,
            repo: this.repository.repo,
            issue_number: pullRequestNumber,
            body: comment,
        });
        return response.data.html_url;
    }

    async addPullRequestLabels(labels: string[], pullRequestNumber: number) {
        if (labels.length === 0) {
            return;
        }
        await this.octokit.rest.issues.addLabels({
            owner: this.repository.owner,
            repo: this.repository.repo,
            issue_number: pullRequestNumber,
            labels,
        });
    }

    async removePullRequestLabels(labels: string[], pullRequestNumber: number) {
        if (labels.length === 0) {
            return;
        }
        await Promise.all(
            labels.map(label => this.octokit.rest.issues.removeLabel({
                owner: this.repository.owner,
                repo: this.repository.repo,
                issue_number: pullRequestNumber,
                name: label,
            }))
        );
    }

}

function isLightweightTag(tag: GraphQLTag): tag is LightweightTag {
    return tag.target.hasOwnProperty("oid");
}

interface Tags extends Response<Tag> {}

interface GraphQLTag {
    name: string;
    target: object;
}

interface LightweightTag extends GraphQLTag {
    target: {
        oid: string;
        committedDate: string;
    }
}

interface AnnotatedTag extends GraphQLTag {
    target: {
        target: {
            oid: string;
            committedDate: string;
        }
    }
}

interface GraphQLCommit {
    sha: string;
    message: string;
    associatedPullRequests: {
        nodes: GraphQLPullRequest[];
        pageInfo: {
            hasNextPage: boolean;
            endCursor?: string;
        };
    };
}

interface GraphQLPullRequest {
    number: number;
    title: string;
    body: string;
    permalink: string;
    baseRefName: string;
    headRefName: string;
    labels: {
        nodes: {
            name: string;
        }[];
        pageInfo: {
            hasNextPage: boolean;
            endCursor?: string;
        };
    };
    mergeCommit?: {
        oid: string;
    };
    // Only present on nodes fetched via pullRequestsSince.graphql (mergeCommitsGraphQL) — the changed-file list
    // is needed there for component path attribution (see componentPathFilter.ts). mergedPullRequests.graphql
    // (pullRequestsGraphQL) intentionally omits this field: none of its callers (determineReleases.ts,
    // Manifest.findExistingPullRequest, ManifestRunner's open-pull-request conflict check) need changed files,
    // and fetching/paginating them for every historic merged pull request risked blocking those scans outright
    // whenever an old, unrelated pull request had enough changed files to exceed the pagination safety cap.
    files?: {
        nodes: {
            path: string;
        }[];
        pageInfo: {
            hasNextPage: boolean;
            endCursor?: string;
        };
    };
}

interface CommitHistory extends Response<Commit> {}

interface FileDiff {
    readonly mode: "100644" | "100755" | "040000" | "160000" | "120000";
    readonly content: string | null;
    readonly originalContent: string | null;
}
type ChangeSet = Map<string, FileDiff>;

interface PullRequestHistory extends Response<PullRequest> {}

export class DuplicateReleaseError extends Error {
    constructor(readonly requestError: RequestError, readonly tagName: string) {
        super();
    }
}

type PageInfo = {
    hasNextPage: boolean;
    endCursor: string | undefined;
}

type Response<T> = {
    data: T[];
    pageInfo: PageInfo;
}

// Thrown by the generic paginate() below when a page reports more results are available (hasNextPage: true)
// but returns no cursor to fetch them with. Silently treating that as "no more pages" would under-report
// results just like a truncated changed-file/label/associated-pull-request list would (see e.g.
// PullRequestFilesIncompleteError) — but silently retrying with the same (missing) cursor is worse, since
// fetchPage would then be called with the *same* arguments as the page that just produced this response,
// re-fetching and re-yielding that same page's items forever (bounded only by maxResults, if any is given at
// all — tagIterator/mergeCommitIterator/pullRequestIterator all normally run unbounded). Loud failure is the
// only safe option here.
export class PaginationIncompleteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PaginationIncompleteError";
    }
}

async function *paginate<T>(
    fetchPage: (cursor?: string) => Promise<Response<T> | null>,
    maxResults: number = Number.MAX_SAFE_INTEGER
): AsyncGenerator<T> {
    let cursor: string | undefined = undefined;
    let results = 0;

    while (results < maxResults) {
        const response = await fetchPage(cursor);

        if (!response) {
            break;
        }

        // Stops yielding mid-page, not just between pages, once maxResults is reached — a caller asking for
        // (say) 3 results must never receive more just because they happened to arrive on a bigger page.
        for (let x = 0; x < response.data.length && results < maxResults; x++) {
            results += 1;
            yield response.data[x];
        }

        if (results >= maxResults) {
            break;
        }

        if (!response.pageInfo.hasNextPage) {
            break;
        }

        if (!response.pageInfo.endCursor) {
            throw new PaginationIncompleteError("Server reported more pages are available (hasNextPage: true) but returned no cursor to continue from");
        }

        cursor = response.pageInfo.endCursor;
    }
}

// Wraps a single-use async generator so it can be iterated multiple times (e.g. once per configured component in
// the same run — see `tagIterator`/`mergeCommitIterator`) while only ever pulling each underlying page once.
// Earlier items are replayed from `items` on every new iteration; iteration only reaches back into `source` once
// past whatever's already cached, continuing it rather than restarting it. If `source` throws (e.g. a transient
// GraphQL failure mid-pagination), that error is cached and re-thrown on every subsequent iteration too — a
// once-broken source must never silently look "exhausted" (yielding fewer items than really exist) to a
// component that iterates it later in the same run, since that could produce an incomplete-but-successful-looking
// result instead of a loud failure.
class MemoizedAsyncIterable<T> {
    private readonly items: T[] = [];
    private done = false;
    private error?: unknown;

    constructor(private readonly source: AsyncGenerator<T>) {}

    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        for (let index = 0; ; index++) {
            if (index < this.items.length) {
                yield this.items[index];
                continue;
            }
            if (this.done) {
                return;
            }
            if (this.error) {
                throw this.error;
            }

            let next: IteratorResult<T>;
            try {
                next = await this.source.next();
            } catch (e) {
                this.error = e;
                throw e;
            }

            if (next.done) {
                this.done = true;
                return;
            }
            this.items.push(next.value);
            yield next.value;
        }
    }
}

async function *truncate<T>(source: AsyncIterable<T>, maxResults: number = Number.MAX_SAFE_INTEGER): AsyncGenerator<T> {
    let count = 0;
    for await (const item of source) {
        if (count >= maxResults) {
            return;
        }
        count++;
        yield item;
    }
}

