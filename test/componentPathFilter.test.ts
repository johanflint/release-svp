import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesComponentPath, resolveOwningComponentPath } from "../src/componentPathFilter";
import { logger } from "../src/logger";

describe("componentPathFilter", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe("resolveOwningComponentPath", () => {
        it("returns the root path when no configured component claims the file", () => {
            expect(resolveOwningComponentPath("README.md", ["a", "b"])).toBe("");
        });

        it("returns the matching component path for a file inside it", () => {
            expect(resolveOwningComponentPath("a/src/lib.rs", ["a", "b"])).toBe("a");
        });

        it("matches a file that equals the component path itself", () => {
            expect(resolveOwningComponentPath("a", ["a", "b"])).toBe("a");
        });

        it("does not match a sibling directory whose name merely shares a prefix", () => {
            expect(resolveOwningComponentPath("a-extra/file.txt", ["a"])).toBe("");
        });

        it("resolves nested component paths using longest-prefix-wins", () => {
            expect(resolveOwningComponentPath("a/nested/file.txt", ["a", "a/nested"])).toBe("a/nested");
        });

        it("ignores the root path (\"\") as a candidate owner", () => {
            expect(resolveOwningComponentPath("anything.txt", ["", "a"])).toBe("");
        });
    });

    describe("matchesComponentPath", () => {
        const allComponentPaths = ["a", "b"];

        it("returns 'unknown' when no changed-file data is available", () => {
            expect(matchesComponentPath(undefined, "a", allComponentPaths)).toBe("unknown");
        });

        it("returns 'match' when a changed file belongs to the component", () => {
            expect(matchesComponentPath(["a/src/lib.rs"], "a", allComponentPaths)).toBe("match");
        });

        it("returns 'no-match' when no changed file belongs to the component", () => {
            expect(matchesComponentPath(["b/src/lib.rs"], "a", allComponentPaths)).toBe("no-match");
        });

        it("returns 'match' for the root component when a file belongs to no configured component", () => {
            expect(matchesComponentPath(["README.md"], "", allComponentPaths)).toBe("match");
        });

        it("returns 'no-match' for the root component when every file belongs to a more specific component", () => {
            expect(matchesComponentPath(["a/src/lib.rs"], "", allComponentPaths)).toBe("no-match");
        });

        it("warns when a changed file belongs to no configured component and no root component exists", () => {
            vi.spyOn(logger, "warn");

            expect(matchesComponentPath(["README.md"], "a", allComponentPaths)).toBe("no-match");
            expect(logger.warn).toHaveBeenCalledWith("Changed file(s) [README.md] do not belong to any configured component and no root component is configured — this change will not trigger a release for any component");
        });

        it("does not warn when a root component is configured", () => {
            vi.spyOn(logger, "warn");

            expect(matchesComponentPath(["README.md"], "a", ["", "a", "b"])).toBe("no-match");
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it("does not warn when at least one changed file belongs to a configured component", () => {
            vi.spyOn(logger, "warn");

            expect(matchesComponentPath(["README.md", "b/src/lib.rs"], "a", allComponentPaths)).toBe("no-match");
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });
});
