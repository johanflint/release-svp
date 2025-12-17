import { DEFAULT_FILE_MODE, FileNotFoundError, GitHubFileContents, RepositoryFileCache } from "@google-automations/git-file-utils";
import { Octokit as RestOctokit } from "@octokit/rest";
import { createPullRequest } from "code-suggester";
import { Octokit, RequestError } from "octokit";
import { RequestError as RequestErrorBody } from "@octokit/types";
import { Commit, PullRequest } from "./commit";
import latestTagsQuery from "./graphql/latestTags.graphql";
import mergedPullRequestsQuery from "./graphql/mergedPullRequests.graphql";
import pullRequestsSinceQuery from "./graphql/pullRequestsSince.graphql";
import { Logger } from "./logger";
import { Release } from "./release";
import { Repository } from "./repository";
import { Tag } from "./tag";
import { Update } from "./update";

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
        let cursor: string | undefined = undefined;
        let results = 0;
        const maxAllowedResults = maxResults ?? Number.MAX_SAFE_INTEGER;
        while (results < maxAllowedResults) {
            const response = await this.tagsGraphQL(cursor);

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
        let cursor: string | undefined = undefined;
        let results = 0;
        const maxAllowedResults = maxResults ?? Number.MAX_SAFE_INTEGER;
        while (results < maxAllowedResults) {
            const response = await this.mergeCommitsGraphQL(branch, cursor);

            // Branch cannot be found
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

        const mappedCommits = commits.map<Commit>(commit => {
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
            } : undefined;

            return {
                sha: commit.sha,
                message: commit.message,
                isMergeCommit: mergePullRequest !== undefined,
                pullRequest,
            };
        });

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
        let cursor: string | undefined = undefined;
        let results = 0;
        const maxAllowedResults = maxResults ?? Number.MAX_SAFE_INTEGER;
        while (results < maxAllowedResults) {
            const response = await this.pullRequestsGraphQL(targetBranch, status, cursor);

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
            data: pullRequests.map(pullRequest => {
                return {
                    sha: pullRequest.mergeCommit?.oid, // already filtered non-merged
                    number: pullRequest.number,
                    title: pullRequest.title,
                    body: pullRequest.body + '',
                    permalink: pullRequest.permalink,
                    headBranchName: pullRequest.headRefName,
                    baseBranchName: pullRequest.baseRefName,
                    mergeCommitOid: pullRequest.mergeCommit?.oid,
                    labels: (pullRequest.labels?.nodes || []).map(l => l.name),
                };
            }),
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

interface Tags {
    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | undefined;
    };
    data: Tag[];
}

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
        };
    };
}

interface CommitHistory {
    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | undefined;
    };
    data: Commit[];
}

interface FileDiff {
    readonly mode: "100644" | "100755" | "040000" | "160000" | "120000";
    readonly content: string | null;
    readonly originalContent: string | null;
}
type ChangeSet = Map<string, FileDiff>;


interface PullRequestHistory {
    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | undefined;
    };
    data: PullRequest[];
}

export class DuplicateReleaseError extends Error {
    constructor(readonly requestError: RequestError, readonly tagName: string) {
        super();
    }
}
