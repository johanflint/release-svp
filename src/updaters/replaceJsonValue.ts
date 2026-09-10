import { applyEdits, modify } from "jsonc-parser";

// Surgically replaces the string value at `path` in `content`, leaving every other byte
// (indentation, key order, trailing newline, line endings) untouched. Throws if `path` doesn't
// already point at a string, so a missing/malformed version field fails loudly instead of being
// silently inserted or repaired (jsonc-parser's `modify()` creates missing paths by default).
export function replaceJsonValue(content: string, path: (string | number)[], value: string): string {
    const parsed: unknown = JSON.parse(content);
    const existing = path.reduce((node, key) => (node as Record<string | number, unknown>)?.[key], parsed);
    if (typeof existing !== "string") {
        throw new Error(`Expected a string at path ${path.join(".")}, found ${JSON.stringify(existing)}`);
    }

    const edits = modify(content, path, value, {});
    return applyEdits(content, edits);
}
