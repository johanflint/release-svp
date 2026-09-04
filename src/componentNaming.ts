// Naming conventions for tags, release-PR branches and labels, namespaced per component so multiple
// components' release trains don't collide with each other.
//
// An empty `componentName` means "root component" (today's single-project behaviour): unprefixed tags, the
// plain release branch name and the original unscoped labels. This keeps single-project repositories (no
// `release-svp-config.json`, or a config with only the implicit root component) fully backward compatible.

const RELEASE_BRANCH_PREFIX = "release-svp--branches-";
const LABEL_PENDING = "autorelease: pending";
const LABEL_TAGGED = "autorelease: tagged";

export function tagPrefix(componentName: string): string {
    return componentName ? `${componentName}-` : "";
}

// Note: this is matched exactly (not as a prefix) by callers, so components whose names are a prefix of
// another component's name (e.g. "api" and "api-v2") can never collide.
export function releaseBranchName(targetBranch: string, componentName: string): string {
    const suffix = componentName ? `--${componentName}` : "";
    return `${RELEASE_BRANCH_PREFIX}${targetBranch}${suffix}`;
}

// Group id used for the implicit release group containing every component, when no component specifies an
// explicit `releaseGroup` (see README.md, "Combined release pull requests"). This is why `"combined"` is a
// reserved component name (see manifestConfig.ts, RESERVED_COMPONENT_NAMES) — it's the only component name that
// would make `groupReleaseBranchName(targetBranch, DEFAULT_RELEASE_GROUP_ID)` collide with a real component's own
// branch.
export const DEFAULT_RELEASE_GROUP_ID = "combined";

// Branch used for a single release PR that bundles a group of components together (see README.md, "Combined
// release pull requests"). For the same `targetBranch` and `groupId`, this is identical to
// `releaseBranchName(targetBranch, groupId)` — that's why a `releaseGroup` value can never equal a configured
// component's own name (validated in manifestConfig.ts): it's the only way this could collide with a real
// component's own branch. Distinct from `releaseBranchName(targetBranch, "")` (the root component's own branch),
// so a grouped PR can never be mistaken for the root/single-project branch either.
export function groupReleaseBranchName(targetBranch: string, groupId: string): string {
    return `${RELEASE_BRANCH_PREFIX}${targetBranch}--${groupId}`;
}

export function pendingLabel(componentName: string): string {
    return componentName ? `${LABEL_PENDING} (${componentName})` : LABEL_PENDING;
}

export function taggedLabel(componentName: string): string {
    return componentName ? `${LABEL_TAGGED} (${componentName})` : LABEL_TAGGED;
}
