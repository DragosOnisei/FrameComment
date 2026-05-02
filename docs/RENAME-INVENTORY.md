# Inventar redenumire ViTransfer → FrameComment

## Mapping aplicat

| Original | Înlocuire |
|---|---|
| `ViTransfer` (CamelCase) | `FrameComment` |
| `vitransfer` (lowercase) | `framecomment` |
| `VITRANSFER` (UPPER) | `FRAMECOMMENT` |
| `MansiVisuals/ViTransfer` (link GitHub repo) | `DragosOnisei/FrameComment` |
| `MansiVisuals` (autor / org) | `DragosOnisei` |
| `mansivisuals/vitransfer` (Docker repo) | `dragosonisei/framecomment` |
| `mansivisuals` (Docker user) | `dragosonisei` |
| `crypt010/vitransfer` (vechiul Docker repo) | `dragosonisei/framecomment` |
| `crypt010` (vechiul Docker user) | `dragosonisei` |

## Excepții (NU se modifică)

- `LICENSE` — păstrat integral AGPL-3.0 (cerință legală)
- `package-lock.json` — va fi regenerat la `npm install`. Conține referințe la `ko-fi.com/killymxi` care sunt sponsorship pentru un pachet third-party (nu ViTransfer) — neutre, ignorate.
- `previewlut.cube` — fișier binar LUT pentru video, fără text relevant
- Imaginile din `docs/screenshots/` — PNG-uri, nemodificabile la text
- `node_modules/` — exclus la copiere

## Fișiere de redenumit (rename de path)

| Vechi | Nou |
|---|---|
| `quadlet/vitransfer-postgres.container` | `quadlet/framecomment-postgres.container` |
| `quadlet/vitransfer-app.container` | `quadlet/framecomment-app.container` |
| `quadlet/vitransfer-worker.container` | `quadlet/framecomment-worker.container` |
| `quadlet/vitransfer-network.network` | `quadlet/framecomment-network.network` |
| `quadlet/vitransfer-redis.container` | `quadlet/framecomment-redis.container` |

## Ko-fi links MansiVisuals (de șters)

- `https://ko-fi.com/E1E215DBM4` — în README.md (3 instanțe), CHANGELOG (mențiune)

## Statistici


- Fișiere unice cu referințe ViTransfer/MansiVisuals: **82**

## Lista fișierelor afectate

- `.env.example`
- `.github/workflows/README.md`
- `.github/workflows/test-clean-install.yml`
- `.github/workflows/test-dev-clean-install.yml`
- `.github/workflows/test-dev-upgrade.yml`
- `.github/workflows/test-upgrade.yml`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `Dockerfile`
- `INSTALLATION.md`
- `README.md`
- `SECURITY.md`
- `build-multiarch.sh`
- `docker-compose.truenas.yml`
- `docker-compose.unraid.yml`
- `docker-compose.yml`
- `docker-entrypoint.sh`
- `docs/wiki/Admin-Settings.md`
- `docs/wiki/Client-Guide.md`
- `docs/wiki/Configuration.md`
- `docs/wiki/Contributing.md`
- `docs/wiki/Home.md`
- `docs/wiki/Installation.md`
- `docs/wiki/License.md`
- `docs/wiki/Maintenance.md`
- `docs/wiki/Platform-Guides.md`
- `docs/wiki/Security.md`
- `docs/wiki/Translations.md`
- `docs/wiki/Troubleshooting.md`
- `docs/wiki/Usage-Guide.md`
- `package-lock.json`
- `package.json`
- `prisma/migrations/20241023000000_initial_schema/migration.sql`
- `public/manifest.json`
- `public/sw.js`
- `quadlet/QUICKSTART.md`
- `quadlet/README.md`
- `quadlet/configure.sh`
- `quadlet/install.sh`
- `quadlet/setup-directories.sh`
- `quadlet/vitransfer-app.container`
- `quadlet/vitransfer-network.network`
- `quadlet/vitransfer-postgres.container`
- `quadlet/vitransfer-redis.container`
- `quadlet/vitransfer-worker.container`
- `src/app/admin/settings/page.tsx`
- `src/app/api/auth/device/code/route.ts`
- `src/app/api/calendar/feed/route.ts`
- `src/app/api/settings/notifications/[id]/test/route.ts`
- `src/app/forgot-password/page.tsx`
- `src/app/layout.tsx`
- `src/app/login/page.tsx`
- `src/app/not-found.tsx`
- `src/app/reset-password/page.tsx`
- `src/app/share/[token]/SharePageClient.tsx`
- `src/app/share/[token]/not-found.tsx`
- `src/app/unsubscribe/unsubscribe-client.tsx`
- `src/components/AdminHeader.tsx`
- `src/components/AuthProvider.tsx`
- `src/components/KofiWidget.tsx`
- `src/components/LogoMark.tsx`
- `src/components/ShareTutorial.tsx`
- `src/components/settings/WebPushSection.tsx`
- `src/lib/api-client.ts`
- `src/lib/email-templates.ts`
- `src/lib/email.ts`
- `src/lib/encryption.ts`
- `src/lib/ical.ts`
- `src/lib/notifications.ts`
- `src/lib/otp.ts`
- `src/lib/push-notifications.ts`
- `src/lib/settings.ts`
- `src/lib/token-store.ts`
- `src/lib/tus-context.ts`
- `src/lib/upload-cleanup.ts`
- `src/locales/de.json`
- `src/locales/en.json`
- `src/locales/nl.json`
- `src/pages/api/uploads/[[...path]].ts`
- `src/worker/admin-notifications.ts`
- `src/worker/cleanup.ts`
- `src/worker/client-notifications.ts`
