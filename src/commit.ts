export interface Commit {
    sha: string;
    message: string;
    isMergeCommit: boolean;
    pullRequest?: PullRequest;
}

export interface PullRequest {
    readonly sha?: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly permalink: string;
    readonly headBranchName: string;
    readonly baseBranchName: string;
    readonly mergeCommitOid?: string;
    readonly labels: string[];
}
