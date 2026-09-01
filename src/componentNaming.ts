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

export function pendingLabel(componentName: string): string {
    return componentName ? `${LABEL_PENDING} (${componentName})` : LABEL_PENDING;
}

export function taggedLabel(componentName: string): string {
    return componentName ? `${LABEL_TAGGED} (${componentName})` : LABEL_TAGGED;
}
