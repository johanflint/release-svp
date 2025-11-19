import { DEFAULT_FILE_MODE, FileNotFoundError, GitHubFileContents, RepositoryFileCache } from "@google-automations/git-file-utils";
import { Octokit as RestOctokit } from "@octokit/rest";
import { createPullRequest } from "code-suggester";
import { Octokit } from "octokit";
import { Commit, PullRequest } from "./commit";
import { Repository } from "./repository";
import { Tag } from "./tag";
import { Update } from "./update";

export class Github {
    private readonly repository: Repository;
    private readonly octokit: Octokit;
    private readonly restOctokit: RestOctokit;
    private readonly fileCache: RepositoryFileCache;

    constructor(repository: Repository, token: string) {
        this.repository = repository;

        this.octokit = new Octokit({
            auth: process.env.GITHUB_TOKEN || token,
        });
        this.restOctokit = new RestOctokit({
            auth: process.env.GITHUB_TOKEN || token,
        });
        this.fileCache = new RepositoryFileCache(this.restOctokit, this.repository);
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
        console.debug(`Fetching tags with cursor '${cursor}...`);
        const query = `
            query latestTags($owner: String!, $repo: String!, $count: Int!, $cursor: String) {
                repository(owner:$owner, name: $repo) {
                    refs(refPrefix: "refs/tags/", first: $count, after: $cursor, orderBy: { field: TAG_COMMIT_DATE, direction: DESC}) {
                        nodes {
                            name
                            target {
                                ... on Commit {
                                    oid
                                    committedDate
                                    messageHeadline
                                }
                                ... on Tag {
                                    tagger {
                                        name
                                        date
                                    }
                                    target {
                                        oid
                                        ... on Commit {
                                            committedDate
                                        }
                                    }
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }
            }
        `;

        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            count: 10,
        };
        const response: any = await this.octokit.graphql(query, parameters);

        if (!response) {
            console.warn(`No response received for query: ${query}`, parameters)
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
        console.debug(`Fetching merge commits on branch '${targetBranch} with cursor '${cursor}'...`);
        const query = `
            query pullRequestsSince($owner: String!, $repo: String!, $count: Int!, $targetBranch: String!, $cursor: String) {
                repository(owner: $owner, name: $repo) {
                    ref(qualifiedName: $targetBranch) {
                        target {
                        ... on Commit {
                                history(first: $count, after: $cursor) {
                                    nodes {
                                        sha: oid
                                        message
                                        associatedPullRequests(first: 10) {
                                            nodes {
                                                number
                                                title
                                                body
                                                permalink
                                                headRefName
                                                baseRefName
                                                mergeCommit {
                                                    oid
                                                }
                                                labels(first: 10) {
                                                    nodes {
                                                        name
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    pageInfo {
                                        hasNextPage
                                        endCursor
                                    }
                                }
                            }
                        }
                    }
                }
            }`;

        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            count: 10,
            targetBranch,
        };
        const response: any = await this.octokit.graphql(query, parameters);

        if (!response) {
            console.warn(`No response received for query: ${query}`, parameters)
            return null;
        }

        if (!response.repository?.ref) {
            console.warn(`No commits found for branch '${targetBranch}'`);
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
                    console.warn(`File '${update.path}' does not exist on branch '${targetBranch}'`);
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
        console.debug(`Fetching pull requests on branch '${targetBranch}' with cursor '${cursor}'...`);
        const query = `
            query mergedPullRequests($owner: String!, $repo: String!, $count: Int!, $targetBranch: String!, $states: [PullRequestState!], $cursor: String) {
                repository(owner: $owner, name: $repo) {
                    pullRequests(first: $count, after: $cursor, baseRefName: $targetBranch, states: $states, orderBy: {field: CREATED_AT, direction: DESC}) {
                        nodes {
                            number
                            title
                            baseRefName
                            headRefName
                            labels(first: 10) {
                                nodes {
                                    name
                                }
                            }
                            body
                            mergeCommit {
                                oid
                            }
                        }
                        pageInfo {
                            endCursor
                            hasNextPage
                        }
                    }
                }
            }
            `;
        const parameters = {
            cursor,
            owner: this.repository.owner,
            repo: this.repository.repo,
            count: 10,
            targetBranch,
            states: [status]
        };
        const response: any = await this.octokit.graphql(query, parameters);

        if (!response?.repository?.pullRequests) {
            console.warn(`Could not find pull requests for branch ${targetBranch}`);
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
        console.debug(`Fetching file '${path}' from branch '${branch}'...`);
        try {
            return await this.fileCache.getFileContents(path, branch);
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                console.error(`Fetching file '${path}' from branch '${branch}'... failed, not found`);
            }
            throw e;
        }
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
