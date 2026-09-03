import { strategyTypes } from "./strategyFactory";
import { Version } from "./version";

// Component identifiers are used in tag names, branch names and labels, so keep them URL/git-ref safe.
const COMPONENT_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
// Reserved for the default (implicit, all-components) release group's branch name (see componentNaming.ts,
// `DEFAULT_RELEASE_GROUP_ID` / `groupReleaseBranchName`) — disallowed as a component name so that branch can
// never collide with a real component's own branch.
const RESERVED_COMPONENT_NAMES = ["combined"];
// Must be the full SHA, not an abbreviation: `truncateAtCutover` compares it verbatim against full commit OIDs
// returned by the GitHub API, so an abbreviated SHA would never match and would silently defeat the cutover.
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface ManifestConfig {
    readonly targetBranch?: string;
    readonly components: readonly ComponentConfig[];
    // Present only for repositories migrating from single-project to multi-component mode — see README.md
    // ("Migrating an existing repository to multiple components").
    readonly migration?: MigrationConfig;
    // When 2+ components have unreleased changes, they're bundled into one combined release pull request by
    // default (see README.md, "Combined release pull requests") — unless one or more components declare a
    // `releaseGroup` (see `ComponentConfig.releaseGroup`), in which case grouping follows that instead.
    // Set to `true` to keep today's one-pull-request-per-component behaviour instead. Meaningless (ignored) for
    // single-component repositories, where there's only ever one pull request either way. Setting it to `true`
    // is invalid on a config where any component declares `releaseGroup`, to avoid ambiguous precedence rules
    // (`false` or omitting the field entirely is always fine, and behaves identically either way).
    readonly separatePullRequests?: boolean;
}

// A ManifestConfig with `targetBranch` resolved to a concrete branch (falling back to the repository's default
// branch when the config doesn't specify one), as produced once resolution has happened.
export type ResolvedManifestConfig = Omit<ManifestConfig, "targetBranch"> & { readonly targetBranch: string };

export interface ComponentConfig {
    // Directory (relative to the repository root) this component owns, normalized without leading/trailing slashes.
    // An empty string means the component owns the repository root (and anything not claimed by a more specific path).
    readonly path: string;
    // Stable identifier used for tags, branches and labels, independent of `path` so directories can be renamed
    // without losing release history.
    readonly component: string;
    readonly releaseType: string;
    // Components sharing the same `releaseGroup` value are bundled into one release pull request together,
    // instead of the default "every component with unreleased changes" grouping — see README.md ("Combined
    // release pull requests"). Grouping only affects the pull request lifecycle: each component still gets its
    // own independently computed version, changelog and tag. A group with a single member behaves the same as
    // an ungrouped component (its own pull request). Components without `releaseGroup` are never bundled with
    // components that do declare one.
    readonly releaseGroup?: string;
}

export interface MigrationConfig {
    // The commit that introduced this multi-component config (typically the merge commit of the PR that added
    // `release-svp-config.json`). Commits at or before this position in `targetBranch`'s history predate any
    // component concept and are never considered "unreleased" for any component — see README.md.
    readonly cutoverCommit: string;
    // Which (if any) named, non-root component continues the pre-migration repository's release history/tags.
    readonly legacyRootSuccessor?: string;
    // The exact, pre-migration (unscoped) tag name to use as a one-time fallback anchor for `legacyRootSuccessor`,
    // required whenever `legacyRootSuccessor` is set. Deliberately explicit rather than auto-detected — see
    // README.md for why.
    readonly legacyAnchorTag?: string;
    // Starting version for every other named, non-root component (one that has no pre-migration history to
    // inherit). Required for every such component so nobody silently starts at 0.0.0.
    readonly bootstrapVersions?: Readonly<Record<string, string>>;
}

export class ManifestConfigError extends Error {
    constructor(readonly issues: readonly string[]) {
        super(`❌ Invalid manifest config:\n${issues.map(issue => ` - ${issue}`).join("\n")}`);
    }
}

export function parseManifestConfig(content: string): ManifestConfig {
    const issues: string[] = [];

    let json: unknown;
    try {
        json = JSON.parse(content);
    } catch (e) {
        throw new ManifestConfigError([`Not valid JSON: ${(e as Error).message}`]);
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new ManifestConfigError(["Expected the config to be a JSON object"]);
    }

    const raw = json as Record<string, unknown>;

    let targetBranch: string | undefined;
    if ("targetBranch" in raw) {
        if (typeof raw.targetBranch !== "string" || raw.targetBranch.trim() === "") {
            issues.push("'targetBranch' must be a non-empty string when present");
        } else {
            targetBranch = raw.targetBranch;
        }
    }

    if (!("components" in raw) || !Array.isArray(raw.components) || raw.components.length === 0) {
        issues.push("'components' must be a non-empty array");
        throw new ManifestConfigError(issues);
    }

    const validTypes = strategyTypes();
    const seenComponentNames = new Set<string>();
    const seenPaths = new Set<string>();
    const components: ComponentConfig[] = [];

    raw.components.forEach((entry, index) => {
        const component = parseComponent(entry, index, validTypes, issues);
        if (!component) {
            return;
        }

        if (seenComponentNames.has(component.component)) {
            issues.push(`components[${index}]: duplicate component name '${component.component}'`);
        } else {
            seenComponentNames.add(component.component);
        }

        if (seenPaths.has(component.path)) {
            issues.push(`components[${index}]: duplicate path '${component.path || "."}'`);
        } else {
            seenPaths.add(component.path);
        }

        components.push(component);
    });

    const migration = "migration" in raw ? parseMigrationConfig(raw.migration, components, issues) : undefined;

    let separatePullRequests: boolean | undefined;
    if ("separatePullRequests" in raw) {
        if (typeof raw.separatePullRequests !== "boolean") {
            issues.push("'separatePullRequests' must be a boolean");
        } else {
            separatePullRequests = raw.separatePullRequests;
        }
    }

    // A `releaseGroup` value sharing a name with a configured component would make that group's branch collide
    // with the component's own branch (see componentNaming.ts, `groupReleaseBranchName`).
    for (const component of components) {
        if (component.releaseGroup && seenComponentNames.has(component.releaseGroup)) {
            issues.push(`components: 'releaseGroup' value '${component.releaseGroup}' (on component '${component.component}') must not match a configured component name`);
        }
    }

    // 'separatePullRequests: false' is equivalent to omitting it, so only 'true' is actually mutually exclusive
    // with 'releaseGroup'.
    if (separatePullRequests && components.some(component => component.releaseGroup)) {
        issues.push("'separatePullRequests: true' cannot be combined with 'releaseGroup' on any component — remove one or the other");
    }

    if (issues.length > 0) {
        throw new ManifestConfigError(issues);
    }

    return { targetBranch, components, migration, separatePullRequests };
}

function parseMigrationConfig(entry: unknown, components: readonly ComponentConfig[], issues: string[]): MigrationConfig | undefined {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        issues.push("'migration': expected an object");
        return undefined;
    }

    const raw = entry as Record<string, unknown>;
    // Note: every component in a parsed config has a non-empty `component` name (see parseComponent) — the
    // "root" concept only exists via `path === ""`, which is orthogonal to this migration bookkeeping (the
    // legacy successor doesn't need to be the root-*path* component; it's whichever component now identifies
    // with the pre-migration, single-project commit history).
    const componentNames = new Set(components.map(component => component.component));

    let cutoverCommit: string | undefined;
    if (typeof raw.cutoverCommit !== "string" || !COMMIT_SHA_PATTERN.test(raw.cutoverCommit)) {
        issues.push("'migration.cutoverCommit' must be a full commit SHA (40 hex characters), not an abbreviation");
    } else {
        cutoverCommit = raw.cutoverCommit;
    }

    let legacyRootSuccessor: string | undefined;
    if ("legacyRootSuccessor" in raw) {
        if (typeof raw.legacyRootSuccessor !== "string" || raw.legacyRootSuccessor.trim() === "") {
            issues.push("'migration.legacyRootSuccessor' must be a non-empty string when present");
        } else if (!componentNames.has(raw.legacyRootSuccessor)) {
            issues.push(`'migration.legacyRootSuccessor' must reference a configured component (got '${raw.legacyRootSuccessor}')`);
        } else {
            legacyRootSuccessor = raw.legacyRootSuccessor;
        }
    }

    let legacyAnchorTag: string | undefined;
    if (legacyRootSuccessor) {
        if (typeof raw.legacyAnchorTag !== "string" || raw.legacyAnchorTag.trim() === "") {
            issues.push("'migration.legacyAnchorTag' is required, and must be a non-empty string, when 'legacyRootSuccessor' is set (see README.md for why it must be explicit)");
        } else {
            legacyAnchorTag = raw.legacyAnchorTag;
        }
    } else if ("legacyAnchorTag" in raw) {
        issues.push("'migration.legacyAnchorTag' is only meaningful together with 'legacyRootSuccessor', remove one or the other");
    }

    let bootstrapVersions: Record<string, string> | undefined;
    if ("bootstrapVersions" in raw) {
        if (typeof raw.bootstrapVersions !== "object" || raw.bootstrapVersions === null || Array.isArray(raw.bootstrapVersions)) {
            issues.push("'migration.bootstrapVersions' must be an object mapping component names to version strings");
        } else {
            bootstrapVersions = {};
            for (const [name, value] of Object.entries(raw.bootstrapVersions as Record<string, unknown>)) {
                if (!componentNames.has(name)) {
                    issues.push(`'migration.bootstrapVersions': '${name}' is not a configured component`);
                } else if (name === legacyRootSuccessor) {
                    issues.push(`'migration.bootstrapVersions': '${name}' is the legacy root successor and inherits its baseline from 'legacyAnchorTag', not 'bootstrapVersions'`);
                } else if (typeof value !== "string" || !isValidVersionString(value)) {
                    issues.push(`'migration.bootstrapVersions.${name}' must be a semantic version string (e.g. '0.1.0')`);
                } else {
                    bootstrapVersions[name] = value;
                }
            }
        }
    }

    // Every component other than the legacy successor has no pre-migration history to inherit, so it needs an
    // explicit starting point — silently defaulting to 0.0.0 would hide a real design decision from the user.
    for (const component of components) {
        if (component.component === legacyRootSuccessor) {
            continue;
        }
        if (!bootstrapVersions?.[component.component]) {
            issues.push(`'migration.bootstrapVersions' is missing a starting version for component '${component.component}'`);
        }
    }

    if (!cutoverCommit) {
        return undefined;
    }

    return { cutoverCommit, legacyRootSuccessor, legacyAnchorTag, bootstrapVersions };
}

function isValidVersionString(value: string): boolean {
    try {
        Version.parse(value);
        return true;
    } catch {
        return false;
    }
}

function parseComponent(entry: unknown, index: number, validTypes: readonly string[], issues: string[]): ComponentConfig | undefined {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        issues.push(`components[${index}]: expected an object`);
        return undefined;
    }

    const raw = entry as Record<string, unknown>;
    let valid = true;

    if (typeof raw.path !== "string") {
        issues.push(`components[${index}]: 'path' must be a string`);
        valid = false;
    }

    if (typeof raw.component !== "string" || raw.component.trim() === "") {
        issues.push(`components[${index}]: 'component' must be a non-empty string`);
        valid = false;
    } else if (!COMPONENT_NAME_PATTERN.test(raw.component)) {
        issues.push(`components[${index}]: 'component' must only contain letters, digits, '.', '_' or '-' (got '${raw.component}')`);
        valid = false;
    } else if (RESERVED_COMPONENT_NAMES.includes(raw.component)) {
        issues.push(`components[${index}]: '${raw.component}' is a reserved component name (used internally for combined release pull requests)`);
        valid = false;
    }

    if (typeof raw.releaseType !== "string" || !validTypes.includes(raw.releaseType)) {
        issues.push(`components[${index}]: 'releaseType' must be one of [${validTypes.join(", ")}] (got '${raw.releaseType}')`);
        valid = false;
    }

    let releaseGroup: string | undefined;
    if ("releaseGroup" in raw) {
        if (typeof raw.releaseGroup !== "string" || raw.releaseGroup.trim() === "") {
            issues.push(`components[${index}]: 'releaseGroup' must be a non-empty string when present`);
            valid = false;
        } else if (!COMPONENT_NAME_PATTERN.test(raw.releaseGroup)) {
            issues.push(`components[${index}]: 'releaseGroup' must only contain letters, digits, '.', '_' or '-' (got '${raw.releaseGroup}')`);
            valid = false;
        } else {
            releaseGroup = raw.releaseGroup;
        }
    }

    if (!valid) {
        return undefined;
    }

    const path = normalizePath(raw.path as string, index, issues);
    if (path === undefined) {
        return undefined;
    }

    return {
        path,
        component: raw.component as string,
        releaseType: raw.releaseType as string,
        releaseGroup,
    };
}

function normalizePath(path: string, index: number, issues: string[]): string | undefined {
    const segments = path.split("/").filter(segment => segment !== "" && segment !== ".");

    // A path of only slashes/dots (e.g. "/", ".", "./") resolves to the root, which is relative by definition.
    if (path.startsWith("/") && segments.length > 0) {
        issues.push(`components[${index}]: 'path' must be relative, not absolute (got '${path}')`);
        return undefined;
    }

    if (segments.includes("..")) {
        issues.push(`components[${index}]: 'path' must not contain '..' (got '${path}')`);
        return undefined;
    }

    return segments.join("/");
}
