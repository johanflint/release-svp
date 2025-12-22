import { describe, expect, test } from "vitest";
import { Github } from "../src/github";
import { logger } from "../src/logger";
import { RustStrategy } from "../src/strategies/rust";
import { StrategyConfiguration } from "../src/strategy";
import { buildStrategy, strategyTypes } from "../src/strategyFactory";

describe("strategyFactory", () => {
    describe("strategyTypes", () => {
        test("returns all strategies", () => {
            expect(strategyTypes()).toEqual(["rust"]);
        });
    });

    describe("buildStrategy", () => {
        const github = new Github({ owner: "", repo: "" }, "token", logger);
        const config: StrategyConfiguration = { github };

        test("returns a builder for a valid strategy type", () => {
            const strategy = buildStrategy("rust", config);
            expect(strategy).toBeInstanceOf(RustStrategy);
        });

        test("throws for unknown strategy types", () => {
            expect(() => buildStrategy("invalid", config)).toThrow("Invalid strategy 'invalid'");
        });
    });
});
