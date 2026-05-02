# Fork diff — what changed in FrameComment relative to ViTransfer 1.0.2

This document accompanies the [`NOTICE`](../NOTICE) and [`CHANGELOG.md`](../CHANGELOG.md)
files and provides transparency about the modifications introduced when
forking [ViTransfer 1.0.2](https://github.com/MansiVisuals/ViTransfer)
into FrameComment 1.0.0 on **2026-05-02**.

In keeping with the spirit of AGPL-3.0 (sections 5 and 7), this fork makes
no attempt to obscure its provenance.

## Summary

FrameComment 1.0.0 = ViTransfer 1.0.2 with:

1. A project-wide rename and rebrand (no functional changes).
2. The upstream donation flow removed and replaced with a discreet
   attribution link.
3. New release tooling and a TrueNAS SCALE catalog skeleton.
4. A reset version number (`1.0.0`) and a new changelog tracking only
   FrameComment changes from this point forward.

The application schema, HTTP API, environment variables, and on-disk file
layout are otherwise identical to upstream.

## 1. Project rename

| Token | Before | After | Affected files |
|-------|--------|-------|----------------|
| Display name (CamelCase) | `ViTransfer` | `FrameComment` | UI strings, README, docs, manifest, About dialog |
| Lowercase identifier | `vitransfer` | `framecomment` | npm package, container names, network names, env vars |
| Upper-case (none used in 1.0.2) | `VITRANSFER` | `FRAMECOMMENT` | (no occurrences in source) |
| Docker repo | `mansivisuals/vitransfer`, `crypt010/vitransfer` | `dragosonisei/framecomment` | `docker-compose.*.yml`, `Dockerfile`, docs, build scripts |
| GitHub repo | `MansiVisuals/ViTransfer` | `DragosOnisei/FrameComment` | README, CHANGELOG, docs, in-app links |
| Author / org | `MansiVisuals` | `DragosOnisei` | `package.json`, attribution, docs |
| Quadlet unit files | `vitransfer-*.{container,network}` | `framecomment-*.{container,network}` | `quadlet/` |

A full inventory of the files that contained any of the above tokens is in
[`docs/RENAME-INVENTORY.md`](./RENAME-INVENTORY.md). The rename was applied
mechanically with `sed`, in this order, against every text file in the
project except `LICENSE`, `package-lock.json`, `previewlut.cube`, and image
assets:

1. `MansiVisuals/ViTransfer` → `DragosOnisei/FrameComment`
2. `mansivisuals/vitransfer` → `dragosonisei/framecomment`
3. `crypt010/vitransfer`     → `dragosonisei/framecomment`
4. `ViTransfer`              → `FrameComment`
5. `VITRANSFER`              → `FRAMECOMMENT`
6. `vitransfer`              → `framecomment`
7. `MansiVisuals`            → `DragosOnisei`
8. `mansivisuals`            → `dragosonisei`
9. `crypt010`                → `dragosonisei`

`LICENSE` is preserved byte-for-byte. `package-lock.json` will be
regenerated on `npm install` and contains transitive sponsor links to
unrelated upstream packages (e.g. `killymxi`) that are *not* modified.

## 2. Donation flow removed

The upstream `KofiWidget.tsx` component, its trigger button in the
`AdminHeader`, and the matching CSP entries in `proxy.ts` have been removed.
The PWA no longer connects to `ko-fi.com` for any purpose.

In its place, the *About* dialog now shows a single line:

> Based on **ViTransfer** by MansiVisuals, licensed under AGPL-3.0.

Removed files:

- `src/components/KofiWidget.tsx`

Removed code blocks:

- `KofiWidget` import and `<KofiWidget />` mount in `src/app/admin/layout.tsx`.
- "Support FrameComment" Ko-fi button in `src/components/AdminHeader.tsx`.
- `https://ko-fi.com` entries in CSP `connect-src`, `img-src`, and
  `frame-src` in `src/proxy.ts`.
- `nav.supportFrameComment` translation keys in `src/locales/{en,nl,de}.json`.

## 3. Attribution & legal

- [`LICENSE`](../LICENSE) — AGPL-3.0-only, preserved unchanged.
- [`NOTICE`](../NOTICE) — new, documenting upstream attribution and the
  AGPL-3.0 obligations under section 5 (modified-program notices).
- [`README.md`](../README.md) — gained a *Credits & Attribution* section
  pointing to ViTransfer/MansiVisuals.
- *About* dialog in the running app — discreet upstream link with the
  AGPL-3.0 mention.

## 4. New tooling

- [`.github/workflows/release.yml`](../.github/workflows/release.yml) —
  builds multi-arch Docker images on tag push, publishes to Docker Hub, and
  creates a GitHub Release with the changelog section attached.
- [`docs/RELEASING.md`](./RELEASING.md) — documents the SemVer flow.
- [`truenas-catalog/`](../truenas-catalog/) — starting skeleton for a custom
  TrueNAS SCALE Apps catalog (Electric Eel format), with `app.yaml`,
  `questions.yaml`, `ix_values.yaml`, and a templated `docker-compose.yaml`.

## 5. Version reset

- [`package.json`](../package.json) — `version` reset from `1.0.2` to `1.0.0`,
  plus new `description`, `author`, `license`, `homepage`, `repository`, and
  `bugs` fields.
- [`VERSION`](../VERSION) — reset to `1.0.0`.
- [`CHANGELOG.md`](../CHANGELOG.md) — replaced with a fresh changelog whose
  oldest entry is FrameComment 1.0.0; the upstream history is preserved as
  [`CHANGELOG-upstream-history.md`](../CHANGELOG-upstream-history.md).

## What did **not** change

To be explicit:

- The Prisma schema and database migrations are byte-identical to upstream
  except for the rename pass over comments and the `migration_lock.toml`.
- All HTTP API routes and request/response shapes are unchanged.
- The environment variables consumed by the application are unchanged in
  name and meaning.
- The runtime feature set (uploads, comments, approvals, sharing, S3, push,
  email, calendar feeds, WebAuthn, etc.) is identical.

If you spot a difference that is not listed here, please open an issue —
that is a documentation bug we want to fix.
