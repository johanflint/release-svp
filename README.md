# release-svp

A [release-please](https://github.com/googleapis/release-please)-style release automation tool. Given a GitHub
repository, it scans merged pull requests since the last release, builds a changelog, opens
a "release PR" that bumps version files, and — once that PR is merged — tags the release on GitHub.

## Single-project mode (no config file)

If the repository has no `release-svp-config.json`, release-svp treats the whole repository as a single,
unnamed ("root") component. Pass `--release-type` on the command line to select the strategy (currently only
`rust` exists). Tags, branches and labels are unscoped (e.g. tag `v1.2.3`, branch `release-svp--main`, label
`autorelease: pending`).

## Multi-component mode (`release-svp-config.json`)

To release multiple independently-versioned components from a single repository (a monorepo), add a
`release-svp-config.json` at the repository root:

```jsonc
{
  // Optional; defaults to the repository's default branch.
  "targetBranch": "main",

  "components": [
    { "component": "project-a", "path": "a", "releaseType": "rust" },
    { "component": "project-b", "path": "b", "releaseType": "rust" }
  ]
}
```

- `component` is a stable identifier used to namespace tags (`project-a-v1.2.3`), branches
  (`release-svp--project-a--main`) and labels (`autorelease: pending (project-a)`). It's independent of `path`,
  so a directory can be renamed without losing release history.
- `path` is the directory (relative to the repository root) this component owns. A commit is attributed to a
  component if its changed files fall under that directory. If a file is under a more specific nested path
  (e.g. `"a/nested"` when both `"a"` and `"a/nested"` are configured), the more specific ("longest-prefix-wins")
  path claims it.
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

```jsonc
{
  "components": [
    { "component": "ios-client", "path": "ios", "releaseType": "rust" },
    { "component": "android-client", "path": "android", "releaseType": "rust" }
  ]
}
```

If both components have unreleased changes, they share one pull request titled `Release <repo>`. If only one
does, that component still gets its own pull request — nothing is held back waiting for the other.

### Grouping by `releaseGroup`

A monorepo can also host unrelated products (or a mix of shared and standalone parts) that shouldn't all be
bundled together just because they happen to release at the same time. Set `releaseGroup` on a component to
control this explicitly — components sharing the same `releaseGroup` value are bundled together, independently
of any other component:

```jsonc
{
  "components": [
    { "component": "ios-client", "path": "mobile/ios", "releaseType": "rust", "releaseGroup": "mobile" },
    { "component": "android-client", "path": "mobile/android", "releaseType": "rust", "releaseGroup": "mobile" },
    { "component": "backend", "path": "backend", "releaseType": "rust" }
  ]
}
```

Here, `ios-client` and `android-client` always share one pull request titled `Release mobile`, while `backend`
(no `releaseGroup`) always gets its own pull request titled `Release v{version}`, regardless of whether the
other two have changes. A `releaseGroup` with only one member behaves exactly like an ungrouped component. A
component without `releaseGroup` is never folded into another component's group, nor into the default "everyone
with changes" bundle above — once any component in the repository declares a `releaseGroup`, that grouping is
used everywhere and the "bundle everyone with changes" default no longer applies to any component.

### Opting out: `separatePullRequests`

To keep one-pull-request-per-component behaviour instead, with no bundling at all, set:

```jsonc
{ "separatePullRequests": true, "components": [ /* ... */ ] }
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
change and should be released normally, under the old scheme, first. Commit `B` then adds
`release-svp-config.json`, splitting the repository into components `a` (continuing the old repository's
identity) and `b` (brand new, no prior history):

```jsonc
{
  "components": [
    { "component": "a", "path": "a", "releaseType": "rust" },
    { "component": "b", "path": "b", "releaseType": "rust" }
  ],
  "migration": {
    // The commit that introduced this config (commit B). Commits at or before this one predate any component
    // concept and are never considered "unreleased" for any component — this also excludes the reorganization
    // commit itself from every component's changelog.
    "cutoverCommit": "<full 40-character sha of commit B>",

    // Which component (if any) continues the old repository's release history. Omit entirely if none should
    // (e.g. the repository is being split into components that are all conceptually new).
    "legacyRootSuccessor": "a",

    // Required whenever 'legacyRootSuccessor' is set. The exact, last tag created under the OLD, unscoped
    // scheme — used once, as a fallback, only until 'a' has created its own first component-scoped tag
    // (e.g. "a-v1.5.0"). Must be given explicitly; see "Why this can't be automatic" above.
    "legacyAnchorTag": "v1.4.0",

    // Every component that is NOT the legacy successor has no history to inherit and must declare an explicit
    // starting version — release-svp will refuse to load the config otherwise, rather than silently start it
    // at 0.0.0.
    "bootstrapVersions": {
      "b": "0.1.0"
    }
  }
}
```

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
  still need to make that reorganization yourself (e.g. as part of commit `B`) — release-svp only reads/writes
  wherever a component's strategy is configured to look (`<path>/Cargo.toml`, etc).
- It does not automatically close or migrate any release PR that was already open under the old, unscoped
  branch/label scheme before you added the config. Merge or close it before switching, or it will become
  invisible to every component's scoped search.
- It does not (yet) support seamlessly picking up an in-flight pending release PR created before migration and
  continuing it under the new scheme.

Note: if `cutoverCommit` isn't reachable from `targetBranch` (typo, or the wrong branch), the affected
component's release run fails loudly rather than silently releasing unbounded history. Fix `cutoverCommit` and
re-run.
