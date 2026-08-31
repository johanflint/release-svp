import init from "@rainbowatcher/toml-edit-js";
import { buildChangelog } from "./changelogBuilder";
import { PullRequest } from "./commit";
import { pendingLabel, releaseBranchName, taggedLabel, tagPrefix } from "./componentNaming";
import { determineReleaseContext } from "./determineReleaseContext";
import { determineReleases } from "./determineReleases";
import { DuplicateReleaseError, Github } from "./github";
import { logger, Logger, logger as defaultLogger } from "./logger";
import { createPullRequestBody } from "./pullRequestBody";
import { PullRequestChangelogNoteBuilder } from "./pullRequestChangelogNoteBuilder";
import { Repository } from "./repository";
import { UpdateOptions } from "./strategy";
import { buildStrategy } from "./strategyFactory";
import { SemanticVersioningStrategy } from "./versioningStrategies/semantic";

export class Manifest {
    // `componentName` is "" for the root component (single-project, backward-compatible naming — see
    // componentNaming.ts). `componentPath`/`allComponentPaths` scope which commits are considered "unreleased"
    // for this component (see componentPathFilter.ts); defaulting to "" / [""] preserves single-project
    // behaviour (every commit is attributed to the root component).
    private constructor(
        private readonly github: Github,
        private readonly repository: Repository,
        private readonly targetBranch: string,
        private readonly componentName: string = "",
        private readonly componentPath: string = "",
        private readonly allComponentPaths: readonly string[] = [""],
    ) {}

    async prepare(releaseType: string) {
        logger.info(`Prepare release for repository '${this.repository.owner}/${this.repository.repo}'`);
        const releaseContext = await determineReleaseContext(
            this.github,
            this.targetBranch,
            tagPrefix(this.componentName),
            this.componentPath,
            this.allComponentPaths,
        );

        if (releaseContext.unreleasedCommits.length === 0) {
            logger.info(`No unreleased commits, nothing to do 🕸️`);
            return;
        }

        logger.info(`Previous release is 'v${releaseContext.previousRelease}', ${releaseContext.unreleasedCommits.length} unreleased commit(s)`);

        const versioningStrategy = new SemanticVersioningStrategy();
        const releaseVersion = versioningStrategy.releaseType(releaseContext.unreleasedCommits).bump(releaseContext.previousRelease);
        logger.info(`Next release is v${releaseVersion}`);

        const changelog = buildChangelog(releaseContext.unreleasedCommits, new PullRequestChangelogNoteBuilder(), releaseVersion)
        logger.debug(`Will open one pull request`);
        logger.info("---");
        logger.info(changelog);
        logger.info("---");

        const strategy = buildStrategy(releaseType, { github: this.github, componentPath: this.componentPath });
        const updateOptions: UpdateOptions = {
            changelogEntry: changelog,
            releaseVersion,
            targetBranch: this.targetBranch,
        };
        const updates = await strategy.determineUpdates(updateOptions);

        const pullRequest: PullRequest = {
            number: -1,
            title: `Release v${releaseVersion}`,
            body: createPullRequestBody(changelog),
            permalink: "unused",
            headBranchName: releaseBranchName(this.targetBranch, this.componentName),
            baseBranchName: this.targetBranch,
            labels: [pendingLabel(this.componentName)],
        }

        const existingPullRequest = await this.findExistingPullRequest(pullRequest, this.github);
        const commitMessage = `Release v${releaseVersion}`;
        if (existingPullRequest?.body === pullRequest.body && existingPullRequest.title === pullRequest.title) {
            logger.info(`Done, pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${existingPullRequest.number} remained the same`);
            return;
        }

        if (existingPullRequest) {
            const updatedPullRequest = await this.github.updatePullRequest(pullRequest, commitMessage, updates);
            logger.info(`Updated pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${updatedPullRequest.number}`);
        } else {
            const createdPullRequest = await this.github.createPullRequest(pullRequest, commitMessage, updates);
            logger.info(`Created pull request https://github.com/${this.repository.owner}/${this.repository.repo}/pull/${createdPullRequest.number}`);
        }
    }

    private async findExistingPullRequest(existingPullRequest: PullRequest, github: Github): Promise<PullRequest | undefined> {
        const openPullRequestsGenerator = github.pullRequestIterator(existingPullRequest.baseBranchName, "OPEN");
        for await (const pullRequest of openPullRequestsGenerator) {
            if (existingPullRequest.headBranchName === pullRequest.headBranchName && pullRequest.labels.includes(pendingLabel(this.componentName))) {
                return pullRequest;
            }
        }
        return undefined;
    }

    async release() {
        const releases = await determineReleases(this.github, this.targetBranch, {
            releaseBranchName: releaseBranchName(this.targetBranch, this.componentName),
            labelPending: pendingLabel(this.componentName),
            tagPrefix: tagPrefix(this.componentName),
        });

        if (releases.length === 0) {
            logger.info(`Nothing to release 🐼`);
            return;
        }

        for (const release of releases) {
            logger.info(`Creating release ${release.tag} for pull request #${release.pullRequestNumber}...`);
            try {
                const result = await this.github.createRelease(release);
                logger.info(`Created release ${result.id} at ${result.url}`);

                const comment = `:bowtie: Created release [${release.tag}](${result.url}) :tulip:`;
                const url = await this.github.commentOnIssue(comment, release.pullRequestNumber);
                logger.info(`Commented on pull request #${release.pullRequestNumber} at ${url}`);

                logger.info(`Updating labels, removing '${pendingLabel(this.componentName)}'...`);
                await this.github.removePullRequestLabels([pendingLabel(this.componentName)], release.pullRequestNumber);
                logger.info(`Updating labels, adding '${taggedLabel(this.componentName)}'...`);
                await this.github.addPullRequestLabels([taggedLabel(this.componentName)], release.pullRequestNumber);
            } catch (e) {
                if (e instanceof DuplicateReleaseError) {
                    logger.warn(`Duplicate release tag for ${e.tagName}`);
                } else {
                    throw e;
                }
            }
        }

        console.info(`✅️ Created ${releases.length} release(s) 🌷️`);
    }

    static async create(repositoryUrl: string, githubToken: string, logger: Logger = defaultLogger): Promise<Manifest | null> {
        const repository = parseGitHubUrl(repositoryUrl);
        if (!repository.owner || !repository.repo) {
            logger.error(`Invalid GitHub repository url '${repositoryUrl}', expected 'repository/owner' format`);
            return null;
        }

        // Initialize wasm for the TOML library
        await init();

        const github = new Github(repository, githubToken, logger);
        const targetBranch = await github.retrieveDefaultBranch();
        return new Manifest(github, repository, targetBranch);
    }

    // Builds a Manifest for a single component, reusing an already-configured Github client, repository and
    // target branch. Used by ManifestRunner so that resolving the repository/branch/wasm init happens once per
    // run, regardless of how many components it processes. `componentName`/`componentPath` default to "" and
    // `allComponentPaths` to [""] (root component, single-project behaviour).
    static forComponent(
        github: Github,
        repository: Repository,
        targetBranch: string,
        componentName: string = "",
        componentPath: string = "",
        allComponentPaths: readonly string[] = [""],
    ): Manifest {
        return new Manifest(github, repository, targetBranch, componentName, componentPath, allComponentPaths);
    }
}

function parseGitHubUrl(url: string): Repository {
    const match = /^([\w-.]+)\/([\w-.]+)$/.exec(url)
    return {
        owner: match?.[1] ?? "",
        repo: match?.[2]?? "",
    }
}
