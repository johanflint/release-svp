import { Updater } from "../../update";
import { Version } from "../../version";
import { replaceJsonValue } from "../replaceJsonValue";

export class PackageLockJson implements Updater {
    constructor(private readonly releaseVersion: Version) {}

    updateContent(content: string | undefined): string {
        if (!content) {
            return "";
        }

        const lockfileVersion = JSON.parse(content).lockfileVersion;

        let paths: (string | number)[][];
        switch (lockfileVersion) {
            case 1:
                paths = [["version"]];
                break;
            case 2:
            case 3:
                paths = [["version"], ["packages", "", "version"]];
                break;
            default:
                throw new Error(`Unsupported package-lock.json lockfileVersion: ${lockfileVersion}`);
        }

        const version = `${this.releaseVersion}`;
        return paths.reduce((updated, path) => replaceJsonValue(updated, path, version), content);
    }
}
