import { Commit } from "./commit";
import { Version } from "./version";

export interface VersioningStrategy {
    releaseType(commits: Commit[]): VersionUpdater;
}

export interface VersionUpdater {
    bump(version: Version): Version;
}

export class MajorVersionUpdate implements VersionUpdater {
    bump(version: Version): Version {
        return new Version(
            version.major + 1,
            0,
            0,
            version.preRelease,
            version.build
        );
    }
}

export class MinorVersionUpdate implements VersionUpdater {
    bump(version: Version): Version {
        return new Version(
            version.major,
            version.minor + 1,
            0,
            version.preRelease,
            version.build
        );
    }
}

export class PatchVersionUpdate implements VersionUpdater {
    bump(version: Version): Version {
        return new Version(
            version.major,
            version.minor,
            version.patch + 1,
            version.preRelease,
            version.build
        );
    }
}
