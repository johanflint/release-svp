import { describe, expect, it } from "vitest";
import { DEFAULT_RELEASE_GROUP_ID, groupReleaseBranchName, pendingLabel, releaseBranchName, taggedLabel, tagPrefix } from "../src/componentNaming";

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

    describe("groupReleaseBranchName", () => {
        it("is distinct from the root component's own branch name", () => {
            expect(groupReleaseBranchName("main", DEFAULT_RELEASE_GROUP_ID)).not.toBe(releaseBranchName("main", ""));
        });

        it("is distinct from a named component's branch name", () => {
            expect(groupReleaseBranchName("main", DEFAULT_RELEASE_GROUP_ID)).not.toBe(releaseBranchName("main", "api"));
        });

        it("is identical to releaseBranchName(targetBranch, groupId) — why a group id can never match a component name (see manifestConfig.ts)", () => {
            expect(groupReleaseBranchName("main", "combined")).toBe(releaseBranchName("main", "combined"));
            expect(groupReleaseBranchName("main", "product-a")).toBe(releaseBranchName("main", "product-a"));
        });

        it("is stable for the same target branch and group id", () => {
            expect(groupReleaseBranchName("main", "product-a")).toBe(groupReleaseBranchName("main", "product-a"));
        });

        it("varies by target branch", () => {
            expect(groupReleaseBranchName("main", "product-a")).not.toBe(groupReleaseBranchName("trunk", "product-a"));
        });

        it("varies by group id", () => {
            expect(groupReleaseBranchName("main", "product-a")).not.toBe(groupReleaseBranchName("main", "product-b"));
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
