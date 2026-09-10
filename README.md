# release-svp

A [release-please](https://github.com/googleapis/release-please)-style release automation tool. Given a GitHub
repository, it scans merged pull requests since the last release, builds a changelog, opens
a "release PR" that bumps version files, and — once that PR is merged — tags the release on GitHub.

## Quick start

Not sure which mode applies to you? Pick one:

| Your repository...                                                      | Use this                                                |
|---------------------------------------------------------------------------|----------------------------------------------------------|
| is a single project (one version, one changelog)                          | [Single-project mode](#single-project-mode-no-config-file) — no config file needed |
| is a monorepo where every component should release together, as one PR    | [Multi-component mode](#multi-component-mode-release-svp-configjson), default combining behaviour |
| is a monorepo with unrelated products that must NOT share a pull request  | Multi-component mode + [`releaseGroup`](#grouping-by-releasegroup) |
| is a monorepo where every component must always get its own pull request  | Multi-component mode + [`separatePullRequests`](#opting-out-separatepullrequests) |
| already has release history and is only now being split into components  | [Migrating an existing repository](#migrating-an-existing-repository-to-multiple-components) |
| needs a component to publish beta/rc versions instead of stable releases  | [Pre-releases](#pre-releases) via `prereleaseType` |

release-svp runs as two separate CLI commands, both meant to run in CI on every push to your default branch:

- `prepare` — scans merged pull requests since the last release and opens/updates the release pull request(s).
  Safe to run on every push; it's a no-op if nothing changed.
- `release` — checks whether a release pull request was just merged, and if so, tags the release and publishes a
  GitHub Release. Safe to run on every push too; it's a no-op if no release pull request is pending merge.

### Example: GitHub Actions workflow

```yaml
name: release
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      # Tags + publishes a GitHub Release if the push just merged a release pull request.
      - run: npx --yes release-svp@0.1.0 release --repo-url ${{ github.repository }} --token ${{ secrets.GITHUB_TOKEN }}

      # Opens/updates the pull request for the *next* release, reflecting anything merged since.
      - run: npx --yes release-svp@0.1.0 prepare --repo-url ${{ github.repository }} --token ${{ secrets.GITHUB_TOKEN }} --release-type node
```

`release-svp` is installed on the fly via `npx` — no need to check out the repository or install its own
dependencies, since the tool talks to GitHub's API directly rather than operating on a local checkout. Pin the
version (`release-svp@0.1.0`) rather than using `@latest`, so an upstream release can't silently change your
release behaviour underneath you; bump it deliberately when you want a newer version.

`--release-type` is only required for single-project mode (it's ignored, but harmless to pass, once a
`release-svp-config.json` exists, since each component then declares its own `releaseType`). `--repo-url` takes
`owner/repo` (e.g. `${{ github.repository }}`), not a full URL despite the name.

## Single-project mode (no config file)

If the repository has no `release-svp-config.json`, release-svp treats the whole repository as a single,
unnamed ("root") component. Pass `--release-type` on the command line to select the strategy — `rust`
(`Cargo.toml`/`Cargo.lock`) or `node` (`package.json`/`package-lock.json`) are currently supported. Tags,
branches and labels are unscoped (e.g. tag `v1.2.3`, branch `release-svp--main`, label `autorelease: pending`).

## Multi-component mode (`release-svp-config.json`)

To release multiple independently-versioned components from a single repository (a monorepo), add a
`release-svp-config.json` at the repository root:

```json
{
  "targetBranch": "main",

  "components": [
    { "component": "project-a", "path": "a", "releaseType": "rust" },
    { "component": "project-b", "path": "b", "releaseType": "rust" }
  ]
}
```

- `targetBranch` is optional; defaults to the repository's default branch.
- `component` is a stable identifier used to namespace tags (`project-a-v1.2.3`), branches
  (`release-svp--project-a--main`) and labels (`autorelease: pending (project-a)`). It's independent of `path`,
  so a directory can be renamed without losing release history.
- `path` is the directory (relative to the repository root) this component owns. A commit is attributed to a
  component if its changed files fall under that directory. If a file is under a more specific nested path
  (e.g. `"a/nested"` when both `"a"` and `"a/nested"` are configured), the more specific ("longest-prefix-wins")
  path claims it.
- `releaseType` selects the update strategy for that component: `rust` (`Cargo.toml`/`Cargo.lock`) or `node`
  (`package.json`/`package-lock.json`).
- `path: ""` designates a root component that owns anything not claimed by a more specific path. If no
  component declares `path: ""`, files that don't fall under any configured path (e.g. a top-level `README.md`)
  are excluded from every component's release detection — release-svp logs a warning when this happens, but
  does not fail the run, since it may be intentional.
- Each component is versioned, changelogged and tagged fully independently: a single pull request touching both
  `a/` and `b/` can result in two separate releases in the same cycle, each with its own changelog file, tag
  namespace, and GitHub Release page entry. By default they share one release *pull request* — see "Combined
  release pull requests" below for how that's controlled.

## Combined release pull requests

By default, when 2 or more components have unreleased changes at the same time, release-svp bundles them into
**one shared release pull request** instead of opening one per component. Each component still gets its own,
fully independent version bump, changelog and tag — grouping only affects the pull request itself, which now
has one section per component (each clearly marked, so it's still obvious what's being released):

```json
{
  "components": [
    { "component": "ios-client", "path": "ios", "releaseType": "rust" },
    { "component": "android-client", "path": "android", "releaseType": "rust" }
  ]
}
```

If both components have unreleased changes, they share one pull request titled `Release <repo>`. If only one
does, that component still gets its own pull request, titled `Release <component> v<version>` — nothing is held
back waiting for the other.

### Grouping by `releaseGroup`

A monorepo can also host unrelated products (or a mix of shared and standalone parts) that shouldn't all be
bundled together just because they happen to release at the same time. Set `releaseGroup` on a component to
control this explicitly — components sharing the same `releaseGroup` value are bundled together, independently
of any other component:

```json
{
  "components": [
    { "component": "ios-client", "path": "mobile/ios", "releaseType": "rust", "releaseGroup": "mobile" },
    { "component": "android-client", "path": "mobile/android", "releaseType": "rust", "releaseGroup": "mobile" },
    { "component": "backend", "path": "backend", "releaseType": "rust" }
  ]
}
```

Here, `ios-client` and `android-client` always share one pull request titled `Release mobile`, while `backend`
(no `releaseGroup`) always gets its own pull request titled `Release backend v<version>`, regardless of whether
the other two have changes. A `releaseGroup` with only one member behaves exactly like an ungrouped component. A
component without `releaseGroup` is never folded into another component's group, nor into the default "everyone
with changes" bundle above — once any component in the repository declares a `releaseGroup`, that grouping is
used everywhere and the "bundle everyone with changes" default no longer applies to any component.

### Pull request titles

A pull request's title always reflects what it actually contains, so multiple open pull requests in the same
repository can be told apart at a glance without opening each one:
- A single-project repository (no config file), or a config file with exactly one component: `Release v<version>`
  — there's nothing else configured to disambiguate against.
- A multi-component repository's own singleton pull request (a component with no `releaseGroup`, or a
  `releaseGroup` that ends up with only one member): `Release <component> v<version>`.
- A combined/grouped pull request (2+ components sharing one pull request): `Release <group>` — no version,
  since each member is versioned independently.

### Opting out: `separatePullRequests`

To keep one-pull-request-per-component behaviour instead, with no bundling at all, set:

```json
{ "separatePullRequests": true, "components": [ { "component": "project-a", "path": "a", "releaseType": "rust" } ] }
```

This is a repository-wide escape hatch — it's rejected by config validation if any component also declares
`releaseGroup`, since the two would otherwise have unclear precedence. It's meaningless (ignored) for
single-component repositories, where there's only ever one pull request either way.

### Frozen membership and orphaned components

Once a combined pull request is open, its set of components is "frozen": a component that simply has no new
commits yet is carried forward unchanged in the pull request body, never silently dropped. If a component that
already has a section in an open combined pull request is removed from the config, or moved to a different
`releaseGroup`, the affected unit's run fails loudly instead of silently discarding its section — merge or close
the existing pull request, or restore the component's group, before the next run.

### Rolling out to an existing repository

Enabling this on a repository that already has open, per-component release pull requests from before this
feature existed is safe to do at any time: the combined pull request lives on its own, separately-named branch
(`release-svp--branches-<target>--<group>`), which never collides with an individual component's own branch. Any
already-open per-component pull request is simply left alone — merge or close it as usual — while future runs
start using combined pull requests going forward.

## Pre-releases

Set `prereleaseType` on a component to have its releases carry a SemVer pre-release identifier (e.g.
`1.2.0-beta`), published to GitHub as a pre-release rather than a regular release:

```json
{
  "components": [
    { "component": "project-a", "path": "a", "releaseType": "rust", "prereleaseType": "beta" }
  ]
}
```

- The value must be a valid SemVer pre-release identifier — dot-separated alphanumeric segments, no leading
  zeros on purely-numeric segments (e.g. `beta`, `rc.1`, `alpha-2` are valid; `01` is not).
- The first release with `prereleaseType` set uses the identifier as-is (e.g. `1.2.0-beta`). Each subsequent
  release, while still configured with the *same* identifier, continues that train by incrementing its trailing
  number (`1.2.0-beta` → `1.2.0-beta.1` → `1.2.0-beta.2`, ...) rather than bumping the version further — the
  version only advances once a new numeric bump is actually warranted by the commits since the last release.
- Changing `prereleaseType` to a different value (e.g. `"beta"` → `"rc"`) starts a fresh train at that new
  identifier (`1.2.0-rc`), rather than continuing the old one's numbering.
- Removing `prereleaseType` from config graduates the component to a stable release on its very next run — at
  the same major.minor.patch it was already at (e.g. `1.2.0-beta.3` → `1.2.0`), never bumping further just to
  "leave" pre-release status. This is a one-way, config-driven switch: a stable release is never turned back
  into a pre-release, and a manually-created tag that happens to carry pre-release metadata (from before this
  feature existed, or from history predating a config change) does not by itself keep a component in pre-release
  mode — only the current `prereleaseType` config value decides that.
- A component's version is never allowed to move backwards, regardless of `prereleaseType` changes: switching
  pre-release identifiers, or graduating to stable, always compares against every previously released version
  (both pre-release and stable) and only ever advances.

## Migrating an existing repository to multiple components

A common path is: a repository starts in single-project mode, accumulates release history under unscoped tags
(`v1.2.3`, ...), and only later gets split into multiple components. Doing this safely requires a `migration`
block in `release-svp-config.json`, because release-svp **cannot infer** how the old, whole-repository history
should map onto the new components — that's a decision only you can make.

### Why this can't be automatic

- A legacy tag like `v1.4.0` represents a snapshot of the *entire* repository, not any one new component. It can
  only be a sensible starting point for **at most one** of the new components (the one that effectively
  "continues" what the repository used to be) — assigning it to more than one would make their histories falsely
  identical, and assigning it to none would silently discard it.
- Auto-detecting "the latest tag" is risky: leftover/CI/pre-release tags, non-linear history, or a repository
  that never released before can all cause a wrong guess. A wrong guess produces a wrong version baseline (a
  bad changelog, a duplicate or skipped release) that's easy to miss until someone reviews it after the fact. An
  explicit, missing/misspelled field instead fails config validation immediately, before any release is created.

For this reason, **explicit beats implicit** here: you declare the cutover point and, if applicable, which
component inherits the old history and from which exact tag — release-svp will not guess.

### Example

Say a repository releases as a single project (tags `v1.0.0`, `v1.4.0`, ...). Commit `A` makes an ordinary
change and should be released normally, under the old scheme, first. Commit `R` then reorganizes the repository
into the new component layout (e.g. moving files into `a/` and `b/`). Only *after* `R` exists — and its sha is
therefore known — does a later commit `C` add `release-svp-config.json`, referencing `R`'s sha and splitting the
repository into components `a` (continuing the old repository's identity) and `b` (brand new, no prior history).
`R` and `C` must be two separate commits: a commit's sha can't be known before it's created, so a config
couldn't reference its own not-yet-computed sha if it were added in the very same commit that reorganizes the
repository.

```json
{
  "components": [
    { "component": "a", "path": "a", "releaseType": "rust" },
    { "component": "b", "path": "b", "releaseType": "rust" }
  ],
  "migration": {
    "cutoverCommit": "<full 40-character sha of commit R>",
    "legacyRootSuccessor": "a",
    "legacyAnchorTag": "v1.4.0",
    "bootstrapVersions": {
      "b": "0.1.0"
    }
  }
}
```

- `cutoverCommit`: the commit that reorganized the repository into the new component layout (commit `R`) — an
  earlier, separate commit from the one that adds this config (commit `C`; see above for why they can't be the
  same commit). Commits at or before this one predate any component concept and are never considered
  "unreleased" for any component — this also excludes the reorganization commit itself from every component's
  changelog.
- `legacyRootSuccessor`: which component (if any) continues the old repository's release history. Omit entirely
  if none should (e.g. the repository is being split into components that are all conceptually new).
- `legacyAnchorTag`: required whenever `legacyRootSuccessor` is set. The exact, last tag created under the OLD,
  unscoped scheme — used once, as a fallback, only until `a` has created its own first component-scoped tag
  (e.g. `"a-v1.5.0"`). Must be given explicitly; see "Why this can't be automatic" above.
- `bootstrapVersions`: every component that is NOT the legacy successor has no history to inherit and must
  declare an explicit starting version — release-svp will refuse to load the config otherwise, rather than
  silently start it at `0.0.0`.

With this config:
- `a`'s next release picks up from `v1.4.0` (e.g. `a-v1.5.0`), including only commits after `cutoverCommit` —
  everything up to and including commit `A` was already released under the old scheme and won't be re-released.
- `b` starts fresh at `0.1.0`, considering only commits after `cutoverCommit` that touch `b/`.
- Once `a` has created its own tag (`a-v1.5.0` or later), `legacyAnchorTag`/`legacyRootSuccessor` are no longer
  consulted for `a` — they only matter for that one first post-migration release. The `migration` block can be
  left in the config afterwards; it becomes inert for `a` once its own tag exists, but is still required by
  config validation, so remove it once you no longer need it documented.

### What migration does *not* do

- It does not move, split, or rewrite `CHANGELOG.md`/version files for you. If `a` is meant to continue the old
  repository's identity but its version files now live at `a/Cargo.toml` instead of the repository root, you
  still need to make that reorganization yourself (e.g. as part of commit `R`) — release-svp only reads/writes
  wherever a component's strategy is configured to look (`<path>/Cargo.toml`, etc).
- It does not automatically close or migrate any release PR that was already open under the old, unscoped
  branch/label scheme before you added the config. Merge or close it before switching, or it will become
  invisible to every component's scoped search.
- It does not (yet) support seamlessly picking up an in-flight pending release PR created before migration and
  continuing it under the new scheme.

Note: if `cutoverCommit` isn't reachable from `targetBranch` (typo, or the wrong branch), the affected
component's release run fails loudly rather than silently releasing unbounded history. Fix `cutoverCommit` and
re-run.

## Troubleshooting: a merged release pull request never gets tagged

`release` finds a component's still-untagged releases by looking for merged pull requests that still carry its
`autorelease: pending (...)` label — that label is only removed once the release has actually been created, so
it's authoritative rather than a heuristic: every pending pull request is always found, however much other
release history surrounds it.

If `release` is interrupted after creating the GitHub Release/tag but before it finishes commenting on the pull
request and swapping its labels (a network blip, a GitHub API hiccup, etc.), the next run resumes automatically:
it looks up the existing release by tag instead of creating a duplicate one, and finishes the labeling. The
`autorelease: tagged (...)` label is added before `autorelease: pending (...)` is removed, so a pull request
interrupted mid-cleanup is left with both labels rather than neither — still safely resumable, and never mistaken
for a fresh, unreleased pull request.

