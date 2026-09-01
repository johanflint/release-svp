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
    // drafts). For pull requests with more files than fit on a single GraphQL page, this is completed via
    // follow-up pagination (see Github.fetchRemainingChangedFilePaths); if that pagination can't fully complete
    // (safety limit reached, or a follow-up request fails), Github throws PullRequestFilesIncompleteError
    // rather than returning a partial list here — so whenever this field IS populated, it is always complete.
    readonly changedFilePaths?: string[];
}
