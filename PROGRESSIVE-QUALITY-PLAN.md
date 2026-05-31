# Progressive Quality + Adaptive Streaming — Implementation Plan

> Target: YouTube/Netflix-style experience. Thumbnail apparet instant
> după upload, videoul devine vizionabil la 720p în ~1 minut, apoi se
> auto-upgrade la 1080p/2160p MID-PLAYBACK fără hiccup vizibil, dar
> doar dacă user-ul e pe AUTO mode (alegerea manuală e respectată).

## Tl;DR

Sunt **4-6 săptămâni** de muncă concentrată. Trebuie făcut etapizat,
fiecare fază livrează valoare:

| Faza | Ce | Timp | User Impact |
|---|---|---|---|
| **0** | Schema + worker reorder | 2-3 zile | (nothing user-visible) |
| **1** | Thumbnail instant + 720p-first | 4-5 zile | Vezi 720p la 1-2 min după upload |
| **2** | HLS pipeline + manifest server | 5-7 zile | Audio + video streaming chunked |
| **3** | hls.js client integration | 5-7 zile | Player switch la HLS |
| **4** | Progressive variant addition | 4-5 zile | Auto-upgrade mid-playback |
| **5** | AUTO/manual quality respect | 2-3 zile | Polish + testing |

**Total: ~25-35 zile-om.**

## De ce e atât de mult

Build-ul actual al FrameComment folosește **progressive MP4** (un
fișier MP4 per calitate, descărcat byte-range). Pentru "YouTube
imperceptibil seamless" e nevoie de **HLS adaptive streaming**, care
e o arhitectură fundamental diferită:

- **Server:** FFmpeg trebuie să scoată segmente `.ts` (5-10 secunde
  fiecare) + un manifest `.m3u8` care listează toate variantele
  disponibile.
- **Client:** browser-ele Safari pot reda HLS native; Chrome/Firefox
  au nevoie de `hls.js` (~200 KB bundle) care implementează
  MediaSource Extensions și gestionează switch-ul de variante.
- **Storage:** mai multe fișiere mici în loc de unul mare (per
  calitate × ~10s = ~100-300 segmente per video de 5 min).
- **API:** endpoint nou care servește manifest-ul dinamic (ca să
  putem adăuga variante noi pe măsură ce procesarea continuă).

## Faza 0 — Schema + worker reorder (2-3 zile)

Modificări minimale ca să pregătesc terenul:

1. Add la `Video` model:
   - `hlsManifestPath String?` — URL la playlist master
   - `qualityLevelsReady String[]` — array tip `["720p", "1080p"]`
   - `instantThumbnailPath String?` — thumbnail extras în upload route
2. Migration Prisma cu valori default NULL ca să nu rupă videos
   existente.
3. Worker primește un câmp nou care indică **ordinea de procesare**:
   720p → 1080p → 2160p (în loc de orice ordine actuală).
4. Status change: `READY` se setează când 720p e gata, nu când TOATE
   sunt gata. Câmp nou `processingProgress` deja există, doar reuse.

**Niciun impact vizibil pentru user încă** — pregătire pentru fazele
următoare.

## Faza 1 — Thumbnail instant + 720p-first (4-5 zile)

### A. Thumbnail în upload route

În handler-ul TUS `/api/uploads` (la `onUploadFinish`):
- Spawn FFmpeg sincron care extrage frame 0 → JPEG mic (~50 KB)
- Salvează la `instantThumbnailPath` ÎNAINTE de a enqueue
  transcoding job-ul
- Total adăugat: 2-5 secunde pe upload finish (acceptabil)
- Folder UI imediat afișează thumbnail-ul instant (folosește
  `instantThumbnailPath` dacă există, altfel `thumbnailPath` final
  care vine de la worker)

### B. Worker: 720p prioritized + status flip early

- Reorganizat pipeline-ul: 720p → 1080p → 2160p (în loc de orice
  ordine actuală)
- După ce 720p e gata: `status = READY`, `qualityLevelsReady = ["720p"]`,
  dispatch event/SSE
- Continuă procesarea 1080p, 2160p în background ca DUPĂ stories,
  fiecare update-ează `qualityLevelsReady`

### C. UI changes minimal

- Folder + share page detectează `status = READY` și permit
  playback chiar dacă procesarea continuă
- Mic indicator vizual "HD processing — 1080p available soon..."

**User impact:** după 1-2 min vezi videoul la 720p în loc de a
aștepta 10+ min pentru full 2160p.

## Faza 2 — HLS pipeline (5-7 zile)

### Server-side

FFmpeg trebuie să scoată HLS în loc de (sau pe lângă) MP4:

```bash
ffmpeg -i input.mp4 \
  -map 0:v -map 0:a \
  -c:v libx264 -c:a aac \
  -b:v:0 1500k -s:v:0 1280x720  \
  -b:v:1 3000k -s:v:1 1920x1080 \
  -b:v:2 6000k -s:v:2 3840x2160 \
  -var_stream_map "v:0,a:0 v:1,a:0 v:2,a:0" \
  -hls_segment_filename "out_%v/segment_%03d.ts" \
  -hls_time 6 -hls_playlist_type vod \
  out_%v/playlist.m3u8
```

Plus master `playlist.m3u8` care listează toate variantele.

### Decision points

- **Segment time:** 6 secunde standard pentru VOD. Mai mic = switch
  mai granular dar mai multe HTTP requests.
- **Codec:** H.264 universal (compatibil cu Safari + hls.js). HEVC
  doar dacă vrei premium quality pentru clienții care plătesc, dar
  add încă o variabilă.
- **Audio:** o singură pistă AAC, share-uită între toate variantele
  video.

### Storage layout

```
/uploads/videos/<videoId>/
  ├── master.m3u8        # listează cele 3 variante
  ├── 720p/
  │   ├── playlist.m3u8
  │   ├── seg_000.ts
  │   └── seg_001.ts ...
  ├── 1080p/...
  └── 2160p/...
```

### API endpoint

`GET /api/videos/:id/stream/master.m3u8` care:
- Verifică auth (admin sau share token)
- Generează DINAMIC manifest-ul listând doar variantele cu
  `qualityLevelsReady` (deci la t=0 doar 720p, la t=2min are și 1080p)
- Cache 5-10 secunde pentru a permite mid-playback refresh

Segmentele se servesc cu `.ts` Content-Type via similar endpoint cu
signed URL pe S3 sau direct de pe TrueNAS.

## Faza 3 — hls.js client (5-7 zile)

### Player

Înlocuiește/extends `VideoPlayer.tsx`:
- Detectează dacă browser-ul suportă HLS native (Safari): folosește
  direct `<video src={manifestUrl}>`
- Altfel: lazy-load `hls.js` și atașează manifest-ul:
  ```tsx
  if (Hls.isSupported()) {
    const hls = new Hls({
      // critical config for live manifest updates:
      manifestLoadingMaxRetry: Infinity,
      levelLoadingMaxRetry: Infinity,
    })
    hls.loadSource(manifestUrl)
    hls.attachMedia(videoElement)
  }
  ```
- Manage events: `Hls.Events.LEVEL_SWITCHED`, `MANIFEST_LOADED`,
  `LEVEL_LOADED`, etc.

### Comparison/quality menu

UI pentru quality picker existent (de pe `PlayerSettingsMenu`):
- AUTO (default) — hls.js alege automat bazat pe bandwidth
- 2160p / 1080p / 720p — set manual via `hls.currentLevel = N`
- Disable levels not yet în `qualityLevelsReady`

## Faza 4 — Progressive variant addition (4-5 zile)

Asta e partea complicată — adăugarea de variante NOI în timp ce
videoul joacă.

### Strategie

1. Client poll-uiește manifest-ul la fiecare 30 sec (sau onTimeUpdate
   throttled) pentru a vedea dacă au apărut variante noi.
2. Când server returnează un manifest cu mai multe variante decât
   anterior, hls.js suportă reload via `hls.loadSource(url)` SAU
   `hls.swapAudioCodec()`.
3. Pentru a păstra `currentTime` + `playing state`:
   ```tsx
   const time = video.currentTime
   const wasPlaying = !video.paused
   hls.loadSource(newManifest)
   hls.once(Hls.Events.LEVEL_LOADED, () => {
     video.currentTime = time
     if (wasPlaying) video.play()
   })
   ```
4. **AUTO mode:** dacă noua variantă e mai mare decât current level,
   set `hls.currentLevel = -1` (auto) și lasă-l să aleagă upgraded.
5. **Manual mode:** dacă user-ul a ales 720p manual, NU schimba
   nivelul automat. Doar update UI-ul să arate că 1080p e disponibil
   acum (poate da el click).

### Buffer hiccup mitigation

Pentru a face switch-ul "imperceptibil":
- Trigger update doar la **boundaries de segment** (~6 sec)
- hls.js are `lowLatencyMode` care permite mid-segment switching
- Pre-buffer next segment în noua calitate înainte de switch
- Realistic: 100-500 ms freeze, dacă bandwidth e bun → invizibil
- Dacă bandwidth e slab: ~1 sec buffer indicator scurt

## Faza 5 — AUTO vs manual quality respect (2-3 zile)

- State pe video player: `selectedQualityMode: 'auto' | '720p' | '1080p' | '2160p'`
- Default AUTO (cu localStorage persistence)
- AUTO: hls.js alege automat + face auto-upgrade când variante noi
- Manual: user-ul a ales 720p → nu se schimbă chiar dacă apar 1080p
- Quality menu visual: AUTO arată curent level + (auto) badge

## Riscuri și consideratii

### Tehnice
- **Storage doubling:** HLS dublează (sau triplează) storage-ul (MP4
  + segmente HLS). Trebuie decis dacă păstrăm și MP4 originale sau
  ștergem după HLS gata.
- **TrueNAS Docker constraints:** worker-ul HLS poate fi greu pe
  CPU. Trebuie verificat că nu se blochează alte processing-uri.
- **iOS Safari quirks:** are propriul player HLS care nu expune
  detalii (level switching, etc.). Trebuie design care funcționează
  fără API access fin.

### UX
- **Manifestul "live"** (cu variante adăugate progresiv) e mai
  costisitor server-side. Cache aggressive (5-10s) e critic.
- **User confusion:** dacă vede 720p timp de 1 min apoi devine
  1080p, ar putea crede că e un bug. Optional: mic indicator
  "Upgrading quality..." 1 sec.

### Migration
- **Videos existente** (procesate cu pipeline vechi) NU au HLS.
  Trebuie scripted re-processing job pentru a converti existing
  rows, sau backward-compat să servim MP4 pentru cele vechi.

## Recomandare

**Mergi pe faze 0 + 1 acum (1-2 săptămâni), apoi evaluează.**

Beneficiile imediate:
- Thumbnail instant — masive UX win, low effort
- 720p ready ASAP — videos vizionabile mult mai repede

Și **abia după ce vezi cum se simte 720p-first**, decizi dacă chiar
mai e nevoie de HLS full. Multe instalări de FrameComment vor fi OK
cu 720p first + upgrade după refresh manual (Faza 1) și nu vor avea
nevoie de complexitatea HLS.

Dacă DUPĂ Faza 1 încă vrei "true seamless YouTube" — Fazele 2-5
sunt 3-4 săptămâni adițional.

## Next steps

Spune-mi pe care vrei să mergem:

1. **Doar Faza 0+1** (thumbnail instant + 720p-first) — ~1-2 săptămâni
2. **Faze 0-3** (HLS full pipeline + client) — ~3-4 săptămâni
3. **Tot** (incluzând progressive mid-playback) — ~4-6 săptămâni
4. **Discuții suplimentare** înainte de a începe

Recomand opțiunea 1 ca prim pas — vezi rapid valoarea și decizi
informat dacă mai e nevoie de complexitate.
