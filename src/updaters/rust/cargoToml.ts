import { edit } from "@rainbowatcher/toml-edit-js";
import { Updater } from "../../update";
import { Version } from "../../version";

export class CargoToml implements Updater {
    constructor(private readonly releaseVersion: Version, private readonly path: string) {}

    updateContent(content: string | undefined): string {
        if (!content) {
            return "";
        }

        return edit(content, "package.version", `${this.releaseVersion}`);
    }
}
