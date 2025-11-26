import { parse } from "@rainbowatcher/toml-edit-js";
import { ChangelogUpdater } from "../changelogUpdater";
import { Strategy, StrategyConfiguration, UpdateOptions } from "../strategy";
import { Update } from "../update";
import { CargoLock } from "../updaters/rust/cargoLock";
import { CargoToml } from "../updaters/rust/cargoToml";
import { Version } from "../version";

const CHANGELOG_PATH = "CHANGELOG.md";
const CARGO_PATH = "Cargo.toml";
const LOCK_PATH = "Cargo.lock";

export class RustStrategy implements Strategy {
    constructor(readonly config: StrategyConfiguration) {}

    async determineUpdates(options: UpdateOptions): Promise<Update[]> {
        const updates: Update[] = [{
            path: CHANGELOG_PATH,
            createIfMissing: true,
            updater: new ChangelogUpdater(options.changelogEntry),
        }, {
            path: CARGO_PATH,
            createIfMissing: false,
            updater: new CargoToml(options.releaseVersion, CARGO_PATH),
        }];

        const tomlContent = await this.config.github.retrieveFileContents(CARGO_PATH, options.targetBranch);
        const parsedManifest = parse(tomlContent.parsedContent) as CargoManifest;

        const versionsMap: Map<string, Version> = new Map();
        if (parsedManifest.package?.name) {
            versionsMap.set(parsedManifest.package.name, options.releaseVersion);
        }

        updates.push({
            path: LOCK_PATH,
            createIfMissing: false,
            updater: new CargoLock(versionsMap),
        });

        return updates;
    }
}

interface CargoManifest {
    package?: CargoPackage;
}

interface CargoPackage {
    name?: string;
    version?: string;
}
