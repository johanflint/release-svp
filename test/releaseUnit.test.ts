import { describe, expect, it } from "vitest";
import { ComponentConfig } from "../src/manifestConfig";
import { computeReleaseUnits } from "../src/releaseUnit";

function component(component: string, releaseGroup?: string): ComponentConfig {
    return { path: component, component, releaseType: "node", releaseGroup };
}

describe("computeReleaseUnits", () => {
    it("returns a singleton unit for a single configured (root) component", () => {
        const root = component("");
        const units = computeReleaseUnits([root], "main", undefined);

        expect(units).toEqual([{ branchName: "release-svp--branches-main", members: [root] }]);
    });

    it("returns a singleton unit when only one component is configured, even with separatePullRequests unset", () => {
        const api = component("api");
        const units = computeReleaseUnits([api], "main", undefined);

        expect(units).toEqual([{ branchName: "release-svp--branches-main--api", members: [api] }]);
    });

    it("combines every component into one implicit default unit when no releaseGroup is declared", () => {
        const api = component("api");
        const web = component("web");
        const units = computeReleaseUnits([api, web], "main", undefined);

        expect(units).toEqual([{
            groupId: "combined",
            branchName: "release-svp--branches-main--combined",
            members: [api, web],
        }]);
    });

    it("keeps every component as its own singleton unit when separatePullRequests is true and no releaseGroup is declared", () => {
        const api = component("api");
        const web = component("web");
        const units = computeReleaseUnits([api, web], "main", true);

        expect(units).toEqual([
            { branchName: "release-svp--branches-main--api", members: [api] },
            { branchName: "release-svp--branches-main--web", members: [web] },
        ]);
    });

    it("groups components sharing the same releaseGroup into one unit", () => {
        const ios = component("ios-client", "product-a");
        const android = component("android-client", "product-a");
        const units = computeReleaseUnits([ios, android], "main", undefined);

        expect(units).toEqual([{
            groupId: "product-a",
            branchName: "release-svp--branches-main--product-a",
            members: [ios, android],
        }]);
    });

    it("keeps ungrouped components as their own singleton units when other components declare a releaseGroup", () => {
        const ios = component("ios-client", "product-a");
        const android = component("android-client", "product-a");
        const standalone = component("standalone");
        const units = computeReleaseUnits([ios, android, standalone], "main", undefined);

        expect(units).toEqual([
            { branchName: "release-svp--branches-main--standalone", members: [standalone] },
            { groupId: "product-a", branchName: "release-svp--branches-main--product-a", members: [ios, android] },
        ]);
    });

    it("supports multiple distinct releaseGroups at once", () => {
        const ios = component("ios-client", "product-a");
        const android = component("android-client", "product-a");
        const web = component("web-client", "product-b");
        const units = computeReleaseUnits([ios, android, web], "main", undefined);

        expect(units).toEqual([
            { groupId: "product-a", branchName: "release-svp--branches-main--product-a", members: [ios, android] },
            { groupId: "product-b", branchName: "release-svp--branches-main--product-b", members: [web] },
        ]);
    });
});
