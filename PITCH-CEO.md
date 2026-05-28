# FrameComment vs Frame.io — pitch pentru meeting cu CEO

## Pitch de 30 de secunde

> "Frame.io a crescut într-o platformă enterprise cu tot felul de features de care echipa noastră nu le folosește — Camera-to-Cloud, AI transcription, asset management complet, integrări marketing. Noi facem Post-Production și ne trebuie UN lucru, foarte bine făcut: comments structurate pe video, cu version review și sharing către clienți. Am construit exact acel core ca FrameComment, rulează pe infrastructura noastră existentă, cu fiecare feature din workflow-ul nostru implementat pe specificațiile noastre. Datele clienților stau în casă, nu pe servere Adobe."

---

## De ce e mai bun pentru echipa NOASTRĂ (în ordinea relevanței pentru un CEO)

### 1. Cost — economii recurente, nu o singură dată
Frame.io facturează per-seat per-lună + tier-uri de storage. Pentru o echipă de Post-Production:
- masters HD/4K sunt zeci de GB per proiect
- fiecare reviewer = încă un seat
- overage pe storage = și mai mult

FrameComment rulează pe TrueNAS-ul pe care îl avem deja. **Marginal cost = $0**. Cu cât crește echipa și cu cât se acumulează istoricul de proiecte, cu atât gap-ul crește.

> *Sugestie pentru pitch: arată-i CEO-ului factura Frame.io din ultimele 12 luni × 3 = costul "do nothing".*

### 2. Viteza pe LAN
Reviewer-i interni descarcă/redau **direct** de pe storage-ul nostru. Nu mai trec masters de 10–20 GB prin internet la AWS și apoi înapoi prin internet la client. Live review meeting → fără buffering.

### 3. Data sovereignty + NDA work
Master files, footage unreleased, conținut sub NDA — tot stă în casă, în spatele firewall-ului nostru. Niciun terț nu poate fi breach-uit, subpoena-uit, sau să-și schimbe ToS-ul. **Argument important pentru clienți enterprise care cer DPA-uri stricte.**

### 4. Customizare 100% pe workflow-ul nostru
Frame.io ne dictează un workflow generic (Approve / Reject / statusuri fixate). În FrameComment fiecare buton/flux îl facem exact cum cere echipa. Feature/bug fix într-o zi, nu "vedem la Q4 roadmap." Și nu plătim consultanți Adobe să configureze.

### 5. Vendor risk = zero
Adobe a cumpărat Frame.io în 2021. De atunci pricing-ul s-a schimbat de câteva ori, tier-urile s-au reorganizat, totul s-a împachetat în Creative Cloud. Dacă mâine sunset-uiesc un feature sau pun prețul x2 — suntem captivi. FrameComment = source-ul e al nostru (AGPL). Continuă să ruleze indiferent.

---

## Feature parity cu Frame.io — ce funcționează deja

Tot ce e mai jos e deja în producție, identic cu Frame.io ca UX (folosit ca North Star):

- **Timeline comments** cu click-to-seek la precizie de milisecunde
- **Range comments** (in/out points, drag pe timeline)
- **Voice comments** (înregistrare browser, recording + playback inline)
- **Annotations**: linie, săgeată, dreptunghi, culori, undo/redo
- **Version stacking** (drag-to-stack pentru revizii)
- **Folders** cu sharing per-folder: NONE / PASSWORD / OTP, cu expiration
- **Reactions** + Edit + Delete pe propriile comment-uri
- **Hover-scrub** thumbnails + storyboard sprite-sheets (preview instant fără play)
- **Quick Look** cu tasta Space (ca macOS Finder)
- **Grid + Table view**, sort A–Z / Z–A persistent per user
- **Drag-and-drop uploads** cu TUS resumable (supraviețuiește la network drops, nu trebuie reluat de la 0%)
- **Global search** prin proiecte/foldere/videos
- **Approve / In Review / Archived** workflow
- **Mobile responsive** — review pe telefon de oriunde
- **Trash cu 30-day recovery**, soft delete
- **WebAuthn** (passkey login) + JWT
- **Multi-language** (next-intl)
- **Image support** (poți să review-uiești și stills)

---

## Răspunsuri la întrebări previzibile

**"Cine îl menține?"**
> Eu, deocamdată. Stack-ul e Next.js + Prisma + Postgres — standard, ușor de angajat dezvoltatori React la nevoie. Deploy = update din catalog-ul TrueNAS. Maintenance real = câteva ore pe lună.

**"Ce facem dacă tu pleci?"**
> Codul e documentat, CHANGELOG complet, deploy script de o linie. Orice React/Next.js dev preia într-o săptămână. E mai simplu decât administrarea unei flote de conturi Frame.io pentru o echipă mare.

**"E sigur?"**
> Auth-ul folosește passkey (WebAuthn) + JWT. Share links opțional cu password sau OTP. Aplicația rulează **în spatele firewall-ului nostru**, nu expusă la internet. Per-project share expiration. Net: mai sigur decât Frame.io pentru NDA work, pentru că nu există un terț în lanț.

**"De ce să schimbăm acum, când Frame.io merge?"**
> "Merge" cu cost recurent + frustrări de viteză. Cu cât amânăm migration-ul, cu atât avem mai multe proiecte istorice de migrat. Migration-ul îl facem incremental — proiecte noi în FrameComment, proiectele existente rămân în Frame.io până se închid.

**"Ce NU poate face FrameComment?"**
> Onest: nu avem Camera-to-Cloud (ne-ar trebui? nu cred), nu avem integrare native cu Premiere/DaVinci (review-ul oricum se face în browser), nu avem AI auto-transcribe (încă). Dacă echipa cere oricare, le construim. **Ăsta e exact pointul** — focus pe ce ne trebuie nouă, fără bloat.

---

## Closing ask

> "Propun un pilot de 30 de zile pe **un singur proiect activ** — folosim FrameComment în paralel cu Frame.io. La final, echipa votează. Dacă merge mai bine, migrăm complet și anulăm abonamentul Frame.io. Risc = zero, downside = câteva ore din timpul echipei. Upside = saving anual + control complet."
