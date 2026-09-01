import { describe, expect, it } from "vitest";
import { pendingLabel, releaseBranchName, taggedLabel, tagPrefix } from "../src/componentNaming";

describe("componentNaming", () => {
    describe("tagPrefix", () => {
        it("returns an empty prefix for the root component", () => {
            expect(tagPrefix("")).toBe("");
        });

        it("returns a hyphenated prefix for a named component", () => {
            expect(tagPrefix("api")).toBe("api-");
        });
    });

    describe("releaseBranchName", () => {
        it("returns the unscoped branch name for the root component", () => {
            expect(releaseBranchName("main", "")).toBe("release-svp--branches-main");
        });

        it("returns a suffixed branch name for a named component", () => {
            expect(releaseBranchName("main", "api")).toBe("release-svp--branches-main--api");
        });

        it("produces distinct branch names for components whose names prefix one another", () => {
            expect(releaseBranchName("main", "api")).not.toBe(releaseBranchName("main", "api-v2"));
        });
    });

    describe("pendingLabel", () => {
        it("returns the unscoped label for the root component", () => {
            expect(pendingLabel("")).toBe("autorelease: pending");
        });

        it("returns a scoped label for a named component", () => {
            expect(pendingLabel("api")).toBe("autorelease: pending (api)");
        });
    });

    describe("taggedLabel", () => {
        it("returns the unscoped label for the root component", () => {
            expect(taggedLabel("")).toBe("autorelease: tagged");
        });

        it("returns a scoped label for a named component", () => {
            expect(taggedLabel("api")).toBe("autorelease: tagged (api)");
        });
    });
});
