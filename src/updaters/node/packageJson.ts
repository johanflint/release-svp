import { Updater } from "../../update";
import { Version } from "../../version";
import { replaceJsonValue } from "../replaceJsonValue";

export class PackageJson implements Updater {
    constructor(private readonly releaseVersion: Version) {}

    updateContent(content: string | undefined): string {
        if (!content) {
            return "";
        }

        return replaceJsonValue(content, ["version"], `${this.releaseVersion}`);
    }
}
