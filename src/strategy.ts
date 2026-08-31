import { Github } from "./github";
import { Update } from "./update";
import { Version } from "./version";

export interface StrategyConfiguration {
    github: Github;
    // Root-relative directory this component's files live under (see componentPathFilter.ts). "" for the root
    // component/single-project (backward-compatible default) — strategies must prefix their file paths with this
    // so multiple components don't clobber each other's CHANGELOG.md/Cargo.toml/etc.
    componentPath?: string;
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
