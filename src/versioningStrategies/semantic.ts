import { Commit } from "../commit";
import { MajorVersionUpdate, MinorVersionUpdate, PatchVersionUpdate, VersioningStrategy, VersionUpdater } from "../versioningStrategy";

export class SemanticVersioningStrategy implements VersioningStrategy {
    releaseType(commits: Commit[]): VersionUpdater {
        for (const commit of commits) {
            if (!commit.isMergeCommit) {
                continue;
            }

            const labels = commit.pullRequest?.labels ?? [];
            for (const label of labels) {
                if (label.endsWith("!")) {
                    return new MajorVersionUpdate();
                }

                if (label === "feat" || label === "feature") {
                    return new MinorVersionUpdate();
                }
            }
        }
        return new PatchVersionUpdate();
    }
}
