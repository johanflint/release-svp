import { DEFAULT_FILE_MODE, FileNotFoundError, GitHubFileContents, RepositoryFileCache } from "@google-automations/git-file-utils";
import { Octokit as RestOctokit } from "@octokit/rest";
import { createPullRequest } from "code-suggester";
import { Octokit, RequestError } from "octokit";
import { RequestError as RequestErrorBody } from "@octokit/types";
import { Commit, PullRequest } from "./commit";
import latestTagsQuery from "./graphql/latestTags.graphql";
import mergedPullRequestsQuery from "./graphql/mergedPullRequests.graphql";
import pullRequestFilesQuery from "./graphql/pullRequestFiles.graphql";
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

// Thrown when a pull request's full changed-file list cannot be obtained (pagination exhausted the safety
// limit, or a follow-up request failed/returned malformed pagination data). Callers must not guess component
// ownership from a partial file list — see extractChangedFilePaths/fetchRemainingChangedFilePaths.
export class PullRequestFilesIncompleteError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "PullRequestFilesIncompleteError";
    }
}

export class Github {
    private readonly repository: Repository;
    private readonly octokit: Octokit;
    private readonly restOctokit: RestOctokit;
    private readonly fileCache: RepositoryFileCache;

    constructor(repository: Repository, token: string, private readonly logger: Logger) {
        this.repository = repository;

        this.octokit = new Octokit({
            auth: process.env.GITHUB_TOKEN || token,
        });
        this.restOctokit = new RestOctokit({
            auth: process.env.GITHUB_TOKEN || token,
        });
        this.fileCache = new RepositoryFileCache(this.restOctokit, this.repository);
    }

    async retrieveDefaultBranch(): Promise<string> {
        const response = await this.octokit.rest.repos.get({ owner: this.repository.owner, repo: this.repository.repo });
        return response.data.default_branch;
    }

    async *tagIterator(maxResults?: number) {
        const fetchPage = (cursor?: string | undefined) => this.tagsGraphQL(cursor);
        yield* paginate(fetchPage, maxResults);
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
        const fetchPage = (cursor?: string | undefined) => this.mergeCommitsGraphQL(branch, cursor);
        yield* paginate(fetchPage, maxResults);
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
            const mergePullRequest = commit.associatedPullRequests.nodes.find(pr => pr.mergeCommit?.oid === commit.sha);
            const associatedPullRequest = mergePullRequest || commit.associatedPullRequests.nodes[0];
            const pullRequest: PullRequest | undefined = associatedPullRequest ? {
                sha: commit.sha,
                number: associatedPullRequest.number,
                title: associatedPullRequest.title,
                body: associatedPullRequest.body,
                permalink: associatedPullRequest.permalink,
                headBranchName: associatedPullRequest.headRefName,
                baseBranchName: associatedPullRequest.baseRefName,
                mergeCommitOid: associatedPullRequest.mergeCommit?.oid,
                labels: associatedPullRequest.labels.nodes.map(node => node.name),
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
                    labels: (pullRequest.labels?.nodes || []).map(l => l.name),
                    ...await this.extractChangedFilePaths(pullRequest, pullRequest.number),
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

        if (!pullRequest.files.pageInfo.endCursor) {
            throw new PullRequestFilesIncompleteError(`Pull request #${pullRequestNumber} has more changed files than fit on one page, but no pagination cursor was returned`);
        }

        return this.fetchRemainingChangedFilePaths(pullRequestNumber, firstPagePaths, pullRequest.files.pageInfo.endCursor);
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
    };
    mergeCommit?: {
        oid: string;
    };
    files: {
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

        for (let x = 0; x < response.data.length; x++) {
            results += 1;
            yield response.data[x];
        }

        if (!response.pageInfo.hasNextPage) {
            break;
        }

        cursor = response.pageInfo.endCursor;
    }
}
