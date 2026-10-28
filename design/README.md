# NextMove — pachetul de design mobil și implementare

Direcție finală pentru interfața pe telefon: identitate proprie galben/negru inspirată din referințele oficiale Raiffeisen, fundal neutru, carduri albe și un agent care lucrează în interiorul aplicației bancare fictive. Engleză în produs. Nume de lucru NextMove.

## Începe aici

Deschide întâi [revizia mobilă interactivă v2](mobile-preview.html), apoi [componentele și tokenurile](design-system.html) și [planul de implementare](IMPLEMENTATION-PLAN.md). Revizia mobilă are 16 vederi și un ecran de aprobare; simulează navigarea și stările, fără agent AI sau servicii conectate.

Revizia v2 aplică skill-urile locale `frontend-design`, `apple-design` și `emil-design-eng`: tipografie nativă, sume aliniate, liste financiare compacte, accent galben pe acțiuni și stări discrete în context. Elimină pastilele pastel pentru statusuri. `Demo` rămâne metadată în antet. HTML-ul v2 este referința vizuală curentă; planșele ImageGen anterioare rămân utile pentru compoziție și acoperire, cu stilul componentelor înlocuit de regulile v2.

**Revizie după alegerea integrării într-o bancă:** începe construcția cu [securitatea și execuția la scară](SECURITY-AND-SCALE.md), [limitele juridice UE](../research/eu-regulatory-boundaries.md) și [cazul sintetic cu 200 de abonamente](../demo/bulk-cancellations.json). Acestea adaugă aprobări în lot, oprire/reluare și excepții. Cele patru ecrane S25–S28 sunt specificate în UX, fără imagini noi generate. Cele 16 ecrane existente rămân concepte pentru fluxurile de bază; nu dovedesc implementarea acestor controale.

[Exemplul interactiv de lot](bulk-action-preview.html) ilustrează revizuirea, rezultatul parțial și oprirea pe telefon. A fost verificat vizual la 390px și 728px; nu este aplicația bancară și nu trimite operațiuni. [Revizia independentă de securitate/scalare](SECURITY-SCALE-REVIEW.md) identifică zece puncte prioritare și 25 de scenarii de acceptanță; răspunsurile de integrare sunt în contractul curent, iar probele runtime rămân deschise.

## Livrabile

- **Revizie v2:** 16 vederi mobile interactive și foaia de aprobare, realizate în HTML/CSS cu componentele rafinate.
- [**17 capturi native v2**](mockups/native-v2/index.html), la 390 × 844: ecranele selectate și aprobarea, randate din HTML-ul curent. Galeria se deschide local; fiecare imagine se poate vedea separat.
- **16 ecrane selectate, generate cu built-in ImageGen**, în patru planșe.
- **24 de tipuri de ecran** și stări reutilizabile, cu maparea tuturor celor 22 capabilități acceptate.
- **Design system:** culori, fonturi, spațiere, componente, accesibilitate, navigație, aprobări și browserul agentului pe telefon.
- **Tokenuri JSON** și un **set numeric comun** pentru ecrane.
- **Plan pentru doi oameni**, arhitectura agentului și criterii clare de verificare.
- **Prompturile exacte**, referințele publice și corecțiile aplicate imaginilor.

## Planșele ImageGen anterioare

1. [01 Banking și intrarea în Agent](mockups/01-banking-and-agent-v2.png): Home, Activity, Subscriptions, Agent.
2. [02 Agentul în acțiune](mockups/02-agent-workflow.png): dovezi, comparație, aprobare și browser în așteptarea confirmării.
3. [03 Rezultat și obiective](mockups/03-results-and-goals.png): confirmare, Goals, cumpărarea telefonului și planul locuinței.
4. [04 Alte contexte și excepții](mockups/04-business-recovery-and-travel.png): business, refund, călătorie și condiții schimbate.

Prima planșă a fost corectată pentru a alinia tranzacțiile istorice cu reînnoirile din prognoză. Planșa a doua folosește explicit același orizont de 30 zile în ambele coloane. Varianta inițială a primei planșe rămâne în `mockups/drafts/` doar ca referință de generare și nu este assetul final.

## Sursele autoritare pentru construcție

1. [Definiția produsului](../PRODUCT-SCOPE.md) fixează capabilitățile acceptate.
2. [Datele pentru ecrane](ui-fixtures.json) și [cazurile financiare](../demo/cases.json) fixează numerele fiecărui scenariu.
3. [Design system](DESIGN-SYSTEM.md), [tokenuri](tokens.json) și [UX](MOBILE-UX.md) fixează stilul, componentele, textele și stările.
4. [Capabilitățile agentului](AGENT-CAPABILITIES.md) și [planul de implementare](IMPLEMENTATION-PLAN.md) fixează execuția și dovada necesară.
   Revizia [securitate și scalare](SECURITY-AND-SCALE.md) prevalează pentru permisiuni, loturi, recuperare și noua ordine de construcție.
5. Imaginile stabilesc direcția vizuală și compoziția; nu sunt exporturi de ecrane implementate sau specificații CSS exacte.

## Verificări efectuate

Au fost inspectate vizual cele patru planșe și referințele oficiale. Cele opt combinații de text/fundal verificate depășesc 4.5:1. Au fost verificate sumele și diferențele din noul set numeric, precum și legăturile locale și formatarea. Auditul independent a identificat neconcordanța datelor de plată; datele și planșa 1 au fost corectate.

Aceste verificări privesc designul și specificațiile. Aplicația, funcțiile modelului, browserul, anularea comerciantului, persistența și monitorizarea urmează să fie implementate și testate la rulare.

Pentru HTML-ul v2 au fost parcurse în browser aprobarea, cererea în așteptare, confirmarea fictivă și schimbarea unei oferte. Au fost verificate toate cele 16 vederi la 360px fără depășire orizontală și fără controale de telefon sub 44px. Previzualizările la 390px și 728px au fost inspectate vizual, inclusiv confirmarea și rezultatul. Au fost verificate izolarea foii de aprobare, revenirea focusului, limita Tab și închiderea cu Escape. Acestea sunt verificări ale prototipului vizual, nu ale unui agent AI conectat.

## Referințe și generare

[Referințele Raiffeisen](references/raiffeisen-references.md) includ paginile oficiale și imaginile publice inspectate. Tokenurile și marca NextMove sunt ale conceptului propus; nu sunt o reproducere declarată a unui design system oficial Raiffeisen.

[Setul de prompturi](IMAGE-PROMPTS.md) documentează generarea cu `image_gen.imagegen` prin Codex și corecțiile ulterioare. Nu a fost folosit CLI/API fallback pentru imagini.
