import { Octokit } from "octokit";
import { Commit, PullRequest } from "./commit";
import { Repository } from "./repository";

export class Github {
    private readonly repository: Repository;
    private readonly octokit: Octokit;

    constructor(repository: Repository, token: string) {
        this.repository = repository;

        this.octokit = new Octokit({
            auth: process.env.GITHUB_TOKEN || token,
        });
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
