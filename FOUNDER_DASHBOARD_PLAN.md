# Founder Dashboard — plan pe faze

Zona de **Founder** (Dashboard / CRM / AI Agents) pentru proprietarul platformei
FrameComment. Complet separată de aplicația pe care o folosesc companiile.

**Data:** 6 august 2026 · **Versiune de start:** 6.1.1 · **Versiuni țintă:** 6.2.x

---

## Decizii stabilite

| Subiect | Decizie |
|---|---|
| Cont | **Cont separat de fondator** (ex. `dragos@mindqub.eu`). Login → redirect automat în zona Founder. |
| CPC MARKETING | **Client normal**, ca orice alt tenant. Intră în metrici ca un client. |
| Dashboard Faza 1 | Schelet **cu date reale** din ce există deja în baza de date. |
| CRM | **Tabele noi în FrameComment** (self-hosted, datele rămân la tine). |
| AI Agents | Registru + rulare manuală întâi; programarea 24/7 în faza următoare. |
| Prioritate după schelet | **Dashboard cu date reale + export PDF**. |

## Reguli de lucru (permanente)

1. Fiecare fază se testează **local** (`npx prisma migrate deploy` + `npx prisma generate` + restart dev), cu listă de teste numerotate.
2. Push spre online **numai** după ce confirmi că faza e OK și că nimic din aplicație nu s-a schimbat.
3. Nicio fază nu modifică fluxurile existente: proiecte, upload, player, comentarii, share, facturare.
4. Fiecare fază: `tsc` curat + `eslint` pe fișierele atinse + un singur bloc git de copiat.

---

## Constatare importantă: „platformă" înseamnă acum CPC MARKETING

Astăzi privilegiile de platformă sunt legate hardcodat de `org-1`, care **este**
CPC MARKETING:

| Loc | Ce face |
|---|---|
| `src/lib/danger-zone.ts` → `isPlatformOrgContext()` | `currentOrgId() === 'org-1'` |
| `src/app/api/platform/access-links/route.ts` | Access link doar pentru OWNER-ul din `org-1` |
| `src/app/api/auth/session/route.ts` | `isPlatformOrg` → UI-ul ascunde secțiuni pentru tenanți |
| `src/app/api/early-access/route.ts` | cererile de acces merg la OWNER-ul din `org-1` |
| `src/app/api/settings/*`, `src/lib/storage-backends.ts` | comportamente speciale pentru `org-1` |

Ca CPC să devină client normal, identitatea de platformă trebuie mutată pe o
organizație proprie. **Atenție la o nuanță:** `currentOrgId()` are un fallback pe
`'org-1'` care ține de rândul legacy de `Settings` (`id: 'default'`), nu de
privilegii — acela **nu** se atinge, altfel se rup setările existente.

### Consecință de acceptat

CPC MARKETING, devenind tenant normal, **pierde**: butonul Access link și
secțiunile platform-only din Settings (Branding, Privacy, Security, Blocklist).
Toate se mută în zona Founder, unde le și e locul. Dacă vrei ca CPC să le
păstreze, se poate printr-un flag separat — spune-mi înainte de Faza 0.

---

## Faza 0 — Identitate de platformă (fundația, fără UI nou)

**Obiectiv:** un cont de fondator care nu depinde de CPC MARKETING.

1. `Organization.isPlatform Boolean @default(false)` + migrare care creează
   organizația de platformă (`FrameComment`, `isPlatform: true`) și lasă `org-1`
   (CPC MARKETING) ca tenant normal.
2. `src/lib/platform.ts`: `platformOrgId()`, `isPlatformAdmin(user)`,
   `requirePlatformAdmin(request)` — un singur gate, folosit de tot ce e Founder.
3. Înlocuiesc verificările de **privilegii** `=== 'org-1'` cu noul gate
   (fallback-urile de settings rămân neatinse).
4. Script `npm run founder:create` — creează contul de fondator în organizația de
   platformă (email + parolă, hash cu mecanismul existent, rol OWNER).
5. Login: dacă utilizatorul e platform admin → `/founder`; altfel exact ca acum.
6. Worker: facturarea și ștergerea de organizații **exclud** organizația de
   platformă (nu se autofacturează, nu poate fi ștearsă din greșeală).

**Riscuri:** atingem `session`, `login`, `danger-zone`, `access-links`,
`early-access`. Toate au teste dedicate mai jos.

**Teste:**
1. Login cu contul CPC → aterizezi ca acum în proiecte; totul funcționează (upload, player, comentarii, share).
2. Settings la CPC → secțiunile platform-only nu mai apar (comportament de tenant, așteptat).
3. Login cu contul de fondator → ajungi pe `/founder` (pagină goală în această fază).
4. `/request-access` de pe landing → notificarea ajunge la contul de fondator, nu la CPC.
5. Un tenant obișnuit (compania de test) → zero schimbări.
6. Facturarea rulată manual în worker → organizația de platformă nu apare în lista de facturat.

---

## Faza 1 — Scheletul zonei Founder

**Obiectiv:** structura completă, navigabilă, fără date inventate.

- `src/app/founder/layout.tsx` — gate server-side, redirect dacă nu ești platform admin.
- Sidebar propriu: **Dashboard** (default), **CRM**, **AI Agents**, plus contul jos.
- Trei pagini cu structura de carduri și stări „nu există date încă", în același limbaj vizual (glass, accent, gradient) ca restul aplicației.
- Mut aici **Access link** (invitarea de companii noi) din pagina de Users.
- Zero modificări în `/admin` și în fluxurile de share.

**Teste:**
1. Fondator → `/founder` cu sidebar-ul corect, Dashboard activ implicit.
2. Navigare între cele trei secțiuni; pe telefon sidebar-ul se comportă corect.
3. Un cont de tenant care încearcă `/founder` → redirect, fără scurgere de date.
4. Access link din Founder → creează link, se copiază, apare în istoric.
5. Aplicația normală: nimic schimbat (spot-check pe proiecte + player + share).

---

## Faza 2 — Dashboard cu date reale + export PDF

**Obiectiv:** cifrele pe care le arăți investitorilor, toate din date existente.

- `GET /api/founder/metrics?from&to` (privilegiat, gated):
  - **Companii:** total, active, suspendate, noi în perioadă, churn.
  - **Utilizatori:** total, pe rol, activi în perioadă.
  - **Venit:** facturat pe perioadă + MRR/ARR curent (din `BillingSnapshot` + Stripe), pe companie.
  - **Storage:** total și pe backend, cost estimat.
  - **Activitate:** upload-uri, minute de video, comentarii, share-uri, aprobări.
- Grafice pe perioade + selector de interval (lună, trimestru, custom).
- **Export PDF** pe interval, cu `pdfkit` (deja folosit pentru transcripturi): pagină de titlu, tabele, grafice, notă de generare.

**Teste:** numere verificate manual în baza de date pentru un interval scurt, PDF descărcat și comparat, interval fără date → raport gol corect (nu erori).

**Livrat în 6.5.0** — cu două precizări de onestitate față de planul inițial:

- **Venitul facturat este un prag minim, nu un total.** Local se păstrează doar
  ULTIMA factură per companie (`Settings.lastInvoice*`); nu există tabel de
  istoric. Registrul complet e la Stripe. API-ul și PDF-ul spun asta explicit,
  în loc să afișeze o cifră care pare completă și nu e.
- **Churn nu e calculat.** Nu există o coloană care să înregistreze *când* o
  companie a devenit inactivă, deci orice procent ar fi ghicit. Rămâne pentru
  când adăugăm marcajul de dată la suspendare/ștergere.

Ce e real: MRR la utilizarea curentă (prețul publicat aplicat pe ultimul
`BillingSnapshot`, cu fallback pe măsurare live pentru companiile fără snapshot),
companii totale/active/suspendate/noi/plătitoare, utilizatori, storage stocat vs.
facturabil, activitate (upload-uri, comentarii, aprobări, proiecte) și tabelul pe
companii. Seria zilnică din grafic vine din snapshot-uri, deci se umple în timp.

---

## Faza 3 — CRM

**Tabele noi, platform-level** (fără `organizationId`, accesate doar prin rutele Founder):

- `Lead` — nume, email, companie, profesie, sursă, status (NEW → CONTACTED → QUALIFIED → TRIAL → CUSTOMER / LOST), valoare estimată, note.
- `LeadActivity` — apel, email, demo, notă; cu autor și dată.
- `FollowUp` — lead, scadență, făcut la, notă.

- Cererile din `/request-access` devin automat lead-uri (+ import retroactiv din notificările existente).
- Când un lead se înregistrează prin access link → devine CUSTOMER, legat de organizația creată.
- UI: listă cu filtre + board pe status, detaliu lead cu istoric, follow-up cu memento în clopoțel.

**Livrat în 6.6.0.** Ce s-a făcut exact: cele trei tabele (platform-level, cu
`REVOKE` explicit pentru rolul de tenant — vezi migrarea), import retroactiv
idempotent din notificările `EARLY_ACCESS`, lead automat la fiecare cerere
nouă, conversie automată la înregistrare cu `convertedOrgId` salvat, istoric
cu `STATUS_CHANGE` scris de aplicație, follow-up-uri cu scadență, filtre pe
status + căutare, panou de detaliu.

**Ce NU s-a făcut, și de ce:**

- **Memento-ul de follow-up în clopoțel** nu există încă. `Notification` e un
  tabel de tenant, legat de `recipientId` + RLS; a-l folosi pentru platformă
  ar amesteca exact granițele pe care le-am separat în Faza 0. Follow-up-urile
  scadente se văd în tile-ul „Follow-ups due" din CRM. Un canal de notificare
  la nivel de platformă e o decizie separată.
- **Board-ul pe coloane (drag & drop)** nu s-a făcut; e listă cu filtre pe
  status. Cu volumul de acum, coloanele ar fi ornament.

---

## Faza 4 — AI Agents

**Tabele:** `Agent` (nume, tip, config, cadență, activ), `AgentRun` (start, durată, status, cost), `AgentReport` (titlu, markdown, PDF).

- **4a:** registru + configurare + „Run now" + istoric + rapoarte salvate, folosind cheia OpenAI din Settings.
- **4b:** programare 24/7 pe worker-ul BullMQ existent, cu limite de cost și oprire de urgență.

**Ce pot face agenții, onest:**

- ✅ Rapoarte de business și utilizare, sumarizări de loguri, detectare de anomalii, inventar de dependențe cu CVE-uri cunoscute (`npm audit`), review de configurări (headers, TTL-uri, permisiuni), generare de Incident Response Plan și politici, pregătire de răspunsuri pentru due diligence.
- ❌ **Nu** rulează atacuri sau penetration testing real. Un pentest serios se face de o firmă specializată, iar unelte de exploatare pornite din interiorul aplicației sunt un risc în sine, nu o măsură de securitate. Ce pot face: scope-ul, checklistul, remedierea și documentația pentru un pentest făcut de specialiști.

---

## Faza 5 — Pachet pentru investitori

- Rapoarte PDF lunare/trimestriale generate automat și arhivate.
- Audit log al acțiunilor de platformă (cine, ce, când).
- Uptime și istoric de incidente, security posture, retenție și cohorte.

---

## De rezolvat separat (securitate, azi)

- Parola contului actual a fost scrisă în conversație — schimbă-o.
- `ADMIN_PASSWORD` din env a fost expus anterior — rotește-l la următorul deploy.
- Contul de fondator: parolă lungă, unică, plus MFA când o implementăm.
