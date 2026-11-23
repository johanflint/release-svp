import { RustStrategy } from "./strategies/rust";
import { Strategy, StrategyConfiguration } from "./strategy";
import { NodeStrategy } from "./strategies/node";
import { DartStrategy } from "./strategies/dart";

type StrategyBuilder = (options: StrategyConfiguration) => Strategy;

const strategies: Record<string, StrategyBuilder> = {
    "rust": config => new RustStrategy(config),
    "node": config => new NodeStrategy(config),
    "dart": config => new DartStrategy(config),
}

export function strategyTypes(): readonly string[] {
    return Object.keys(strategies).sort();
}

export function buildStrategy(strategyType: keyof typeof strategies, config: StrategyConfiguration): Strategy {
    const builder = strategies[strategyType];
    if (builder) {
        return builder(config);
    }

    throw `Invalid strategy '${strategyType}'`;
}
