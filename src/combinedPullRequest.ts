import { PullRequest } from "./commit";
import { DEFAULT_RELEASE_GROUP_ID, pendingLabel, releaseBranchName } from "./componentNaming";
import { ComponentCandidate } from "./manifest";
import { ComponentSection, extractComponentSections, parsePullRequestBody } from "./pullRequestBody";
import { pullRequestCoversComponent } from "./release";
import { ReleaseUnit } from "./releaseUnit";
import { Update } from "./update";
import { Version } from "./version";

// The result of merging a release unit's currently active candidates with whatever its existing (still open)
// pull request already contains — see `buildCombinedSections`. `updates` is the flattened, ready-to-write file
// changes for every member with a FRESH candidate this run (never for a carried-forward member — its file
// changes are already committed on the branch from a previous run) — computed here, alongside `sections`, so
// callers never need to re-derive which members are "fresh" themselves.
export type CombinedSectionsResult =
    | { readonly sections: readonly ComponentSection[]; readonly updates: readonly Update[] }
    // Every component name in `orphaned` has a section in the existing pull request but is no longer a member of
    // this unit (see `buildCombinedSections`) — the caller must fail loudly rather than silently drop it.
    | { readonly orphaned: readonly string[] };

// Builds the merged set of per-component sections (and their corresponding file updates) for a release unit's
// shared pull request, combining:
//  - a fresh section (and its updates) for every member that has a candidate in THIS run, and
//  - an unchanged, carried-forward section for every member that has no candidate this run (nothing new to
//    release for it) but already has one in the existing pull request — this is "frozen membership": a member
//    that simply has no new commits yet must never silently disappear from an already-open combined pull
//    request. A carried-forward member contributes no updates — its file changes are already on the branch.
// Fails (returns `orphaned`) when the existing pull request has a section for a component that isn't a member of
// this unit at all anymore (e.g. removed from the config, or moved to a different release group) — that case
// can't be resolved by carrying anything forward, and silently dropping it would look like data loss.
export function buildCombinedSections(
    unit: ReleaseUnit,
    activeCandidatesByComponent: ReadonlyMap<string, ComponentCandidate>,
    existingPullRequest: PullRequest | undefined,
): CombinedSectionsResult {
    const existingSections = existingPullRequest
        ? extractComponentSections(parsePullRequestBody(existingPullRequest.body)?.content ?? "")
        : [];

    const sections: ComponentSection[] = [];
    const updates: Update[] = [];
    const handled = new Set<string>();
    for (const component of unit.members) {
        const candidate = activeCandidatesByComponent.get(component.component);
        if (candidate) {
            sections.push({ componentName: component.component, notes: candidate.changelog });
            updates.push(...candidate.updates);
        } else {
            const carriedForward = existingSections.find(section => section.componentName === component.component);
            if (carriedForward) {
                sections.push(carriedForward);
            }
        }
        handled.add(component.component);
    }

    const orphaned = existingSections.filter(section => !handled.has(section.componentName)).map(section => section.componentName);
    if (orphaned.length > 0) {
        return { orphaned };
    }

    return { sections, updates };
}

// Title for a release unit's pull request. Covers both the singleton case (today's one-pull-request-per-
// component behaviour) and the combined/grouped case, since which applies depends on repo-wide context (how
// many components are configured in total) that neither `Manifest` nor `ManifestRunner`'s per-unit dispatch has
// any reason to duplicate — see README.md ("Combined release pull requests"):
//  - a genuine multi-member unit (2+ components sharing this pull request): the group name — the repository
//    name for the implicit default "everyone with changes" group, or the explicit `releaseGroup` value
//    otherwise — with no version, since each member is versioned independently. `releaseVersion` is ignored.
//  - a singleton unit (exactly one member), when 2+ components are configured in total: the member's own
//    component name plus its version, so that multiple singleton pull requests in the same repository can still
//    be told apart from their titles alone. `releaseVersion` is required here.
//  - a singleton unit when only one component is configured in total (true single-project mode, or a one-entry
//    config file): just the version — there's nothing else configured to disambiguate against. `releaseVersion`
//    is required here too.
export function pullRequestTitle(options: {
    readonly unit: ReleaseUnit;
    readonly totalComponentCount: number;
    readonly repositoryName: string;
    readonly releaseVersion?: Version;
}): string {
    const { unit, totalComponentCount, repositoryName, releaseVersion } = options;

    if (unit.members.length > 1) {
        return unit.groupId === DEFAULT_RELEASE_GROUP_ID ? `Release ${repositoryName}` : `Release ${unit.groupId}`;
    }

    if (totalComponentCount <= 1) {
        return `Release v${releaseVersion}`;
    }

    return `Release ${unit.members[0].component} v${releaseVersion}`;
}

// Finds an already-open pull request (on some OTHER branch) that already appears to be tracking `componentName`,
// using the exact same matching rule `determineReleases` uses on the release side (see release.ts,
// `pullRequestCoversComponent`, and determineReleases.ts): its branch or pending label identifies the component,
// AND its parsed body still covers it. Used to detect a component simultaneously claimed by two open pull
// requests — e.g. a pre-upgrade, per-component pull request left open when a component joins a release group for
// the first time, or a pull request left over from before a `releaseGroup` config change moved the component
// elsewhere. Both must be resolved manually (by merging/closing the stale pull request) rather than silently
// picked one way or the other.
export function findConflictingOpenPullRequest(
    openPullRequests: readonly PullRequest[],
    componentName: string,
    unitBranchName: string,
    targetBranch: string,
): PullRequest | undefined {
    const legacyBranchName = releaseBranchName(targetBranch, componentName);
    const label = pendingLabel(componentName);
    return openPullRequests.find(pullRequest =>
        pullRequest.headBranchName !== unitBranchName
        && (pullRequest.headBranchName === legacyBranchName || pullRequest.labels.includes(label))
        && pullRequestCoversComponent(pullRequest.body, componentName)
    );
}
