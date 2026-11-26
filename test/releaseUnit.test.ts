import { describe, expect, it } from "vitest";
import { ComponentConfig } from "../src/manifestConfig";
import { computeReleaseUnits } from "../src/releaseUnit";

function component(component: string): ComponentConfig {
    return { path: component, component, releaseType: "node" };
}

describe("computeReleaseUnits", () => {
    it("returns a singleton unit for a single configured (root) component", () => {
        const root = component("");
        const units = computeReleaseUnits({ components: [root] }, "main");

        expect(units).toEqual([{ branchName: "release-svp--branches-main", members: [root] }]);
    });

    it("returns a singleton unit when only one component is configured", () => {
        const api = component("api");
        const units = computeReleaseUnits({ components: [api] }, "main");

        expect(units).toEqual([{ branchName: "release-svp--branches-main--api", members: [api] }]);
    });

    it("keeps every ungrouped component as its own singleton unit", () => {
        const api = component("api");
        const web = component("web");
        const units = computeReleaseUnits({ releaseGroups: [], components: [api, web] }, "main");

        expect(units).toEqual([
            { branchName: "release-svp--branches-main--api", members: [api] },
            { branchName: "release-svp--branches-main--web", members: [web] },
        ]);
    });

    it("returns one unit per release group, named after the group", () => {
        const ios = component("ios-client");
        const android = component("android-client");
        const units = computeReleaseUnits({ releaseGroups: [{ name: "product-a", components: [ios, android] }], components: [] }, "main");

        expect(units).toEqual([{
            groupId: "product-a",
            branchName: "release-svp--branches-main--product-a",
            members: [ios, android],
        }]);
    });

    it("returns release group units first, then a singleton unit per ungrouped component", () => {
        const ios = component("ios-client");
        const android = component("android-client");
        const web1 = component("web-client-1");
        const web2 = component("web-client-2");
        const standalone = component("standalone");
        const units = computeReleaseUnits({
            releaseGroups: [
                { name: "product-a", components: [ios, android] },
                { name: "product-b", components: [web1, web2] },
            ],
            components: [standalone],
        }, "main");

        expect(units).toEqual([
            { groupId: "product-a", branchName: "release-svp--branches-main--product-a", members: [ios, android] },
            { groupId: "product-b", branchName: "release-svp--branches-main--product-b", members: [web1, web2] },
            { branchName: "release-svp--branches-main--standalone", members: [standalone] },
        ]);
    });
});
