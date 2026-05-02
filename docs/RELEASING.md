# Releasing FrameComment

This document describes how a new version of FrameComment is cut, published
to Docker Hub and GitHub Releases, and propagated to the TrueNAS catalog.

The flow is fully automated by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
once you push a SemVer tag.

## Versioning policy

FrameComment uses [Semantic Versioning 2.0.0](https://semver.org/):

| Bump | When | Examples |
|------|------|----------|
| `patch` (`1.0.0 → 1.0.1`) | Bug fixes, no behavioural change for users | Crash fix, typo, dependency security patch |
| `minor` (`1.0.0 → 1.1.0`) | Backward-compatible new features | New setting, new export format, new translation |
| `major` (`1.0.0 → 2.0.0`) | Backward-incompatible changes | DB schema requires manual migration, env vars renamed |
| pre-release suffix (`-alpha.1`, `-rc.1`) | Testing before a real release | `1.1.0-rc.1` |

Pre-release tags (anything containing `-`) skip the `:latest` Docker tag
and are marked as **pre-release** on GitHub.

## Repository setup (one-time)

The release workflow needs two GitHub Actions secrets configured under
**Settings → Secrets and variables → Actions** in your GitHub repository:

| Secret | Value |
|--------|-------|
| `DOCKERHUB_USERNAME` | `dragosonisei` |
| `DOCKERHUB_TOKEN` | A Docker Hub *Personal Access Token* with **Read & Write** scope. Create it at https://hub.docker.com/settings/security. |

That is all. No SSH keys, no GPG keys are required for the basic flow.

## The release flow (copy/paste)

Run these from a clean working tree on `main`. Replace `1.0.1` with the
target version.

### 1. Update the changelog

Open [`CHANGELOG.md`](../CHANGELOG.md) and add a new section above the
previous one:

```markdown
## [1.0.1] - 2026-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Update the link references at the bottom:

```markdown
[Unreleased]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/DragosOnisei/FrameComment/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/DragosOnisei/FrameComment/releases/tag/v1.0.0
```

### 2. Bump the version files

```bash
npm version 1.0.1 --no-git-tag-version
echo "1.0.1" > VERSION
```

`npm version` updates `package.json`. The release workflow validates that
both files match the tag, so they cannot drift.

### 3. Bump the TrueNAS catalog (when applicable)

For every release that should appear in the catalog:

```bash
cp -r truenas-catalog/community/framecomment/1.0.0 \
      truenas-catalog/community/framecomment/1.0.1
# Then update the four spots that mention the version:
#   - 1.0.1/app.yaml          → version, app_version
#   - 1.0.1/ix_values.yaml    → images.app.tag
#   - community/framecomment/app.yaml → latest_version, latest_app_version
#   - catalog.json            → latest_version, latest_app_version, last_update
```

A small helper script is provided as `scripts/bump-catalog.sh` (see the
*Future improvements* note below).

### 4. Commit & tag

```bash
git add CHANGELOG.md package.json VERSION truenas-catalog/ catalog.json
git commit -m "chore(release): v1.0.1"
git tag -a v1.0.1 -m "FrameComment v1.0.1"
git push origin main
git push origin v1.0.1
```

### 5. Watch the workflow

GitHub Actions takes over from there:

1. Verifies that the tag, `package.json`, and `VERSION` agree.
2. Extracts the new section from `CHANGELOG.md` as the release notes.
3. Builds a multi-arch image (`linux/amd64`, `linux/arm64`).
4. Pushes the image to Docker Hub with tags `1.0.1`, `1.0`, `1`,
   and `latest` (only on stable tags).
5. Creates a GitHub Release with the changelog section and the relevant
   compose files attached.

Track progress at:

```
https://github.com/DragosOnisei/FrameComment/actions
```

## What if the workflow fails?

* **Tag mismatch** — the verify step prints which file disagrees with the
  tag. Bump the file, force-update the tag (`git tag -fa v1.0.1`), force-push
  the tag (`git push -f origin v1.0.1`), and the workflow re-runs.
* **Docker Hub auth failure** — re-check `DOCKERHUB_TOKEN` (PATs expire).
* **Multi-arch build failure** — usually a flaky base image; re-run the
  failed job from the Actions tab.

## Hotfix flow

For a quick patch:

```bash
git switch -c hotfix/1.0.2 v1.0.1
# ...fix and test...
# Update CHANGELOG, bump version files, bump catalog, commit
git tag -a v1.0.2 -m "FrameComment v1.0.2"
git push origin hotfix/1.0.2
git push origin v1.0.2
# Open a PR back to main once shipped
```

## Future improvements (planned for 1.1.x)

- `scripts/bump-catalog.sh` to automate the catalog version copy.
- Auto-generated release notes from Conventional Commits.
- A nightly workflow that publishes `:edge` images from `main`.
- Submission of the catalog to the official TrueNAS apps repository.
