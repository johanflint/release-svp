import { strategyTypes } from "./strategyFactory";
import { isValidPrereleaseIdentifier, Version } from "./version";

// Component identifiers are used in tag names, branch names and labels, so keep them URL/git-ref safe.
const COMPONENT_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
// Must be the full SHA, not an abbreviation: `truncateAtCutover` compares it verbatim against full commit OIDs
// returned by the GitHub API, so an abbreviated SHA would never match and would silently defeat the cutover.
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface ManifestConfig {
    readonly targetBranch?: string;
    // Components that share one release pull request — see README.md ("Release groups").
    readonly releaseGroups?: readonly ReleaseGroupConfig[];
    // Components that each get their own release pull request. Never includes a release group's components — use
    // `allComponents` for every configured component.
    readonly components: readonly ComponentConfig[];
    // Present only for repositories migrating from single-project to multi-component mode — see README.md
    // ("Migrating an existing repository to multiple components").
    readonly migration?: MigrationConfig;
}

// A ManifestConfig with `targetBranch` resolved to a concrete branch (falling back to the repository's default
// branch when the config doesn't specify one), as produced once resolution has happened.
export type ResolvedManifestConfig = Omit<ManifestConfig, "targetBranch"> & { readonly targetBranch: string };

// Components bundled into one release pull request. Grouping only affects the pull request lifecycle: each member
// still gets its own independently computed version, changelog and tag. Always has at least 2 components.
export interface ReleaseGroupConfig {
    // Used for the group's branch name and pull request title, so it follows the same rules as a component name
    // and never equals one (see componentNaming.ts, `groupReleaseBranchName`).
    readonly name: string;
    readonly components: readonly ComponentConfig[];
}

export interface ComponentConfig {
    // Directory (relative to the repository root) this component owns, normalized without leading/trailing slashes.
    // An empty string means the component owns the repository root (and anything not claimed by a more specific path).
    readonly path: string;
    // Stable identifier used for tags, branches and labels, independent of `path` so directories can be renamed
    // without losing release history.
    readonly component: string;
    readonly releaseType: string;
    // When set, every release computed for this component carries this SemVer pre-release identifier (e.g.
    // "beta", "rc.1") — see README.md ("Pre-releases"). Removing this field (or never setting it) always
    // produces a stable release, regardless of what pre-release identifier a previous release/tag carried; this
    // is the only way to "graduate" a component that was previously pre-release back to stable. Validated
    // against the SemVer 2.0 pre-release-identifier grammar (see version.ts, `isValidPrereleaseIdentifier`).
    readonly prereleaseType?: string;
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

// Every configured component, grouped or not: release groups' components first, in config order, then the
// ungrouped ones.
export function allComponents(config: Pick<ManifestConfig, "releaseGroups" | "components">): ComponentConfig[] {
    return [...(config.releaseGroups ?? []).flatMap(group => group.components), ...config.components];
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

    if ("separatePullRequests" in raw) {
        issues.push("'separatePullRequests' is no longer supported: every component outside 'releaseGroups' gets its own release pull request — remove the field, and use 'releaseGroups' to bundle components that release together");
    }

    const validTypes = strategyTypes();
    const seenComponentNames = new Set<string>();
    const seenPaths = new Set<string>();
    const parseComponents = (entries: readonly unknown[], location: string): ComponentConfig[] => {
        const components: ComponentConfig[] = [];
        entries.forEach((entry, index) => {
            const componentLocation = `${location}[${index}]`;
            const component = parseComponent(entry, componentLocation, validTypes, issues);
            if (!component) {
                return;
            }

            if (seenComponentNames.has(component.component)) {
                issues.push(`${componentLocation}: duplicate component name '${component.component}'`);
            } else {
                seenComponentNames.add(component.component);
            }

            if (seenPaths.has(component.path)) {
                issues.push(`${componentLocation}: duplicate path '${component.path || "."}'`);
            } else {
                seenPaths.add(component.path);
            }

            components.push(component);
        });
        return components;
    };

    const releaseGroups: ReleaseGroupConfig[] = [];
    if ("releaseGroups" in raw) {
        if (!Array.isArray(raw.releaseGroups)) {
            issues.push("'releaseGroups' must be an array when present");
        } else {
            raw.releaseGroups.forEach((entry, index) => {
                const group = parseReleaseGroup(entry, `releaseGroups[${index}]`, parseComponents, issues);
                if (group) {
                    releaseGroups.push(group);
                }
            });
        }
    }

    let components: ComponentConfig[] = [];
    if ("components" in raw) {
        if (!Array.isArray(raw.components)) {
            issues.push("'components' must be an array when present");
        } else {
            components = parseComponents(raw.components, "components");
        }
    }

    const declaredGroupCount = Array.isArray(raw.releaseGroups) ? raw.releaseGroups.length : 0;
    const declaredComponentCount = Array.isArray(raw.components) ? raw.components.length : 0;
    if (declaredGroupCount === 0 && declaredComponentCount === 0) {
        issues.push("'components' and 'releaseGroups' must declare at least one component between them");
    }
    const everyComponent = allComponents({ releaseGroups, components });

    // A release group sharing a name with a component would make the group's branch collide with the component's
    // own branch (see componentNaming.ts, `groupReleaseBranchName`).
    const seenGroupNames = new Set<string>();
    for (const group of releaseGroups) {
        if (seenGroupNames.has(group.name)) {
            issues.push(`releaseGroups: duplicate release group name '${group.name}'`);
        }
        seenGroupNames.add(group.name);

        if (seenComponentNames.has(group.name)) {
            issues.push(`releaseGroups: release group name '${group.name}' must not match a configured component name`);
        }
    }

    const migration = "migration" in raw ? parseMigrationConfig(raw.migration, everyComponent, issues) : undefined;

    if (issues.length > 0) {
        throw new ManifestConfigError(issues);
    }

    return { targetBranch, releaseGroups, components, migration };
}

function parseReleaseGroup(
    entry: unknown,
    location: string,
    parseComponents: (entries: readonly unknown[], location: string) => ComponentConfig[],
    issues: string[],
): ReleaseGroupConfig | undefined {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        issues.push(`${location}: expected an object`);
        return undefined;
    }

    const raw = entry as Record<string, unknown>;
    let name: string | undefined;
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
        issues.push(`${location}: 'name' must be a non-empty string`);
    } else if (!COMPONENT_NAME_PATTERN.test(raw.name)) {
        issues.push(`${location}: 'name' must only contain letters, digits, '.', '_' or '-' (got '${raw.name}')`);
    } else {
        name = raw.name;
    }

    if (!Array.isArray(raw.components)) {
        issues.push(`${location}: 'components' must be an array`);
        return undefined;
    }

    const components = parseComponents(raw.components, `${location}.components`);
    if (raw.components.length < 2) {
        const hint = components.length === 1
            ? ` — move '${components[0].component}' to the top-level 'components' (merge or close this group's open release pull request first)`
            : "";
        issues.push(`${location}: a release group must have at least 2 components${hint}`);
    }

    if (!name) {
        return undefined;
    }

    return { name, components };
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

function parseComponent(entry: unknown, location: string, validTypes: readonly string[], issues: string[]): ComponentConfig | undefined {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        issues.push(`${location}: expected an object`);
        return undefined;
    }

    const raw = entry as Record<string, unknown>;
    let valid = true;

    if (typeof raw.path !== "string") {
        issues.push(`${location}: 'path' must be a string`);
        valid = false;
    }

    if (typeof raw.component !== "string" || raw.component.trim() === "") {
        issues.push(`${location}: 'component' must be a non-empty string`);
        valid = false;
    } else if (!COMPONENT_NAME_PATTERN.test(raw.component)) {
        issues.push(`${location}: 'component' must only contain letters, digits, '.', '_' or '-' (got '${raw.component}')`);
        valid = false;
    }

    if (typeof raw.releaseType !== "string" || !validTypes.includes(raw.releaseType)) {
        issues.push(`${location}: 'releaseType' must be one of [${validTypes.join(", ")}] (got '${raw.releaseType}')`);
        valid = false;
    }

    if ("releaseGroup" in raw) {
        issues.push(`${location}: 'releaseGroup' is no longer supported — move the component into a 'releaseGroups' entry instead`);
        valid = false;
    }

    let prereleaseType: string | undefined;
    if ("prereleaseType" in raw) {
        if (typeof raw.prereleaseType !== "string" || !isValidPrereleaseIdentifier(raw.prereleaseType)) {
            issues.push(`${location}: 'prereleaseType' must be a valid SemVer pre-release identifier (e.g. 'beta', 'rc.1') when present (got '${raw.prereleaseType}')`);
            valid = false;
        } else {
            prereleaseType = raw.prereleaseType;
        }
    }

    if (!valid) {
        return undefined;
    }

    const path = normalizePath(raw.path as string, location, issues);
    if (path === undefined) {
        return undefined;
    }

    return {
        path,
        component: raw.component as string,
        releaseType: raw.releaseType as string,
        prereleaseType,
    };
}

function normalizePath(path: string, location: string, issues: string[]): string | undefined {
    const segments = path.split("/").filter(segment => segment !== "" && segment !== ".");

    // A path of only slashes/dots (e.g. "/", ".", "./") resolves to the root, which is relative by definition.
    if (path.startsWith("/") && segments.length > 0) {
        issues.push(`${location}: 'path' must be relative, not absolute (got '${path}')`);
        return undefined;
    }

    if (segments.includes("..")) {
        issues.push(`${location}: 'path' must not contain '..' (got '${path}')`);
        return undefined;
    }

    return segments.join("/");
}
