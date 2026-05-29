# FrameComment & ViTransfer license — ce poți face și ce nu

> **DISCLAIMER:** Acest doc NU e consiliere juridică. E un overview
> practic al implicațiilor AGPL-3.0 bazat pe textul licenței și pe
> practica industrială. Pentru un contract real cu client US, consultă
> un avocat care a mai văzut OSS licensing (de preferat și pe partea
> RO, și pe US-side). Costul ~$200-500 pentru o consultație preliminară
> face diferența între un business sustenabil și o problemă legală.

## 1. Ce licență ai

`package.json` zice: `"license": "AGPL-3.0-only"`. FrameComment a fost
forked din ViTransfer 1.0.2 (MansiVisuals), care era și el AGPL-3.0.

**AGPL-3.0 = GNU Affero General Public License v3.**

Pe scurt:
- Copyleft puternic
- Permite uz comercial
- Cere ca modificările + lucrările derivate să rămână AGPL
- **Clauza "Affero":** dacă userii interacționează cu software-ul peste
  rețea (= cazul tău, SaaS), trebuie să le oferi acces la sursa
  versiunii rulate

## 2. Întrebarea principală: pot să cer bani?

**DA. AGPL nu interzice să faci bani.** Multe companii au modele de
business sănătoase pe AGPL:

| Companie | Produs AGPL | Cum face bani |
|---|---|---|
| Bitwarden | password manager | hosted enterprise + self-hosted plans |
| Mastodon | social network | hosting + sponsorship |
| Plausible | analytics | hosted SaaS |
| GitLab | DevOps (parte AGPL) | hosted + EE features |
| Sentry | error tracking | hosted + per-event pricing |
| Element / Matrix | messaging | hosted, support contracts |

Modelul tipic: **vinzi SERVICIUL, nu LICENȚA**.

## 3. Ce POȚI face cu AGPL

**Comercial — fără probleme:**
- Cere bani pe hosting / SaaS (clientul plătește pentru tine să rulezi
  FrameComment pe infrastructura ta)
- Cere setup fee, training, onboarding
- Cere support contracts (4h response, etc.)
- Cere custom development / feature requests
- Cere bani pe custom branding, integrări specifice
- Cere annual maintenance retainer

**Pe partea tehnică — fără probleme:**
- Modifici codul cum vrei (e fork-ul tău)
- Adaugi feature-uri noi
- Vinzi acces la instanța hostată de tine
- Operezi multi-tenant (mai mulți clienți pe aceeași instanță)

## 4. Ce NU poți face cu AGPL

- **NU poți relicenția ca proprietar/closed-source.** Nu deții copyright-ul
  pe codul ViTransfer original. Doar autorii originali pot relicenția.
- **NU poți ascunde sursa.** Dacă clienții tăi accesează FrameComment
  peste rețea (= SaaS), au dreptul să primească sursa versiunii pe care
  o rulezi.
- **NU poți cere clientului să NU redistribuie sursa.** Orice client are
  dreptul să facă fork și să-l hosteze el (în practică, majoritatea nu
  vor, pentru că plătesc tocmai ca să nu se ocupe ei).
- **NU poți elimina creditele upstream.** Atribuirea către ViTransfer +
  MansiVisuals trebuie să rămână (README, NOTICE, footer).
- **NU poți face "AGPL goes away if you pay."** AGPL nu se "dezactivează"
  pentru clienți plătitori. Toți primesc aceeași licență.

## 5. Ce TREBUIE să faci ca să fii compliant

### A. În repo

- Păstrează `LICENSE` fișierul cu textul AGPL-3.0 complet
- Păstrează `NOTICE` (sau echivalent) cu atribuirea către ViTransfer
- Păstrează în CHANGELOG mențiunea că e fork din ViTransfer 1.0.2 (e
  deja acolo — bun)
- Keep repo-ul public pe GitHub. Dacă faci private și operezi SaaS, ești
  în breach.

### B. În UI (asta e specific AGPL, mulți developeri o uită)

**Trebuie un link vizibil în interfață** către source code. Standard
practice:

- Footer cu: "FrameComment — open source under AGPL-3.0 · [Source code](
  https://github.com/DragosOnisei/FrameComment)"
- SAU pagină /about cu link
- SAU în Settings → About

Asta îți acoperă clauza network-use. **E obligatoriu, nu opțional.**

### C. Pentru client

În contractul de service spui clar:
- "Software-ul FrameComment este open source sub AGPL-3.0"
- "Vă oferim un serviciu de hosting, support, și operare a unei instanțe
  dedicate"
- "Aveți acces la codul sursă oricând la [link]"
- "Modificările noastre sunt de asemenea AGPL și disponibile public"

Asta te protejează că nu vinzi licență — vinzi serviciu.

## 6. Modele de business sustenabile cu AGPL

### Model "Hosted SaaS" (recomandat pentru tine)

- Tu hostezi pe TrueNAS-ul tău (sau cloud, doesn't matter)
- Clientul plătește pentru acces la instanță
- Costurile tale reale: storage, electricitate, timp de operare
- Marja: 70-90% (storage e ieftin, timpul tău e cel mai scump cost)

### Model "Dedicated Instance"

- Pentru fiecare client mare, instanță separată (VM/container dedicat)
- Premium pricing pentru izolare
- Bun pentru clienți cu NDA stricte

### Model "On-Premises Support"

- Clientul își hostează SAU pe TrueNAS-ul lor
- Tu primești retainer lunar pentru support + custom features
- Mai puțin recurring revenue dar zero ops pe partea ta

### Model "Hybrid" (combinație)

- Tu hostezi pentru clienții mici/medii
- Clienții mari iau on-premises cu support contract de la tine
- Maximizezi marketul

## 7. Atenție la red flags care AR rupe AGPL

Următoarele ar fi **probleme** dacă le-ai pune în contract sau practică:

❌ "Clientul nu are dreptul să acceseze codul sursă"
   → Violează AGPL section 13 (Affero clause)

❌ "Clientul plătește pentru a primi codul sursă"
   → AGPL cere ca sursa să fie disponibilă tuturor userilor SaaS, gratis

❌ "Featurele premium X, Y, Z sunt closed-source"
   → Dacă rulează pe aceeași codebase și interacționează peste rețea,
     trebuie să fie open. Excepția: dacă sunt servicii SEPARATE care nu
     sunt parte din "the work" (greu de argumentat).

❌ "Clientul nu poate publica/comunica că folosește FrameComment"
   → AGPL nu permite restricții suplimentare

✅ "Clientul nu poate revinde accesul la instanța hostată de noi"
   → OK — limitezi accesul la SERVICIUL tău, nu la software

✅ "Suportul tehnic e doar pentru clienții cu contract activ"
   → OK — vinzi servicii, nu software

✅ "Branding-ul + UI customizations făcute pentru clientul X rămân la
    clientul X"
   → OK în general, dar atenție: modificările tehnice (cod) trebuie să
     fie disponibile, doar configurația/branding-ul rămân private

## 8. Dual-licensing — opțiune limitată

Unele proiecte AGPL oferă și o licență comercială ALTERNATIVĂ pentru
clienți care nu vor să fie sub AGPL (Bitwarden, Sentry au făcut asta).

**Pentru tine NU e viabil deocamdată** pentru că:
- Nu deții copyright-ul pe codul ViTransfer original
- Doar autorii originali (MansiVisuals + contributori ViTransfer) ar
  putea co-relicenția
- Ar trebui CLA (Contributor License Agreement) cu fiecare contributor

Dacă vrei să mergi pe drumul ăsta în viitor:
1. Contactează MansiVisuals → vezi dacă acceptă dual-license cu tine
2. Implementează CLA pentru toți noii contributori
3. Track-uiește meticulous cine a scris ce

E mult overhead. **Mult mai simplu: păstrezi AGPL, vinzi SERVICIUL.**

## 9. Caveat specific RO → US

Câteva lucruri specifice pentru factura RO → client Chicago:

- AGPL e licență internațională, recunoscută atât în UE cât și US
- US client nu are obligația să returneze code modifications către tine
  decât dacă redistribuie software-ul (cazul tipic: nu)
- Contractul de service ar trebui scris cu jurisdiction RO sau US (RO
  e mai ieftin pentru tine dacă apare dispute, US e mai liniștitor
  pentru client). Compromis: arbitraj internațional (LCIA, ICC)
- **Important:** unele Fortune 500 / US Gov clients au politici interne
  ANTI-AGPL pentru că le e teamă de network-use clause. Dacă clientul
  e dintr-o astfel de categorie, semnal earlier că software-ul e AGPL.

## 10. Acțiuni imediate recomandate

Înainte să semnezi cu primul client US:

1. **[CRITIC] Adaugă footer cu link la source code în UI** dacă nu există
   deja. E cea mai vizibilă cerință AGPL pe care multi developeri o uită.

2. **Citește textul AGPL-3.0 cap-coadă** măcar o dată. E ~700 linii,
   45 minute: https://www.gnu.org/licenses/agpl-3.0.en.html

3. **Verifică status MansiVisuals / ViTransfer:**
   - Repo-ul original mai există?
   - Mai e mentenat?
   - Sunt vreo issues care țin de licențiere?
   Dacă MansiVisuals e activ, ia legătura — relație bună cu upstream
   nu strică niciodată.

4. **Consultă un avocat OSS** înainte de prima ofertă cu sumă mare:
   - 1h cu un avocat IT cu experiență OSS = $200-500
   - Te scapă de zile de research + posibile dispute viitoare
   - Specific întrebări: jurisdicție, contract template, network-use
     compliance, MSA pentru clienți US

5. **Pregătește un template MSA (Master Service Agreement)** + SOW
   (Statement of Work) pentru fiecare client. Specifică în MSA:
   - Service description (hosting + support, NU software license)
   - AGPL compliance acknowledgment
   - Source code availability
   - Limitation of liability
   - SLA
   - Jurisdiction + arbitration

## 11. Concluzie

**Răspunsul scurt:**
> DA, poți face bani cu FrameComment păstrând AGPL-3.0. **Vinzi
> serviciul (hosting + support), nu software-ul.** Asigură-te că ai
> link la source code în UI, păstrezi atribuirea upstream, și NU
> încerci să restricționezi accesul clientului la cod.

Modelul tău de pricing din `PRICING-ANALYSIS.md` (platform fee +
per-seat + storage) **e perfect compatibil cu AGPL** — clientul plătește
pentru tine să rulezi serviciul, nu pentru o licență de software.

Singurele lucruri pe care le mai ai de adăugat:
1. Footer cu source code link în UI
2. Clauză în MSA: "Vendor provides hosting service. Software is AGPL-3.0
   open source. Customer acknowledges access to source code at [link]."
3. Consultă un avocat înainte de primul contract serios.
