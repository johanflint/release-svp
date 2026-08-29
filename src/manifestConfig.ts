import { strategyTypes } from "./strategyFactory";

// Component identifiers are used in tag names, branch names and labels, so keep them URL/git-ref safe.
const COMPONENT_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

export interface ManifestConfig {
    readonly targetBranch?: string;
    readonly components: readonly ComponentConfig[];
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

    if (issues.length > 0) {
        throw new ManifestConfigError(issues);
    }

    return { targetBranch, components };
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
    }

    if (typeof raw.releaseType !== "string" || !validTypes.includes(raw.releaseType)) {
        issues.push(`components[${index}]: 'releaseType' must be one of [${validTypes.join(", ")}] (got '${raw.releaseType}')`);
        valid = false;
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
