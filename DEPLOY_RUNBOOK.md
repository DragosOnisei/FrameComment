# FrameComment — Runbook deploy & performanță (TrueNAS)

_Ultima actualizare: 3.8.3_

## 1. Ce s-a schimbat în 3.8.3 (cod)
- Preview de scrub pe timeline (cadru din sprite storyboard, cadrul cel mai apropiat de poziție).
- Onboarding client stilizat (dark glass) + săgeți animate la pași.
- Fix redirect „seamless" pe link-uri de share (mint access token din refresh token persistat).
- Cap Auto pe device: 720p pe telefon / 1080p pe ecrane mari (HLS + MP4, inclusiv guest, 4K manual).
- Share modal instant + fără flash de link lung + request-uri paralele la per-video.
- **Fix auth 401 storm:** un singur refresh partajat (apiFetch + AuthProvider + share-auth) → gata cu revocarea în masă a token-urilor.
- **Performanță:** cache-uri pe rutele de conținut/HLS (video+project, getConfiguredLocale) → mult mai puține query-uri DB per range-request la load/seek.

> Notă: după acest update, dacă apar cereri de reautentificare, fă **un login o dată** (sesiunile vechi puteau fi „arse" de bug-ul de refresh).

## 2. Setări ZFS de performanță (aplicate)
Cauza lentorii la deploy/DB era **scrierile mici sincrone pe HDD** (pool `Archive`, RAIDZ1). Dovadă (test `dd`, 4k sync):

| Pool | Discuri | Topologie | Sync 4k |
|---|---|---|---|
| Archive | 6× HDD | RAIDZ1 | **76.6 kB/s** |
| Windows | 1× HDD | single | 128 kB/s |
| Wordpress | 4× Silicon Power A55 | RAIDZ1 | 760 kB/s |
| Nextcloud | 2× Samsung 870 EVO | MIRROR | 4.1 MB/s |
| PLEX | 2× WD Elements USB | MIRROR | 15.6 MB/s* |

\* PLEX pare rapid pentru că enclosure-urile USB **ignoră comenzile de flush** → NU e sigur pentru DB (risc de corupere). De evitat pentru date importante.

**Fix aplicat** (`sync=disabled` — scrieri async, absorbite în RAM, flush în fundal):
```bash
zfs set sync=disabled Archive/ix-apps/docker        # pornire containere / deploy (toate app-urile)
zfs set sync=disabled Archive/FrameComment          # părinte
zfs set sync=disabled Archive/FrameComment/postgres # baza de date
zfs set sync=disabled Archive/FrameComment/redis    # cache
# Archive/FrameComment/uploads era deja disabled (videoclipurile)
```
Rezultat: postgres a sărit de la 76.6 kB/s la **257 MB/s**; deploy de la **~40 min → ~40 sec**.

Verificare:
```bash
zfs get -o name,value sync Archive/ix-apps/docker Archive/FrameComment Archive/FrameComment/postgres Archive/FrameComment/redis Archive/FrameComment/uploads
```

**Compromis:** la pană bruscă de curent (fără shutdown ordonat) se pot pierde ultimele ~5 secunde de scrieri. FĂRĂ corupere de pool (ZFS rămâne consistent). Cu UPS care face shutdown curat → risc practic nul.

Ca să revii (dacă vrei durabilitate maximă): `zfs set sync=standard <dataset>`.

## 3. Test de viteză a discului (oricând, sigur — scrie 16MB și șterge)
```bash
dd if=/dev/urandom of=/mnt/<POOL>/.perftest.tmp bs=4k count=4000 oflag=dsync 2>&1; rm -f /mnt/<POOL>/.perftest.tmp
```

## 4. Recuperare dacă un deploy se BLOCHEAZĂ (ex. „app.update 70%")
Toate comenzile în Shell TrueNAS (System Settings → Shell) sau SSH.

1. **Vezi ce e blocat:**
   ```bash
   docker ps -a | grep -i frame
   midclt call core.get_jobs '[["state","=","RUNNING"]]' | python3 -c "import sys,json;[print(j['id'],j['method'],j.get('progress',{}).get('percent')) for j in json.load(sys.stdin)]"
   ```
2. **Oprește jobul blocat** (înlocuiește `<ID>`):
   ```bash
   midclt call core.job_abort <ID>
   ```
3. **Șterge containerele vechi rămase** (datele sunt în volume, NU se pierd):
   ```bash
   docker ps -a --format '{{.Names}} {{.ID}}' | grep -i framecomment
   docker rm -f <ID1> <ID2> ...   # sau: framecomment-app framecomment-worker framecomment-postgres framecomment-redis
   ```
4. **Repornește din UI** (Apps → framecomment → sau re-Save). Cu `sync=disabled` ar trebui să meargă rapid acum.
   - Fallback manual: `midclt call -job app.start framecomment`
   - Sau pornire directă: `docker start framecomment-postgres framecomment-redis && docker start framecomment-app framecomment-worker`
5. **Verifică:**
   ```bash
   docker ps --format '{{.Names}} | {{.Status}} | {{.Image}}' | grep -i framecomment
   ```

## 5. Curățare imagini vechi (eliberezi spațiu; NU atinge video/date)
Păstrează ultimele câteva versiuni, șterge restul:
```bash
docker images 'dragosonisei/framecomment' --format '{{.Repository}}:{{.Tag}}' | grep -vE ':(3\.8\.3|3\.8\.2|3\.8\.1)$' | xargs -r -n1 docker rmi
```
Sigur pentru date: `docker rmi` atinge doar imagini. **Nu rula NICIODATĂ `docker volume prune`** (ar putea atinge date).

## 6. Îmbunătățiri viitoare (opțional)
- **Mutare DB + docker pe SSD (Nextcloud, mirror):** ~54× față de HDD, cu durabilitate păstrată (sync standard). De planificat cu backup înainte; videoclipurile rămân pe Archive.
- **SLOG SSD (cu PLP) pe Archive:** accelerează toate scrierile sincrone fără mutări; necesită hardware.
