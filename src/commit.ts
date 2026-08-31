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
    // Paths of files changed by this pull request, relative to the repository root. Used for path-based
    // component filtering in a monorepo. Undefined when not fetched (e.g. for locally-constructed pull request
    // drafts); may be capped by the GraphQL page size (see `changedFilePathsTruncated`) for very large PRs.
    readonly changedFilePaths?: string[];
    // True if `changedFilePaths` did not include every file changed by the pull request (GraphQL page size
    // exceeded). Path-based component filtering should treat this as "possibly matches" rather than "no match".
    readonly changedFilePathsTruncated?: boolean;
}
