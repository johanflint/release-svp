import { RustStrategy } from "./strategies/rust";
import { Strategy, StrategyConfiguration } from "./strategy";

type StrategyBuilder = (options: StrategyConfiguration) => Strategy;

const strategies: Record<string, StrategyBuilder> = {
    "rust": config => new RustStrategy(config),
}

export function strategyTypes(): readonly string[] {
    return Object.keys(strategies).sort();
}

export function buildStrategy(strategyType: keyof typeof strategies, config: StrategyConfiguration): Strategy {
    const builder = strategies[strategyType];
    if (builder) {
        return builder(config);
    }

    throw "Invalid strategy";
}
