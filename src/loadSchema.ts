import { readFileSync } from "fs";
import { join } from "path";

const schemaCache = new Map<string, string>();

export function loadSchema(file: string): string {
    if (!schemaCache.has(file)) {
        const path = join(__dirname, "..", "graphql", file);
        const content = readFileSync(path, "utf8");
        schemaCache.set(file, content);
    }

    return schemaCache.get(file)!;
}
