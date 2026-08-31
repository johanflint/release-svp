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
        const changelogPath = this.prefixed(CHANGELOG_PATH);
        const cargoPath = this.prefixed(CARGO_PATH);
        const lockPath = this.prefixed(LOCK_PATH);

        const updates: Update[] = [{
            path: changelogPath,
            createIfMissing: true,
            updater: new ChangelogUpdater(options.changelogEntry),
        }, {
            path: cargoPath,
            createIfMissing: false,
            updater: new CargoToml(options.releaseVersion, cargoPath),
        }];

        const tomlContent = await this.config.github.retrieveFileContents(cargoPath, options.targetBranch);
        const parsedManifest = parse(tomlContent.parsedContent) as CargoManifest;

        const versionsMap: Map<string, Version> = new Map();
        if (parsedManifest.package?.name) {
            versionsMap.set(parsedManifest.package.name, options.releaseVersion);
        }

        updates.push({
            path: lockPath,
            createIfMissing: false,
            updater: new CargoLock(versionsMap),
        });

        return updates;
    }

    // Prefixes a root-relative file name with this strategy's component path, so a component at path "a" reads/
    // writes "a/Cargo.toml" instead of the repo-root "Cargo.toml". The root component ("" / undefined) keeps
    // today's unprefixed behaviour.
    private prefixed(fileName: string): string {
        return this.config.componentPath ? `${this.config.componentPath}/${fileName}` : fileName;
    }
}

interface CargoManifest {
    package?: CargoPackage;
}

interface CargoPackage {
    name?: string;
    version?: string;
}
