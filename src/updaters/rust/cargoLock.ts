import { edit, parse } from "@rainbowatcher/toml-edit-js";
import { Updater } from "../../update";
import { Version } from "../../version";

export class CargoLock implements Updater {
    constructor(private readonly versionsMap: Map<string, Version>) {}

    updateContent(content: string | undefined): string {
        const document = parse(content ?? "");
        const packages: Array<CargoPackage> = document["package"] ?? [];

        return packages
            .filter((pkg) => this.versionsMap.has(pkg.name))
            .reduce((updatedContent: string, pkg: CargoPackage, index: number) =>
                    edit(updatedContent, `package.[${index}].version`, `${this.versionsMap.get(pkg.name)}`)
                , content ?? "");
    }
}

interface CargoPackage {
    name: string;
    version: string;
}
