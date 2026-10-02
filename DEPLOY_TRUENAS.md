# FrameComment — deploy automat pe TrueNAS

_Ultima actualizare: 7.17.6 (2 octombrie 2026). Acest fișier este în română, pentru Dragos; restul proiectului este în engleză._

## Cum funcționează

```
cod în GitHub ──tag v7.17.6──▶ GitHub Actions construiește imaginea (~6 min)
        ──▶ Docker Hub: dragosonisei/framecomment:7.17.6, :7.17, :7, :latest
        ──▶ Watchtower (pe TrueNAS, la 5 min) vede că :latest s-a schimbat
        ──▶ trage imaginea nouă, apoi recreează framecomment-app și framecomment-worker
        ──▶ https://framecomment.com/api/health raportează "version": "7.17.6"
```

Nimeni nu mai intră în TrueNAS → Apps → Edit pentru un update. Un release ajunge live
la **6–11 minute** după push: build-ul ~6 minute, plus până la 5 minute până la
următoarea verificare a Watchtower-ului.

## Configurația curentă (pusă pe 2 octombrie 2026)

- **Aplicația TrueNAS `framecomment`** (Custom App, Docker Compose) rulează patru
  containere: `framecomment-app` (portul 4321), `framecomment-worker` (encodare, cu
  `runtime: nvidia`), `framecomment-postgres`, `framecomment-redis`. Datele stau în
  `/mnt/Archive/FrameComment/{uploads,postgres,redis}`.
- App și worker folosesc **`image: dragosonisei/framecomment:latest`**. Până pe
  2 octombrie 2026 aveau tag fix și update-ul se făcea de mână din Edit.
- **Watchtower** este aplicația TrueNAS `watchtower` (container
  `ix-watchtower-watchtower-1`), pusă inițial pentru Frame Manager. Urmărește doar
  containerele numite în `command`:

  ```
  --interval 300 --cleanup ix-frame-manager-frame-manager-1 framecomment-app framecomment-worker
  ```

  **Postgres și Redis nu se adaugă niciodată acolo** — ar fi repornite la fiecare
  imagine nouă de Postgres sau Redis.
- Imaginea FrameComment este **publică pe Docker Hub**, deci Watchtower nu are nevoie
  de autentificare pentru ea. `/root/.docker/config.json` montat în Watchtower este
  pentru GHCR-ul privat al Frame Manager și nu deranjează.
- Migrațiile de bază de date rulează automat la pornirea containerului **app**
  (`docker-entrypoint.sh` → `prisma migrate deploy`), niciodată în worker.
- `GET /api/health` este public, fără cache, și întoarce
  `{ "status": "ok", "ok": true, "name": "framecomment", "version": "7.17.6" }`.

## Fluxul zilnic („hai cu push” / „ship”)

Versiunea trăiește în trei locuri care trebuie să fie identice — `package.json`,
fișierul `VERSION` și secțiunea `## [X.Y.Z]` din `CHANGELOG.md` — pentru că workflow-ul
de release extrage notele din CHANGELOG și **pică** dacă secțiunea lipsește. De aceea
**nu** se folosește `npm version`; bump-ul îl face Claude, împreună cu commit-ul și
tag-ul `vX.Y.Z`.

1. Claude face bump + commit + tag (o versiune pe lot de modificări, PATCH pentru
   corecturi, MINOR pentru funcții noi).
2. Push-ul, în terminal:

   ```bash
   cd ~/Downloads/FrameComment && git push origin main && git push origin v7.17.6
   ```

3. Confirmarea, fără TrueNAS. Build-ul a reușit când apare tag-ul pe Docker Hub:

   ```bash
   curl -s https://hub.docker.com/v2/repositories/dragosonisei/framecomment/tags/7.17.6 | head -c 200
   ```

   Update-ul a ajuns live când health-ul raportează versiunea:

   ```bash
   curl -s https://framecomment.com/api/health
   ```

   Claude poate aștepta în fundal până la ambele și raportează când e live.

Ce se întâmplă pe server în acel moment: Watchtower trage imaginea nouă **înainte**
să oprească ceva, apoi recreează app-ul și worker-ul. Pauza este boot-ul aplicației:
așteptarea Postgres/Redis, migrațiile, pornirea Next — realist **20–40 de secunde**.
Worker-ul repornește și el, deci un encode aflat în lucru se reia de la zero (la fel
ca la update-ul manual de dinainte). Fă release-urile în afara orelor cu upload intens.

## Rollback

În configul aplicației `framecomment` pui un tag fix în loc de `latest`, la **ambele**
imagini (app și worker), de exemplu `dragosonisei/framecomment:7.17.5` — tag-urile de pe
Docker Hub sunt **fără „v”**. Cât timp tag-ul e fix, Watchtower nu mai atinge
containerele; revii la `latest` când vrei din nou update-uri automate.

Prin SSH, fără interfață (înlocuiește `7.17.5` cu versiunea dorită):

```bash
JOB=$(midclt call app.update framecomment "$(midclt call app.config framecomment | python3 -c "import sys,json; c=json.load(sys.stdin); [c['services'][s].__setitem__('image','dragosonisei/framecomment:7.17.5') for s in ('app','worker')]; print(json.dumps({'custom_compose_config': c}))")") && echo "job $JOB" && while true; do S=$(midclt call core.get_jobs "[[\"id\",\"=\",$JOB]]" | python3 -c "import sys,json; j=json.load(sys.stdin)[0]; print(j['state'], (j.get('error') or '')[:300])"); echo "$S"; case "$S" in SUCCESS*|FAILED*|ABORTED*) break;; esac; sleep 5; done
```

Atenție: un update făcut prin TrueNAS (`app.update` sau Edit) **repornește tot
stack-ul**, inclusiv Postgres și Redis (verificat pe 2 octombrie 2026). Datele sunt pe
volume, nu se pierde nimic, dar pauza e mai lungă decât la un update Watchtower.

Dacă o migrație de bază de date a rulat deja în versiunea nouă, versiunea veche
pornește peste schema nouă; migrațiile sunt aditive (`IF NOT EXISTS`, fără
`DROP`), deci în practică merge, dar verifică log-ul aplicației după rollback.

## Depanare

- **Build-ul a picat?** GitHub → Actions → „Release”. Un build picat nu produce tag pe
  Docker Hub, deci `:latest` rămâne pe versiunea veche și nimic nu se schimbă pe
  server. Cauze văzute: `npm audit --audit-level=critical` cu o vulnerabilitate
  critică (7.17.0); lipsa secțiunii `## [X.Y.Z]` din CHANGELOG.
- **Imaginea e pe Docker Hub, dar health-ul arată versiunea veche după 10 minute?**

  ```bash
  docker logs ix-watchtower-watchtower-1 --tail 30
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep framecomment
  ```

  Watchtower scrie la fiecare rundă ce a verificat și ce a actualizat. Dacă nu
  apare nicio rundă, containerul lui nu rulează.
- **Aplicația nu pornește după update?**

  ```bash
  docker logs framecomment-app --tail 50
  docker logs framecomment-worker --tail 50
  ```

  Primele linii arată așteptarea Postgres/Redis și migrațiile. O migrație picată
  oprește pornirea; aplicația nu pornește pe o schemă pe jumătate migrată.
- **Vrei să forțezi verificarea acum, fără să aștepți 5 minute?**

  ```bash
  docker restart ix-watchtower-watchtower-1
  ```

  Watchtower face prima rundă la 5 minute după pornire, deci câștigul e mic; mai
  simplu e să aștepți.

## Ce NU s-a schimbat față de modelul Frame Manager, și de ce

- **Docker Hub, nu GHCR.** Imaginea era deja acolo, publică, cu `:latest` întreținut
  de workflow-ul de release (cu o coadă care ține `:latest` pe ultima versiune chiar
  dacă se trimit mai multe tag-uri odată).
- **Fără `npm version`.** Vezi mai sus: ar sări peste `VERSION` și CHANGELOG, iar
  release-ul ar pica.
- **Fără `output: standalone` sau Dockerfile nou.** Imaginea actuală merge, iar
  worker-ul are oricum nevoie de `node_modules` complet (rulează TypeScript prin tsx);
  câștigul la boot ar fi mic față de risc. Se poate face separat, cu măsurători.
