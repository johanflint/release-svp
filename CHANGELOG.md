# Changelog

## v0.2.0 (2026-11-23)

### Features

- Add dart support ([#26](https://github.com/johanflint/release-svp/pull/26))

### Bug Fixes

- Handle Dart build numbers for first release and existing projects ([#27](https://github.com/johanflint/release-svp/pull/27))
- Include the whole pre-release train when graduating to a stable release ([#25](https://github.com/johanflint/release-svp/pull/25))
- Ignore non-strict SemVer tags in `parseVersionTag` ([#23](https://github.com/johanflint/release-svp/pull/23))
- Fix incorrect version bump prioritization ([#22](https://github.com/johanflint/release-svp/pull/22))

### Build System

- Fix release workflow npx resolution ([#20](https://github.com/johanflint/release-svp/pull/20))
- Staged publishing to npm ([#19](https://github.com/johanflint/release-svp/pull/19))

### Continuous Integration

- Publish pre-release versions under their own npm dist-tag ([#24](https://github.com/johanflint/release-svp/pull/24))

## v0.1.0 (2026-09-11)

### Features

- Node strategy ([#15](https://github.com/johanflint/release-svp/pull/15))
- Fail loudly when `migration.legacyAnchorTag` is unusable ([#13](https://github.com/johanflint/release-svp/pull/13))
- Support pre-releases ([#12](https://github.com/johanflint/release-svp/pull/12))
- Cache paginated GraphQL results for tags and merge commits ([#9](https://github.com/johanflint/release-svp/pull/9))
- Improved monorepo support with groups ([#8](https://github.com/johanflint/release-svp/pull/8))
- Remove 100 tags/files limit ([#7](https://github.com/johanflint/release-svp/pull/7))
- Monorepo support ([#6](https://github.com/johanflint/release-svp/pull/6))
- Add command to perform a release ([#3](https://github.com/johanflint/release-svp/pull/3))
- Support rust ([#2](https://github.com/johanflint/release-svp/pull/2))
- Prepare release ([#1](https://github.com/johanflint/release-svp/pull/1))

### Bug Fixes

- Determine releases reliably ([#11](https://github.com/johanflint/release-svp/pull/11))

### Code Refactoring

- Add manifest ([#5](https://github.com/johanflint/release-svp/pull/5))

### Tests

- Integration tests ([#10](https://github.com/johanflint/release-svp/pull/10))
- Improve test coverage ([#4](https://github.com/johanflint/release-svp/pull/4))

### Build System

- Add a release pipeline ([#16](https://github.com/johanflint/release-svp/pull/16))
- Configure for release ([#14](https://github.com/johanflint/release-svp/pull/14))

### Other

- Fix the release pipeline ([#17](https://github.com/johanflint/release-svp/pull/17))
