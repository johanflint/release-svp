import { groupReleaseBranchName, releaseBranchName } from "./componentNaming";
import { ComponentConfig, ManifestConfig } from "./manifestConfig";

// A statically-partitioned group of components that share one release pull request. Partitioning is based
// purely on repository configuration (`releaseGroups` and `components`), never on which components happen to have
// a candidate in any one run — otherwise a component's branch could change from run to run as other components'
// unreleased-commit status fluctuates, orphaning whatever pull request was already open on its previous branch.
// See README.md ("Release groups").
export interface ReleaseUnit {
    // The release group's name; undefined for a singleton (an ungrouped component), whose branch/title/labels are
    // unchanged from before release groups existed.
    readonly groupId?: string;
    readonly branchName: string;
    // Every component statically assigned to this unit, regardless of whether it has a candidate in this run —
    // see `ComponentCandidate` for the run-specific piece, attached once a candidate is known (manifestRunner.ts).
    readonly members: readonly ComponentConfig[];
}

// One unit per release group, followed by a singleton unit per ungrouped component — see `ReleaseUnit` for why
// this never looks at which components currently have a candidate.
export function computeReleaseUnits(config: Pick<ManifestConfig, "releaseGroups" | "components">, targetBranch: string): ReleaseUnit[] {
    const groupUnits = (config.releaseGroups ?? []).map(group => ({
        groupId: group.name,
        branchName: groupReleaseBranchName(targetBranch, group.name),
        members: group.components,
    }));
    const singletonUnits = config.components.map(component => ({
        branchName: releaseBranchName(targetBranch, component.component),
        members: [component],
    }));
    return [...groupUnits, ...singletonUnits];
}
