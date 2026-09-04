import { DEFAULT_RELEASE_GROUP_ID, groupReleaseBranchName, releaseBranchName } from "./componentNaming";
import { ComponentCandidate } from "./manifest";
import { ComponentConfig } from "./manifestConfig";

export interface ReleaseUnitMember {
    readonly component: ComponentConfig;
    readonly candidate: ComponentCandidate;
}

// A statically-partitioned group of components that share one release pull request. Partitioning is based
// purely on repository configuration (component list + `releaseGroup`/`separatePullRequests`), never on which
// components happen to have a candidate in any one run — otherwise a component's branch could change from run to
// run as other components' unreleased-commit status fluctuates, orphaning whatever pull request was already open
// on its previous branch. See README.md ("Combined release pull requests").
export interface ReleaseUnit {
    // Set only for a real (default-or-explicit) group; undefined for a genuine ungrouped singleton, whose
    // branch/title/labels are unchanged from before this feature existed.
    readonly groupId?: string;
    readonly branchName: string;
    // Every component statically assigned to this unit, regardless of whether it has a candidate in this run —
    // see `ComponentCandidate` for the run-specific piece, attached once a candidate is known (manifestRunner.ts).
    readonly members: readonly ComponentConfig[];
}

// Partitions every configured component into its release unit — see `ReleaseUnit` for why this never looks at
// which components currently have a candidate. Rules (see manifestConfig.ts, `ComponentConfig.releaseGroup` /
// `ManifestConfig.separatePullRequests`, and README.md for the full rationale):
//  - A single configured component is always its own singleton unit (root/single-project repositories must keep
//    using the plain, unscoped branch name — never the "combined" group branch).
//  - Otherwise, if no component declares `releaseGroup` and `separatePullRequests` is set, every component is its
//    own singleton unit (today's one-pull-request-per-component behaviour).
//  - Otherwise, if no component declares `releaseGroup`, every component shares one implicit default unit
//    (`DEFAULT_RELEASE_GROUP_ID`).
//  - Otherwise (some component(s) declare `releaseGroup`), components sharing the same value form one unit each;
//    every other, ungrouped component is its own singleton unit — never silently folded into a group or into an
//    implicit "everyone else" bucket.
export function computeReleaseUnits(
    allComponents: readonly ComponentConfig[],
    targetBranch: string,
    separatePullRequests: boolean | undefined,
): ReleaseUnit[] {
    if (allComponents.length <= 1) {
        return allComponents.map(component => singletonUnit(component, targetBranch));
    }

    const anyGroupDeclared = allComponents.some(component => component.releaseGroup);

    if (!anyGroupDeclared && separatePullRequests) {
        return allComponents.map(component => singletonUnit(component, targetBranch));
    }

    if (!anyGroupDeclared) {
        return [{
            groupId: DEFAULT_RELEASE_GROUP_ID,
            branchName: groupReleaseBranchName(targetBranch, DEFAULT_RELEASE_GROUP_ID),
            members: allComponents,
        }];
    }

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
        units.push({ groupId, branchName: groupReleaseBranchName(targetBranch, groupId), members });
    }

    return units;
}

function singletonUnit(component: ComponentConfig, targetBranch: string): ReleaseUnit {
    return { branchName: releaseBranchName(targetBranch, component.component), members: [component] };
}
