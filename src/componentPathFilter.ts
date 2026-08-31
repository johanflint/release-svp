import { logger } from "./logger";

// Determines the owning component path for a file, using longest-prefix-wins across the full set of configured
// component paths. Returns "" (the root component's path) if no more specific component claims it — this is
// what lets the root component "own anything not claimed by a more specific path" (see manifestConfig.ts).
export function resolveOwningComponentPath(filePath: string, allComponentPaths: readonly string[]): string {
    let owner = "";
    for (const path of allComponentPaths) {
        if (path === "") {
            continue; // The root path never "claims" a file over a more specific component; it's the fallback.
        }

        const isWithinPath = filePath === path || filePath.startsWith(`${path}/`);
        if (isWithinPath && path.length > owner.length) {
            owner = path;
        }
    }

    return owner;
}

export type PathFilterVerdict = "match" | "no-match" | "unknown";

// Determines whether a set of changed file paths (e.g. from a pull request) belongs to `componentPath`, given
// the full set of configured component paths (needed so the root component correctly excludes files owned by
// a more specific sibling component).
//
// - `changedFilePaths` undefined means no file data is available at all (e.g. a direct commit with no
//   associated pull request) — returns "unknown"; callers must decide how to handle this case themselves,
//   since a safe default depends on whether the caller is the root component or not (see determineReleaseContext.ts).
// - A truncated result (`changedFilePathsTruncated: true`, i.e. the PR touched more files than were fetched)
//   returns "match" whenever ownership can't be ruled out from the observed subset, to avoid silently missing a
//   release rather than risk a spurious one.
export function matchesComponentPath(
    changedFilePaths: readonly string[] | undefined,
    changedFilePathsTruncated: boolean | undefined,
    componentPath: string,
    allComponentPaths: readonly string[],
): PathFilterVerdict {
    if (changedFilePaths === undefined) {
        return "unknown";
    }

    const isOwned = changedFilePaths.some(path => resolveOwningComponentPath(path, allComponentPaths) === componentPath);
    if (isOwned) {
        return "match";
    }

    if (changedFilePathsTruncated) {
        logger.warn(`Changed files list was truncated, conservatively assuming it may affect component '${componentPath || "<root>"}'`);
        return "match";
    }

    warnIfUnattributed(changedFilePaths, allComponentPaths);
    return "no-match";
}

// Warns when none of the changed files are owned by ANY configured component (not just `componentPath`) and no
// root component (path "") is configured to catch them. Without an explicit root component, such changes are
// silently excluded from every release train — see the discussion in the rubber-duck review that prompted this
// warning. Note: since each component is checked independently (see determineReleaseContext.ts), this may log
// once per configured component for the same underlying commit/pull request; that redundancy is preferred over
// adding cross-component shared state just to deduplicate a warning.
function warnIfUnattributed(changedFilePaths: readonly string[], allComponentPaths: readonly string[]): void {
    if (allComponentPaths.includes("")) {
        return; // A root component is configured, so it will pick up these files itself.
    }

    const isUnattributed = changedFilePaths.every(path => resolveOwningComponentPath(path, allComponentPaths) === "");
    if (isUnattributed) {
        logger.warn(`Changed file(s) [${changedFilePaths.join(", ")}] do not belong to any configured component and no root component is configured — this change will not trigger a release for any component`);
    }
}
