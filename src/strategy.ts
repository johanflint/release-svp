import { Github } from "./github";
import { Update } from "./update";
import { Version } from "./version";

export interface StrategyConfiguration {
    github: Github;
}

export interface UpdateOptions {
    changelogEntry: string;
    releaseVersion: Version;
    targetBranch: string;
}

export interface Strategy {
    readonly config: StrategyConfiguration;

    determineUpdates(options: UpdateOptions): Promise<Update[]>;
}
