# Ghid de publicare — FrameComment v1.0.0

Acest ghid te duce de la folder-ul local până la o instalare funcțională pe
TrueNAS SCALE, în 4 pași. Toate comenzile sunt copy-paste, în ordinea în
care trebuie rulate.

> Acest fișier este în **limba română** doar pentru tine. Restul proiectului
> este în engleză.

## Înainte să începi

Asigură-te că ai conturile create (toate sunt gratuite):

1. **GitHub** — https://github.com/DragosOnisei
   * Login din browser, ai contul deja.
2. **Docker Hub** — https://hub.docker.com/signup
   * Username **trebuie** să fie `dragosonisei` (e deja folosit în cod).
   * După login, generează un *Personal Access Token* la
     https://hub.docker.com/settings/security:
     * **Description:** `framecomment-github-actions`
     * **Permissions:** `Read & Write`
     * Copiază tokenul — nu îl mai vezi a doua oară.
3. **TrueNAS SCALE 24.10+** ("Electric Eel" sau mai nou) — instalat și
   pornit, cu Apps activate.

## Pasul 1 — Creezi repo-ul gol pe GitHub

1. Mergi la https://github.com/new
2. Setări:
   * **Repository name:** `FrameComment`
   * **Description:** `Self-hosted video review and approval platform.
     Forked from ViTransfer.`
   * **Public** (recomandat — AGPL nu impune asta dar GitHub Releases
     publice sunt mult mai simple).
   * **NU bifa** "Add a README", "Add .gitignore", "Choose a license" —
     le avem deja local.
3. Click **Create repository**.

GitHub îți va arăta o pagină goală cu instrucțiuni. Ignor-o, vezi pasul 2.

## Pasul 2 — Push primul commit

Deschide un terminal (Terminal pe Mac) și rulează:

```bash
cd /Users/dragos/Downloads/FrameComment
git remote add origin https://github.com/DragosOnisei/FrameComment.git
git push -u origin main
```

Dacă te întreabă username/parolă, foloseşte:
* **Username:** `DragosOnisei`
* **Password:** un *Personal Access Token* GitHub (NU parola contului).
  Generează-l la https://github.com/settings/tokens?type=beta cu scope
  `Contents: Read and write` pe repo-ul `FrameComment`.

> Sfat: dacă ai instalat **GitHub CLI** (`brew install gh`), poți face
> `gh auth login` o singură dată și după aia git push merge fără să te
> mai întrebe nimic.

După push, deschide https://github.com/DragosOnisei/FrameComment în
browser — ar trebui să vezi toate fișierele, inclusiv README cu badge-uri.

## Pasul 3 — Configurezi secrets pentru release automat

În GitHub, în repo-ul nou:

1. **Settings** → **Secrets and variables** → **Actions** → **New
   repository secret**.
2. Adaugă două secrets:

   | Name | Value |
   |------|-------|
   | `DOCKERHUB_USERNAME` | `dragosonisei` |
   | `DOCKERHUB_TOKEN` | tokenul de la Docker Hub generat mai sus |

3. Verifică că ambele apar în listă.

Asta e — workflow-ul `release.yml` se va declanșa automat la următorul tag.

## Pasul 4 — Faci primul release v1.0.0

În terminal:

```bash
cd /Users/dragos/Downloads/FrameComment
git tag -a v1.0.0 -m "FrameComment v1.0.0 — initial release"
git push origin v1.0.0
```

Acum mergi la https://github.com/DragosOnisei/FrameComment/actions și
urmărește jobul `Release`. Durează ~10-15 minute (build multi-arch e lent).

La final ar trebui să ai:

* O imagine Docker la https://hub.docker.com/r/dragosonisei/framecomment
  (cu tag-uri `1.0.0`, `1.0`, `1`, `latest`)
* Un release la https://github.com/DragosOnisei/FrameComment/releases/tag/v1.0.0
  cu fișierele compose atașate

## Pasul 5 — Instalezi pe TrueNAS SCALE

Ai două opțiuni. **Opțiunea A** e cea mai rapidă pentru prima rulare.

### Opțiunea A — Custom App via YAML (recomandat acum)

1. Pe TrueNAS SCALE, mergi la **Apps** → **Discover** → **Custom App**.
2. Alege **Install via YAML**.
3. Pe alt tab, deschide
   https://raw.githubusercontent.com/DragosOnisei/FrameComment/main/docker-compose.truenas.yml
   și copiază tot conținutul.
4. Lipeşte în formularul TrueNAS.
5. Înlocuieşte placeholder-ele:
   * `${POSTGRES_PASSWORD}` → o parolă tare (ex: generată cu
     `openssl rand -base64 32`)
   * `${REDIS_PASSWORD}` → la fel
   * `${ENCRYPTION_KEY}` → 32 bytes base64: `openssl rand -base64 32`
   * `${JWT_SECRET}`, `${JWT_REFRESH_SECRET}`, `${SHARE_TOKEN_SECRET}` →
     fiecare 64 bytes: `openssl rand -base64 64`
   * `${ADMIN_EMAIL}` → emailul tău
   * `${ADMIN_PASSWORD}` → parolă inițială (o vei schimba după login)
   * `/mnt/tank/apps/framecomment/...` → calea reală pe pool-ul tău
6. Click **Install**.
7. Așteaptă să devină **Running** (poate dura 5-6 minute prima dată
   pentru worker care face migrarea DB).
8. Deschide `http://<truenas-ip>:4321` și loghează-te cu emailul și
   parola admin.

### Opțiunea B — Custom Catalog (mai elegant)

1. **Apps** → **Discover** → **Manage Catalogs** → **Add Catalog**.
2. Completează:
   * **Catalog Name:** `framecomment`
   * **Repository:** `https://github.com/DragosOnisei/FrameComment`
   * **Preferred Trains:** `community`
   * **Branch:** `main`
   * **Label:** `FrameComment`
3. SCALE va sincroniza catalogul. FrameComment va apărea sub
   **Apps → Discover** în trainul `community`.
4. Click pe el și apoi **Install** — primești un formular cu toate
   setările (admin email, port, storage paths, secrets etc.).

> **Notă pentru opțiunea B:** Catalogul este "starter" — pe v1.0.0 e
> 100% funcțional pentru auto-instalare, dar template-ul Jinja foloseşte
> referințe la helpers iX care încă nu sunt rezolvate complet pentru toate
> cazurile. Dacă întâmpini probleme, foloseşte opțiunea A până în 1.1.x.

## Pasul 6 — Workflow-ul tău pentru viitor

De aici încolo, când vrei să publici o versiune nouă:

1. Modifici codul.
2. Updatezi `CHANGELOG.md` cu noua versiune (vezi
   [docs/RELEASING.md](docs/RELEASING.md) pentru template).
3. `npm version <patch|minor|major>` → bump în `package.json`.
4. `echo "<noua-versiune>" > VERSION`.
5. Commit, tag, push:
   ```bash
   git add .
   git commit -m "chore(release): vX.Y.Z"
   git tag -a vX.Y.Z -m "FrameComment vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
6. GitHub Actions face restul — Docker Hub + GitHub Release.
7. Pe TrueNAS, **Apps → Installed → FrameComment → Update Available**.

## Probleme comune

* **`git push` cere parolă mereu** — instalează GitHub CLI:
  `brew install gh && gh auth login`.
* **Workflow-ul Release eşuează cu "Tag does not match package.json"** —
  ai uitat să rulezi `npm version` înainte de tag. Bumpez fișierele,
  şterge tag-ul (`git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`),
  re-tag.
* **TrueNAS spune că app-ul e Unhealthy** — verifică logs din
  **Apps → Installed → FrameComment → View Logs**. De obicei e fie o
  parolă lipsă, fie un path care nu există pe pool.

## Ce urmează (v1.1.x — împreună)

Tu mi-ai spus că v1.0.0 e MVP-ul. Pentru v1.1.x voi face:

* Scriptul `scripts/bump-catalog.sh` care automatizează pasul TrueNAS.
* Submission la catalogul oficial TrueNAS (truenas/apps).
* Polishare iconuri — un PNG real în loc de SVG (cu un design pe care îl
  agreăm împreună).
* Orice feature/improvements vrei să adăugăm față de upstream.

Spune-mi și pornim direct cu primul update.
