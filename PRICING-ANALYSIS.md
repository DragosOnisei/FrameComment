# FrameComment — Market analysis & pricing recommendation

> **Caveat:** prețurile competitorilor de mai jos sunt aproximative pe baza
> info-ului public; Adobe schimbă tier-urile Frame.io de la achiziție.
> Înainte de orice ofertă fermă, verifică rate card-ul lor curent pe
> frame.io/pricing. Toate sumele în USD.

## 1. Ce vinzi de fapt

Înainte de cifre, articulează ce primește clientul:

**Funcționalitate** — paritate aproape completă cu Frame.io pe ce contează
într-o echipă de post-producție: timeline comments (precizie ms), range
selection (yellow OUT handle), voice comments, annotations (linie/săgeată/
rect/culori/undo), version stacking drag-to-stack, foldere cu sharing
(password/OTP/expiration), reactions, edit/delete propriile comment-uri,
hover-scrub + storyboard sprite-sheets, Quick Look pe Space, grid + table
view, search global, drag-and-drop uploads cu TUS resumable, approve/
in-review/archived workflow, trash cu 30-day recovery, WebAuthn passkeys,
mobile responsive, multi-language.

**Argumente diferențiatoare (ce Frame.io NU oferă)**:
- **Data sovereignty** — masters + footage sub NDA stau pe infrastructura
  ta, nu pe servere Adobe. Argument enorm pentru studio-uri cu contracte
  enterprise.
- **Viteza pe LAN** — reviewer-i interni dau play instant pe master de
  20 GB; nu există upload→AWS→download→client.
- **Zero vendor risk** — Adobe a schimbat pricing-ul Frame.io de cel puțin
  3 ori după achiziție. Aici tu controlezi roadmap-ul.
- **Customizare** — fix-uri/feature-uri în zile, nu trimestre.

Astea trei ultime justifică o primă de preț față de Frame.io DACĂ clientul
e enterprise/NDA-driven. Dacă e price-sensitive — atunci undercut Frame.io
cu 30-50%.

## 2. Peisajul competitiv (USD, ce-mi amintesc public)

| Tool | Tier | Preț | Storage |
|---|---|---|---|
| **Frame.io Free** | — | $0 | 5 GB, 2 utilizatori, 2 proiecte |
| **Frame.io Pro** | per-seat | ~$15/user/mo | 250 GB, până la 5 useri |
| **Frame.io Team** | per-seat | ~$25/user/mo | 2 TB shared |
| **Frame.io Enterprise** | per-seat | custom (~$50-100/user/mo) | negociabil |
| **Frame.io overage** | storage | ~$10/TB/mo | — |
| **Wipster Solo** | per-seat | $20/user/mo | 50 GB |
| **Wipster Team** | per-seat | $35/user/mo | 200 GB |
| **Vimeo Review** | flat | $12-50/mo | 1 TB+ |
| **Filestage Basic** | project | $89/mo flat | 10 active projects, unlimited reviewers |
| **Filestage Pro** | project | $249/mo flat | + more projects + integrations |
| **Kollaborate Cloud** | per-seat | $19/user/mo | included |
| **ftrack Review** | per-seat | $40-60/user/mo | bundled cu ftrack Studio |
| **Iconik (Backlight)** | per-seat + storage | $25-100+/user/mo | tier-uri |

**Anchor-ul principal e Frame.io Team la ~$25/user/mo**. Aici se uită
clienții când compară.

## 3. Modele de pricing posibile pentru FrameComment

### A. Per-seat + storage (familiar, ușor de înțeles)

| Tier | Per seat | Storage inclus | Overage |
|---|---|---|---|
| Starter | $12/user/mo | 100 GB / seat | $0.04/GB/mo |
| Pro | $19/user/mo | 250 GB / seat | $0.03/GB/mo |
| Enterprise | $35/user/mo | 1 TB / seat | $0.02/GB/mo |

Sweet spot vs Frame.io: Pro la $19 te poziționează cu **24% sub Frame.io
Team** dar peste tier-ul lor Pro — exact zona "professional but not
cheap."

### B. Project-based (Filestage-style, predictibil pentru CFO)

| Tier | Preț | Active projects | Storage | Reviewers |
|---|---|---|---|---|
| Solo Studio | $99/mo | 3 | 500 GB | unlimited |
| Small Studio | $299/mo | 10 | 2 TB | unlimited |
| Studio | $599/mo | 25 | 5 TB | unlimited |
| Enterprise | custom | unlimited | custom | unlimited |

Avantaj: nu pedepsește clientul când adaugă reviewer-i (toți colegii lor
+ clienții lor finali pot intra fără cost incremental). Bun pentru
agenții/post-production unde sunt MULȚI reviewer-i ocazionali.

### C. Hybrid (recomandat pentru un client unic în Chicago)

**Platform fee + per-seat + storage:**
- Platform fee: $149/mo (acoperă uptime, updates, support, hosting)
- Per seat (admin/editor): $15/user/mo
- Per seat (reviewer-only): $5/user/mo SAU gratis până la 10 reviewers
- Storage: 500 GB inclus, apoi $0.04/GB/mo

Avantajul: minimum prag (recurring revenue garantat), nu pedepsești
echipa pentru reviewer-i externi (avantaj competitiv vs Frame.io care
taxa la fel admin și reviewer).

### D. Setup + retainer (recomandat dacă e primul client)

**One-time setup**: $1,500-3,000
- include configurare, onboarding echipa, custom branding, training
- amortizează costul tău de timp în primele luni

**Monthly retainer**: $299-799/mo
- include hosting, updates, support, până la X seats/storage
- peste limită, model per-seat + storage (model A sau C)

Asta te protejează financiar la primul client (cash în avans) și îți dă
runway să polish-uiești produsul.

## 4. Recomandarea mea pentru clientul din Chicago

Dacă e o agenție de marketing/post-production de dimensiune mică-medie
(5-30 useri activi, lucrează cu clienți finali care comentează):

**Pachet recomandat — Hybrid:**

| Linie | Preț |
|---|---|
| **Setup one-time** | $2,000 |
| **Platform fee** | $199/mo |
| **Editor seats** | $18/user/mo (primii 5 incluși) |
| **Reviewer seats** | gratis până la 20, apoi $5/user/mo |
| **Storage** | 1 TB inclus, apoi $0.03/GB/mo |
| **SLA** | 99.5% uptime, response în 24h, fix critic în 48h |
| **Branding** | custom logo + colors incluse |

**Math pe un caz tipic** (10 editori + 30 reviewer-i + 3 TB folosite):
- $199 platform + 5 editor seats peste cei 5 incluși × $18 = $90 +
  10 reviewer-i peste 20 incluși × $5 = $50 + 2 TB overage × $30/TB = $60
- **Total: $399/mo + $2k setup**

Comparat cu Frame.io Team la $25/user × 10 editori + $25/user × 30
reviewer-i = $1,000/mo (Frame.io taxa la fel reviewer-ii), tu ești la
**40% mai ieftin** și clientul **își păstrează masters-ul în casă**.

## 5. Tactici de pricing

**1. Anchor cu Frame.io explicit.**
Începe conversația cu "ce plătiți acum la Frame.io?" — îi vezi tier-ul,
îți construiești oferta direct sub costul lor actual.

**2. Vinde annual cu discount.**
- Monthly: prețul de mai sus
- Annual (paid upfront): 2 luni gratis (≈ 17% discount)
- Cash flow garantat + lock-in 12 luni.

**3. Free reviewer seats sunt arma ta.**
Frame.io taxa fiecare reviewer ($25/user). Tu îi lași până la 20 gratis.
**Asta e cea mai bună linie din ofertă.** Cineva care invită 50 de
clienți finali la review economisește instant.

**4. Nu negocia platform fee-ul.**
Setup + platform fee sunt non-negociabile (acoperă costuri reale de
timp/infrastructure). Per-seat și storage sunt negociabile dacă-i nevoie.

**5. Adaugă opțiuni premium pe partea de sus.**
- Custom domain ($49/mo): review.clientcompany.com în loc de
  framecomment.yourdomain.com
- Priority support ($199/mo): răspuns în 4h, fix critic în 24h
- Dedicated instance ($999/mo): instanță proprie, nu shared
- Per-project NDA setup ($299/proiect one-time)

Astea cresc ARPU fără să crești complexitatea pentru clienții small.

**6. Romania-side caveat.**
Dacă facturezi din RO către US, ai nevoie de:
- Entity care poate factura în USD (SRL cu cont USD funcționează)
- W-8BEN-E formular (declari că nu ai prezență taxabilă în US)
- Stripe/Wise pentru încasare — Stripe taxa ~2.9% + $0.30/tranzacție
- Atenție la TVA — B2B-ul cross-border în general nu e taxat de tine
  (reverse charge), dar verifică cu contabilul.

## 6. Întrebări de pus clientului ÎNAINTE de ofertă

Înainte să dai un număr fix:

1. **Câți editori activi pe lună?** (cei care încarcă/comentează/aprobă)
2. **Câți reviewer-i ocazionali?** (clienții lor finali care doar comentează)
3. **Cât storage estimează pe trimestru?** (în GB; o agenție medie =
   200-500 GB activ + arhivă)
4. **Câte proiecte active simultan?**
5. **Cer NDA/data residency?** (asta justifică un preț mai mare)
6. **Cer SLA contractual?** (idem)
7. **Cer integrare cu ce folosesc deja?** (Premiere, DaVinci, Slack,
   Asana — fiecare custom integration $$$)
8. **Câți useri vor folosi mobile?** (vinde diferențiator)

Răspunsurile îți construiesc oferta concret.

## 7. Linia de jos

Pentru primul client în Chicago, recomandarea mea:

> **Setup $2,000 + $199/mo platform + $18/editor + storage** este
> defensibil, competitiv față de Frame.io, și îți dă $4-6k/an MRR
> doar pe un client mediu. Negociabil pe per-seat, NU pe platform fee.

Începe cu numărul de sus. Negociază în jos cu 10-15% maximum dacă semnează
anual upfront. NU începe de la prețul-țintă — anchor cu un preț mai mare
ca să ai loc de negociere.
