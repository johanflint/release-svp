import { Strategy, StrategyConfiguration, UpdateOptions } from "../strategy";
import { Update } from "../update";
import { ChangelogUpdater } from "../changelogUpdater";
import { PubspecYaml } from "../updaters/dart/pubspecYaml";

const CHANGELOG_PATH = "CHANGELOG.md";
const PUBSPEC_PATH = "pubspec.yaml";

export class DartStrategy implements Strategy {
    constructor(readonly config: StrategyConfiguration) {}

    async determineUpdates(options: UpdateOptions): Promise<Update[]> {
        const changelogPath = this.prefixed(CHANGELOG_PATH);
        const pubspecPath = this.prefixed(PUBSPEC_PATH);

        return [{
            path: changelogPath,
            createIfMissing: true,
            updater: new ChangelogUpdater(options.changelogEntry),
        }, {
            path: pubspecPath,
            createIfMissing: false,
            updater: new PubspecYaml(options.releaseVersion),
        }]
    }

    private prefixed(fileName: string): string {
        return this.config.componentPath ? `${this.config.componentPath}/${fileName}` : fileName;
    }
}
