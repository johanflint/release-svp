import { groupReleaseBranchName, releaseBranchName } from "./componentNaming";
import { ComponentConfig } from "./manifestConfig";

// A statically-partitioned group of components that share one release pull request. Partitioning is based
// purely on repository configuration (component list + `releaseGroup`), never on which components happen to have a
// candidate in any one run — otherwise a component's branch could change from run to run as other components'
// unreleased-commit status fluctuates, orphaning whatever pull request was already open on its previous branch.
// See README.md ("Release groups").
export interface ReleaseUnit {
    // Set only for a real (2+ member) `releaseGroup`; undefined for a singleton, whose branch/title/labels are
    // unchanged from before release groups existed.
    readonly groupId?: string;
    readonly branchName: string;
    // Every component statically assigned to this unit, regardless of whether it has a candidate in this run —
    // see `ComponentCandidate` for the run-specific piece, attached once a candidate is known (manifestRunner.ts).
    readonly members: readonly ComponentConfig[];
}

// Partitions every configured component into its release unit — see `ReleaseUnit` for why this never looks at
// which components currently have a candidate. Rules (see manifestConfig.ts, `ComponentConfig.releaseGroup`, and
// README.md, "Release groups"):
//  - A component without `releaseGroup` is always its own singleton unit (one release pull request per component).
//  - Components sharing the same `releaseGroup` value form one unit each.
//  - A `releaseGroup` with exactly one remaining member (declared alone, or left alone after a sibling was removed
//    from the config) is returned as a genuine singleton unit (no `groupId`, plain branch name) — never a
//    single-member "group" unit — so it behaves exactly like an ungrouped component and callers never need to
//    special-case group size.
export function computeReleaseUnits(allComponents: readonly ComponentConfig[], targetBranch: string): ReleaseUnit[] {
    const membersByGroup = new Map<string, ComponentConfig[]>();
    const units: ReleaseUnit[] = [];
    for (const component of allComponents) {
        if (!component.releaseGroup) {
            units.push(singletonUnit(component, targetBranch));
            continue;
        }

        const members = membersByGroup.get(component.releaseGroup) ?? [];
        members.push(component);
        membersByGroup.set(component.releaseGroup, members);
    }

    for (const [groupId, members] of membersByGroup) {
        if (members.length === 1) {
            units.push(singletonUnit(members[0], targetBranch));
            continue;
        }

        units.push({ groupId, branchName: groupReleaseBranchName(targetBranch, groupId), members });
    }

    return units;
}

function singletonUnit(component: ComponentConfig, targetBranch: string): ReleaseUnit {
    return { branchName: releaseBranchName(targetBranch, component.component), members: [component] };
}
