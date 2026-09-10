import { Strategy, StrategyConfiguration, UpdateOptions } from "../strategy";
import { Update } from "../update";
import { PackageJson } from "../updaters/node/packageJson";
import { ChangelogUpdater } from "../changelogUpdater";
import { PackageLockJson } from "../updaters/node/packageLockJson";

const CHANGELOG_PATH = "CHANGELOG.md";
const PACKAGE_PATH = "package.json";
const LOCK_PATH = "package-lock.json";

export class NodeStrategy implements Strategy {
    constructor(readonly config: StrategyConfiguration) {}

    async determineUpdates(options: UpdateOptions): Promise<Update[]> {
        const changelogPath = this.prefixed(CHANGELOG_PATH);
        const packagePath = this.prefixed(PACKAGE_PATH);
        const lockPath = this.prefixed(LOCK_PATH);

        return [{
            path: changelogPath,
            createIfMissing: true,
            updater: new ChangelogUpdater(options.changelogEntry),
        }, {
            path: packagePath,
            createIfMissing: false,
            updater: new PackageJson(options.releaseVersion),
        }, {
            path: lockPath,
            createIfMissing: false,
            updater: new PackageLockJson(options.releaseVersion),
        }];
    }

    private prefixed(fileName: string): string {
        return this.config.componentPath ? `${this.config.componentPath}/${fileName}` : fileName;
    }
}