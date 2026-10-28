# NextMove — planul echipei Mr Laziz pentru NEXXT

28 octombrie 2026. Nume de lucru, fără verificarea disponibilității comerciale. Acesta este un plan de produs și execuție, nu o aplicație deja construită. Echipa activă: Teo și un coleg. Prezentarea și interfața: engleză. Depunere conform prezentării primite: 29 octombrie, ora 11:00, Europe/Bucharest.

**Direcție actualizată:** banca fictivă cu agent funcțional, date sintetice inspirate din situații reale, cele cinci capacități inițiale, cele trei idei de abonamente propuse de Teo și toate cele 14 idei suplimentare sunt incluse în [definiția actuală a produsului](PRODUCT-SCOPE.md). Aceasta fixează capabilitățile acceptate. Exemplele numerice și cercetarea de mai jos rămân utile; scriptul în engleză este actualizat pentru banca fictivă și noul flux de abonamente.

**Revizie curentă:** produs real ca funcție integrată într-o **bancă parteneră**, conform alegerii lui Teo. [Securitatea și scalarea](design/SECURITY-AND-SCALE.md) fixează construcția, cazul de 200 de abonamente și noul program relativ de 24 de ore. [Analiza UE](research/eu-regulatory-boundaries.md) identifică obligații și limite; [cercetarea suplimentară a câștigătorilor](research/hackathon-winners-followup.md) completează primul eșantion. Sunt specificații și cercetare, nu dovadă de securitate/conformitate sau capacitate la rulare.

## Pachetul final pentru construcția pe telefon

Interfața clientului este pe telefon, în engleză, inspirată de ierarhia și paleta Raiffeisen, cu identitate fictivă NextMove. Pachetul conține 16 ecrane ImageGen și 24 de template-uri inițiale. Revizia UX adaugă patru template-uri pentru loturi, permisiuni, progres și excepții, fără imagini noi generate.

- [Intrarea în pachetul de design](design/README.md) și [referința vizuală](design/design-system.html).
- [Design systemul](design/DESIGN-SYSTEM.md), [tokenurile](design/tokens.json), [datele ecranelor](design/ui-fixtures.json) și [UX-ul mobil](design/MOBILE-UX.md).
- [Planul de implementare actualizat](design/IMPLEMENTATION-PLAN.md) și [capabilitățile agentului](design/AGENT-CAPABILITIES.md). Acest plan actualizat înlocuiește calendarul inițial de mai jos ca reper de execuție.
- [Imaginile și prompturile](design/IMAGE-PROMPTS.md).

Clientul are patru destinații: Home, Activity, Goals, Agent. Agentul dispune de instrumente directe pentru banca fictivă, analiză de imagini, calcule, căutare/extragere web și un browser propriu izolat. Utilizatorul poate vedea progresul și prelua browserul într-o foaie extinsă pe telefon. Computerul desktop complet este o extensie a mediului agentului, nu o a doua interfață pentru client. Execuția financiară cere aprobarea exactă și confirmarea rezultatului.

## 1. Ideea pe care o construim

**Un agent care îți găsește o cale realistă spre ceea ce vrei să faci cu banii tăi.**

Agentul funcționează într-o aplicație de banking fictivă. Poate porni atât de la o întrebare, cât și de la o oportunitate observată în tranzacții, abonamente sau documente încărcate. Acțiunile aprobate schimbă starea băncii și a comercianților simulați și produc confirmări verificabile.

Îi spui: „Vreau telefonul acesta”, „Vrem să cumpărăm o casă”, „Vreau să deschid o covrigărie” sau „Pot accepta comanda aceasta?”. Agentul află ce bani ai, ce obligații ai și ce vrei să protejezi. Compară variantele, îți recomandă una și pregătește pașii următori. Tu confirmi angajamentele financiare. Când un preț, un venit sau un răspuns se schimbă, agentul actualizează planul.

**Promisiunea pentru client:** „Spune-mi ce vrei să faci. Îți arăt ce înseamnă pentru banii și obiectivele tale și pregătesc următorul pas.”

**English pitch:** “NextMove turns a financial goal into a workable plan. It compares the consequences, recommends an option, and prepares the next steps for your approval.”

Publicul produsului include persoane, familii, freelanceri și afaceri. Pentru concurs demonstrăm trei familii de decizii: cumpărături personale, locuință și deschiderea/dezvoltarea unei afaceri. Nu presupunem că toate situațiile financiare sunt deja rezolvate. Pentru un caz nou, agentul cere informațiile necesare și explică ce poate calcula.

## 2. De ce ar merita pentru un client

O persoană care cumpără un telefon vrea să știe dacă alegerea afectează chiria sau avansul pentru casă. O familie care cumpără o locuință are nevoie să vadă și banii rămași după tranzacție, și bugetul de după rată. Un antreprenor vrea să știe ce se întâmplă înainte de încasare, nu numai ce profit pare să existe pe hârtie.

Valoarea pe care o testăm este reducerea muncii dintre „vreau asta” și „știu ce pot face acum”. Clientul primește o alegere explicată, condițiile necesare, alternative și acțiuni pregătite. Nu îi cerem să devină expert în bugete, credite sau cash-flow.

Momentul memorabil al demo-ului: **o alegere aparent accesibilă schimbă un alt obiectiv, iar agentul găsește o alternativă care respectă ambele priorități.** Un al doilea moment arată că recomandarea se schimbă după un răspuns real introdus în scenariu.

## 3. Cum se combină cele cinci propuneri

| Capacitate | Ce face pentru client | Când se activează |
|---|---|---|
| Decizie și plan financiar | Compară cumpărarea, așteptarea, schimbarea condițiilor și finanțarea | În toate cazurile |
| Stoc și achiziții | Verifică ce există deja și ce trebuie cumpărat, cu plata la momentul potrivit | Afaceri cu produse |
| Venit personal și rezervă | Protejează obligațiile și obiectivele declarate | Persoane, freelanceri și proprietari de afaceri |
| Facturi de încasat | Pregătește solicitări de plată și recalculează după răspuns | Utilizatori care au facturi de încasat |
| Servicii financiare și pregătirea cererii | Compară costuri, termene și informații lipsă, apoi pregătește documentele | Când ajută obiectivul ales |

Un cumpărător de telefon nu vede stocuri sau facturi. Un antreprenor le poate folosi pe toate. Interfața pornește mereu de la obiectiv, iar instrumentele relevante apar în context.

Banii firmei și ai persoanei au evidențe separate. Un transfer confirmat către proprietar apare ca ieșire din firmă și intrare în bugetul personal. Nu produce bani noi. Tratamentul salarial, fiscal sau al dividendelor nu se deduce dintr-un prompt.

## 4. Experiența din aplicație

Aplicația bancară fictivă are conturi, tranzacții, abonamente, plăți viitoare și obiective. În interiorul ei, spațiul agentului este în engleză și are trei zone:

1. **Your goal and commitments.** Ce vrei să faci, până când, ce informații ai furnizat și ce nu vrei să sacrifici. Întrebările lipsă apar aici.
2. **Your possible futures.** Două sau trei variante comparate: bani rămași, data când obiectivul devine posibil, obligații și cost total modelat. Fiecare număr poate arăta calculul și sursa.
3. **Your next moves.** Recomandarea, condițiile necesare și acțiunile pregătite. Poți aproba un document concret, schimba o condiție sau refuza o opțiune.

Un panou secundar, „How this was checked”, arată operațiunile efectuate și rezultatele lor: date citite, simulări, oferte comparate și documente pregătite. Acesta arată dovezi operaționale, fără a pretinde că expune raționamentul intern al modelului.

După o modificare, vechile rezultate sunt marcate ca depășite. O aprobare anterioară nu autorizează un plan cu alte sume sau termene.

## 5. Exemplele oficiale ale demonstrației

Datele de mai jos sunt sintetice. Fișierul `demo/cases.json` și verificarea `python3 demo/verify_cases.py` reprezintă referința numerică pentru implementare. Exemplele alternative din notele de cercetare nu înlocuiesc această referință.

### Telefonul și obiectivul pentru casă

Alex are economii de 110.000 lei, poate economisi 6.000 lei pe lună și vrea să ajungă la 130.000 lei pentru avans, costuri și rezerva declarată. Fără telefon, atinge pragul după patru contribuții lunare.

- Telefon de 6.000 lei cumpărat acum: obiectivul se mută la a cincea contribuție lunară.
- Alternativă de 3.500 lei: obiectivul rămâne la a patra contribuție.
- Rezultatul: agentul recomandă în funcție de prioritatea exprimată de Alex. Dacă data locuinței este prioritatea principală, alternativa mai ieftină respectă termenul.

Aceste luni sunt intervale de contribuții, nu date calendaristice garantate. Veniturile și prețurile sunt ipoteze explicite. Ratele pentru telefon ar trebui să fie comparate prin toate plățile și obligațiile viitoare, nu doar prima rată.

Acțiune pregătită: comparație salvată și calendarul de economisire revizuit. Telefonul nu este cumpărat în demo.

### Locuința

Pentru același profil: avans ales 90.000 lei, costuri de tranzacție/mutare introduse explicit 10.000 lei și rezervă dorită 30.000 lei. Total necesar: 130.000 lei. Față de economiile de 110.000 lei, lipsesc 20.000 lei; patru contribuții de 6.000 lei ar acoperi diferența.

Separat, un exemplu de buget după cumpărare folosește venit lunar 12.000 lei, alte cheltuieli 6.000 lei și o rată ipotetică furnizată în catalog de 3.400 lei. Rămân 2.600 lei pe lună. Dacă venitul scade cu 3.000 lei, soldul lunar devine −400 lei. Agentul trebuie să arate această vulnerabilitate.

Rata este un input sintetic de planificare, nu o ofertă verificată sau rezultatul unei aprobări bancare. Avansul ales nu este o regulă legală. Dacă lipsesc costurile tranzacției, agentul le cere înainte să dea un rezultat complet.

Acțiune pregătită: buget și întrebări pentru bancă, checklist și sumar al datelor necesare. Nu se depune o cerere reală.

### Afacerea existentă și comanda mare

O afacere cu produse are 26.000 lei, o rezervă minimă de 8.000 lei și următoarele fluxuri:

- ziua 3: transfer confirmat către proprietar, −4.000 lei;
- ziua 7: alte obligații, −10.000 lei;
- ziua 12: factură existentă încasată, +12.000 lei;
- ziua 15: încasări curente, +10.000 lei.

Fără comanda nouă: minim 12.000 lei, final 34.000 lei.

Comanda nouă cere 1.000 unități de material; există 200 în stoc. Cele 800 de cumpărat costă 30 lei/unitate, deci plata suplimentară este 24.000 lei în ziua 2. Comanda aduce 40.000 lei în ziua 30. Acceptarea fără schimbări ajunge la −12.000 lei, deși încasările de la final sunt mai mari.

Agentul propune avans de 12.000 lei în ziua 1, rest de 28.000 lei în ziua 30 și mutarea încasării facturii existente de 12.000 lei în ziua 5. Această variantă condiționată are minim 10.000 lei.

Aprobarea mesajului prin care cerem avansul nu confirmă încasarea. Demo-ul înregistrează separat o confirmare de plată simulată pentru avans, sau păstrează explicit condiția „dacă avansul este plătit” lângă toate rezultatele ulterioare. Răspunsul privind factura existentă nu confirmă implicit avansul comenzii noi.

**Schimbarea introdusă în demo:** clientul facturii existente poate plăti numai 4.000 lei în ziua 5; restul de 8.000 lei rămâne în ziua 12. Minimul scade la 4.000 lei. Agentul trebuie să actualizeze recomandarea.

Un catalog fictiv are două facilități pe termen scurt: ambele ar pune 4.200 lei la dispoziție în ziua 6, rambursabili în ziua 12. A costă 100 lei; B costă 350 lei. Sub ipoteza explicită că finanțarea A ar fi disponibilă, minimul devine 8.200 lei, iar finalul 49.900 lei. Diferența de numerar față de scenariul fără comandă este +15.900 lei.

Această variantă presupune că încasarea din ziua 12 este disponibilă înaintea rambursării din aceeași zi. Dacă rambursarea are loc prima, minimul intrazilnic ar fi 3.900 lei și ar încălca rezerva. Includeți această ordine în date; este un caz de verificare util pentru juriu.

Această diferență nu reprezintă profitul contabil: sunt consumate și materiale existente. Principalul împrumutat și încasarea mai devreme nu sunt venituri suplimentare. Dacă finanțarea nu este disponibilă, agentul prezintă situația ca nefezabilă în termenii actuali și investighează plata etapizată la furnizor, o comandă mai mică sau alte termene.

Acțiuni pregătite: solicitare de avans, mesaj pentru factura existentă, comandă de aprovizionare, comparație a ofertelor și pachet pentru discuția cu banca. Mesajele și răspunsul sunt în sandbox, etichetate ca simulare. Transferul confirmat către proprietar rămâne în toate variantele; există și în evidența personală o singură dată.

### Deschiderea unei covrigării

Acesta este al doilea mod al familiei „afacere”, cu alte informații necesare. Economii de pornire: 100.000 lei. Cuptor 45.000 lei, amenajare 20.000 lei și garanție spațiu 10.000 lei. Rămân 25.000 lei. Rezerva declarată este trei luni de costuri fixe de 15.000 lei, adică 45.000 lei: lipsesc 20.000 lei față de politica aleasă.

La preț de 6 lei/covrig și cost variabil de 2 lei, contribuția este 4 lei. Pentru 25 zile de lucru/lună, cele 15.000 lei de costuri fixe cer în medie 150 covrigi/zi pentru echilibru, în acest model simplificat.

O alternativă de leasing fictiv presupune 5.000 lei inițial și 1.500 lei/lună, 36 luni, transferul proprietății inclus în oferta sintetică. Amenajarea și garanția rămân 30.000 lei. Rămân 65.000 lei, față de o rezervă recalculată de 49.500 lei. Costurile fixe cresc la 16.500 lei, deci pragul de echilibru devine 165 covrigi/zi. Costul nominal al cuptorului finanțat ar fi 59.000 lei, față de 45.000 lei direct. Agentul arată schimbul dintre lichiditate și cost; nu presupune cererea zilnică sau eligibilitatea.

Acest calculator extinde aceeași familie de instrumente. Dacă bucla agentică principală nu este stabilă, nu îl prezentați ca workflow complet; păstrați-l drept scenariu calculabil și marcați limita. Pentru o afacere nouă nu inventați facturi istorice, stoc sau autorizații.

## 6. Ce trebuie să funcționeze mâine

1. Introducerea unui obiectiv și editarea datelor; același model de date pentru toate familiile.
2. Întrebări pentru câmpurile lipsă. O valoare necunoscută nu devine zero.
3. Calculul scenariului actual și al alternativelor, cu minimum de numerar, date, costuri și obiective afectate.
4. Modelul alege și apelează instrumente reale de citire, calcul și pregătire. Fiecare apel are intrări și ieșiri vizibile.
5. O informație schimbată produce un rezultat nou și invalidează planul anterior.
6. Aprobare pentru un conținut concret și generarea unui fișier/document utilizabil; un răspuns simulat poate continua cazul.
7. Profiluri personale și de firmă distincte, stare păstrată la refresh, resetare și reproducere.
8. Telefonul, locuința și afacerea au calcule efective; scenariile nu sunt numai texte pregătite.

Extinderea acceptată include analiza capturilor de utilizare, trial-uri și abonamente, oferte și toate cele 14 funcții din [PRODUCT-SCOPE.md](PRODUCT-SCOPE.md). Fluxul prioritar de demonstrat leagă o descoperire de o acțiune aprobată, confirmarea comerciantului simulat și actualizarea plăților viitoare. Verificările numerice existente nu testează aceste comportamente noi. Importul CSV, documentele PDF, vocea și căutarea live se adaugă în ordinea în care ajută fluxul demonstrat.

Demo-ul folosește date și oferte fictive permise de brief. Artefactele generate sunt reale; plățile, cumpărăturile, trimiterea mesajelor și aprobările băncii nu sunt operațiuni reale. În cazul unui API indisponibil, modul calculator sau replay este etichetat și nu este descris drept agent live.

## 7. Arhitectura suficientă pentru concurs

Un proiect Next.js/TypeScript, React, validare de date și un singur agent orchestrator: Claude Code CLI, care apelează instrumentele printr-un server MCP local, numai din allowlist ([ADR 0005](docs/adr/0005-local-claude-inference.md); înlocuiește Vercel AI SDK). Fiecare instrument pornește dezactivat și se activează doar după ce testul lui trece. Calculele financiare sunt funcții deterministe, cu bani în unități întregi de bani și rotunjire explicită. Agentul decide ce să ceară, ce variante să verifice și ce instrument să folosească.

Instrumentele propuse:

- `loadContext`: profil, evidență relevantă, obiective și informații lipsă;
- `simulateDecision`: fluxuri datate, alternative, rezerve și legături către intrări;
- `compareOptions`: catalogul relevant și costurile/opțiunile comparabile;
- `preparePlan`: recomandare, condiții și acțiuni concrete, cu versiune;
- `applyApprovedSandboxAction`: generează documentul sau execută acțiunea aprobată în sistemul băncii/comerciantului simulat și returnează starea rezultatului;
- `recordReply`: înregistrează răspunsul simulat, schimbă datele și cere recalculare.

Maximum orientativ opt pași pe rundă, cu limită de timp și erori explicite. Instrumentele sunt activate după context. Starea autoritară și aprobările se păstrează pe server, legate de versiunea datelor și conținut. Apăsarea repetată nu dublează acțiunea. Nu executați expresii arbitrare venite de la model.

Fluxul de bază: obiectiv → date și lipsuri → simulări → recomandare și condiții → aprobare → rezultat pregătit → informație nouă → recalculare.

Pentru o demonstrație locală, SQLite/fișier JSON persistat sau o bază simplă existentă sunt suficiente. Alegerea finală de găzduire trebuie să țină cont că un filesystem serverless poate fi efemer. README descrie exact persistența folosită. Nu promiteți recuperare durabilă dintr-un simplu chat în memorie.

## 8. Ce reutilizăm de pe GitHub

| Proiect | Decizia pentru voi | Motiv |
|---|---|---|
| [Vercel AI SDK](https://github.com/vercel/ai) | Înlocuit de Claude Code CLI ([ADR 0005](docs/adr/0005-local-claude-inference.md)) | Instrumente tipizate, streaming și exemple de aprobare; Apache-2.0 verificat |
| [PapaParse](https://github.com/mholt/PapaParse) | Adăugat dacă implementăm CSV | Parser mic, MIT, fără servicii externe |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | Opțional, maximum 45 min de evaluare | Componente pentru rezultate de instrumente; MIT; trebuie adaptate dependențele |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Alternativă dacă echipa îl cunoaște deja | Stare/pauză/reluare; MIT; adăugarea unui backend Python ar crește integrarea |
| [Vercel Chatbot](https://github.com/vercel/chatbot) | Referință de interfață | Template-ul complet aduce autentificare, baze de date și alte servicii |
| [Maybe](https://github.com/maybe-finance/maybe) | Referință de produs | Arhivat, AGPL, alt stack; nu este baza recomandată |
| [Midday](https://github.com/midday-ai/midday) | Referință de experiență | Monorepo mare și condiții de licențiere de clarificat înainte de reutilizare comercială |

Licențele, commit-urile, fișierele inspectate și versiunile compatibile la nivel de manifest sunt în [cercetarea GitHub](research/github-components.md). Nu au fost instalate sau testate aceste aplicații. Folosiți puține componente, versiuni fixate și lockfile. Păstrați atribuirea și notificările pentru cod adaptat.

Verificați devreme un endpoint API de model care funcționează. Abonamentele de coding ajută la construcție, iar disponibilitatea/creditul API pentru aplicație se verifică separat; documentația OpenAI distinge costurile API de utilizarea inclusă în abonament. [OpenAI Docs](https://developers.openai.com/codex/pricing/). Nu este necesară alegerea „celui mai nou model” înainte de a demonstra tool calling și latență acceptabilă pe contul disponibil.

## 9. Ce învățăm de la câștigători

Am cercetat șapte proiecte premiate la șapte evenimente; distincțiile exacte și limitele dovezilor sunt în [cercetarea câștigătorilor](research/hackathon-winners.md). Nu este o formulă statistică de câștig și nu au fost rulate proiectele sau vizionate toate demo-urile.

[Cercetarea suplimentară](research/hackathon-winners-followup.md) adaugă proiecte diferite și separă motivele publicate de organizatori de lecțiile deduse. Pentru povestea actuală, criteriul practic este să demonstrăm economie utilă, sarcină dusă până la rezultat și adaptare la o excepție; lungimea listei de funcții nu dovedește aceste lucruri.

- **SalesShortcut, Grand Prize Google Cloud ADK, 2025:** mai multe operațiuni formează o sarcină completă. La voi, recomandarea trebuie să ducă la un pas folosibil. [Organizator](https://cloud.google.com/blog/products/ai-machine-learning/adk-hackathon-results-winners-and-highlights/).
- **GibberLink, premiu global ElevenLabs, 2025:** un moment de schimbare a comportamentului poate face demonstrația memorabilă. La voi, o informație nouă schimbă planul și cifrele. [Organizator](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon).
- **eCoino, premiul principal Google Cloud Japan, 2025:** comparația scenariilor și adaptarea la perturbări oferă un precedent util. [Rezultate](https://zenn.dev/hackathons/2024-google-cloud-japan-ai-hackathon?tab=updates).
- **Vigil, Grand Winner Elastic, 2026:** legarea concluziilor de dovezi este relevantă pentru bani. [Organizator](https://www.elastic.co/blog/mumbai-forge-the-future-hackathon-2026).
- **FutureCommit, locul 1 în tema purposeful agent la Descope MCP, 2025:** artefacte și pași utilizabili. [Organizator](https://www.descope.com/blog/post/global-mcp-hackathon-winners).
- **Shop It Easy, Grand Prize Databricks, 2024:** recomandările iau în calcul constrângeri reale. [Organizator](https://www.databricks.com/blog/announcing-winners-databricks-generative-ai-hackathon).
- **Integrarea MariaDB MCP, câștigător Integration track, 2025:** documentație și reproducibilitate. [Organizator](https://mariadb.org/model-context-protocol-mcp-hackathon-integration-track-winner/).

Acestea sunt lecții de design deduse din proiecte. Unde organizatorul nu publică motivul particular al jurizării, nu pretindem că știm de ce a câștigat.

## 10. Concurența și diferențierea

[Origin](https://support.useorigin.com/hc/en-us/articles/39419419459085-What-is-the-AI-Advisor) descrie deja bugete, date personale, scenarii pentru decizii mari și acțiuni prioritizate. [ERIC](https://www.raiffeisen.ro/ro/despre-noi/comunicate-de-presa/2026/eric-ai-business-coach.html) descrie planificare financiară și pregătirea dialogului cu banca. [Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick) descrie instrumente și acțiuni cu date de comerț, iar [Float](https://intercom.help/floatapp/en/articles/1719419-scenario-planning) oferă scenarii de cash-flow.

Prin urmare, „AI financiar pentru toată lumea” este o viziune într-o piață existentă. Pentru concurs demonstrăm o buclă verificabilă între obiectiv, consecințe, acțiuni și răspunsuri, folosind același motor în contexte personale și de firmă. Aceasta este diferențierea propusă, nu o afirmație că niciun concurent nu poate face ceva similar. Nu folosim „primul”, „unic” sau „aprobă credite”.

Avantajul de construit după concurs: date și integrări locale, utilizare repetată, dovezi că planurile ajută efectiv și distribuție. Numărul de agenți sau abonamentul folosit pentru coding nu sunt avantaje comerciale.

## 11. Planul de lucru pentru doi oameni

Programul curent este [secțiunea 7 din revizia securitate/scalare](design/SECURITY-AND-SCALE.md#7-ce-construim-în-cele-24-de-ore). Folosește intervale H0–H24, cu o anulare verificată înaintea lotului de 200, apoi recuperare după întrerupere, excepții și legătura cu obiectivele financiare. Înlocuiește calendarul inițial cu ore fixe. Reconfirmați termenul de 29 octombrie 11:00 și formatul depunerii din canalele organizatorului; noul PDF nu le precizează.

Teo conduce aplicația și integrarea. Colegul poate prelua cod în fișiere distincte dacă are competența, sau datele sintetice, scenariile adverse, discuțiile cu mentorii și prezentarea. Fără un al treilea membru presupus. Un flux instabil se repară sau se etichetează drept planificat; nu se înlocuiește cu un rezultat pretins live.

## 12. Ce îi întrebăm pe George și pe mentorii challenge-ului

1. „Does a shared personal and business financial decision agent, demonstrated with these cases, fit the brief?”
2. „Which part of this flow would look too similar to existing tools such as ERIC?”
3. „What would convince you that this agent completes a meaningful task?”
4. „What are the two most important financial mistakes you would test?”
5. „Is a particular model/API required for this challenge or a separate sponsor award?”

Cu organizatorul, pentru interpretarea regulilor: folosirea bibliotecilor MIT/Apache și a exemplelor generice, limba/durata finalei și dovezile necesare pentru mentoring. George poate ajuta cu introduceri și feedback, iar decizia formală asupra regulilor revine organizatorului.

Regulamentul public cere lucru pe challenge după startul oficial și drepturi asupra componentelor folosite; păstrează proprietatea echipei asupra soluției. Nu precizează explicit limita dintre template generic și proiect preconstruit și nu impune în textul inspectat un API anume. Aceste două aspecte se confirmă la eveniment. [Regulament oficial](https://nexxtsummit.com/rulebook/).

Pentru feedback de la utilizatori: întrebați despre ultima decizie reală, datele greu de găsit, ce s-a schimbat, ce ar delega și ce ar face diferit cu planul. Notați numărul și tipul discuțiilor. Entuziasmul unui mentor nu este un client plătitor.

## 13. GTM după alegerea băncii partenere

Ruta aleasă de Teo este o funcție în aplicația unei bănci. Testarea continuă să includă persoane, studenți, familii, freelanceri și firme; clientul comercial al integrării este banca. Prețurile inițiale de 49 lei/decizie și 199 lei/lună din cercetarea anterioară rămân ipoteze istorice de produs independent, nu oferta actuală.

### Primul interval de 30 de zile: problema și sponsorul pilotului

Discutați cu utilizatori cu o taxă sau decizie reală, fără să importați automat datele lor în prototip. George și mentorii pot testa utilitatea și facilita discuția cu o echipă de produs a băncii; nu presupunem că există un parteneriat. Căutați un sponsor intern, un flux concret și acces la mediul de test. În paralel, clarificați rolurile juridice, datele, furnizorii și operațiunile permise.

Rezultat urmărit: o problemă validată și o fișă de pilot convenită, cu utilizatori, scop, date permise, conectori, măsurători și criterii de oprire. Un acord verbal pozitiv nu este contract sau autorizare de integrare.

### Zilele 31–60: sandbox și pregătirea integrării

Dacă există acordul băncii și condițiile necesare, conectați sandbox-ul ei la un singur flux end-to-end. Verificați identitatea, proprietatea conturilor, permisiunile, auditul minimal și raportarea rezultatelor. Rulați loturi cu mai mulți utilizatori, întreruperi și comercianți nesuportați. Completați evaluările de date/securitate și documentele cerute pentru pilot; calendarul este un obiectiv, nu un termen garantat de autorizare.

Măsurați separat: taxe viitoare evitate cu dovadă, bani rambursați efectiv, timp până la rezolvare, intervenții manuale, abandon, efecte duplicate, erori financiare și cost pe sarcină. Nu numărați o anulare pregătită drept beneficiu financiar realizat.

### Zilele 61–90: pilot limitat, numai după porțile necesare

Dacă analiza și integrarea permit, testați cu grupul și operațiunile aprobate de bancă. Definiți responsabilul de suport, tratarea reclamațiilor, incidentele, limitele și oprirea. Extindeți numai după rezultate inspectabile. Conversia, retenția și costul de suport se măsoară; nu sunt cifre existente.

Model comercial de testat cu banca: taxă de platformă plus utilizare/cont activ, cu responsabilități și costuri negociate. Nu propunem un preț validat și nu încurajăm agentul să recomande produse pentru comision ascuns. Orice afiliere/stimulente trebuie analizate și explicate în contextul serviciului.

Păstrăm viziunea largă, dar fiecare familie de funcții primește dovadă și drepturi proprii. O funcție cu erori financiare, efecte neautorizate ori clasificare nerezolvată nu intră în pilot doar fiindcă altă funcție a trecut verificările.

## 14. Ce arătăm pentru fiecare criteriu

### Brief-ul PDF atașat acum

PDF-ul `Brief Raiffeisen Bank.pdf`, verificat integral, cere o provocare deschisă de agenți AI financiar-bancari. Enumeră patru priorități și **nu publică ponderi procentuale**:

| Prioritate din brief | Dovada din demonstrația actuală |
|---|---|
| Concept și utilitate | Un client evită o taxă inutilă fără să piardă beneficiile de care are nevoie; impact asupra obiectivului său |
| Profunzimea execuției | Date → verificare → comparație → mandat exact → operațiune → confirmare; lot cu excepții și recuperare |
| Prototip funcțional | Flux live cu comerciant fictiv, stare persistentă și o situație schimbată în fața juriului |
| Arhitectură și fezabilitate | Instrumente limitate, autorizare pe server, conectori expliciți, cod și setup reproductibile |

Livrabilele din acest PDF: cod sursă, demonstrație end-to-end în timp real și scurtă prezentare a conceptului și arhitecturii. Siguranța susține utilitatea și fezabilitatea; nu este prezentată ca un criteriu ponderat separat. Video-ul de trei minute și deck-ul provin din materialele anterioare, nu din acest PDF.

### Grila din prezentarea anterioară, de reconfirmat

| Criteriu | Pondere | Dovada pregătită |
|---|---:|---|
| Originalitate | 15% | Același motor în trei contexte; consecințe asupra obiectivelor; plan revizuit după răspuns; concurență descrisă onest |
| Înțelegerea problemei | 15% | Feedback real cu eșantion declarat, timp vs profit, date lipsă, separarea banilor personali |
| Agent și orchestrare | 25% | Apeluri reale, selecție contextuală de instrumente, recalculare și aprobare |
| Funcționare și testabilitate | 20% | Cazuri numerice, date editabile, acțiune pregătită, excepție și resetare |
| Arhitectură și reproducere | 15% | Setup, dependențe fixate, date sintetice, verificări, persistență și limitări clare |
| Business mentoring | 10% | Discuțiile efective și schimbările rezultate; dovada cerută de organizator |

Sursa istorică a ponderilor: slide-ul 22 din prezentarea furnizată în conversația principală. Livrabilele de pe slide-ul 19: video de trei minute, repository GitHub și slide deck. Brief-ul financiar și datele permise: slide-ul 14. Păstrăm proveniența; aceste procente nu sunt atribuite PDF-ului nou și nu presupunem că una dintre surse o anulează automat pe cealaltă. Cereți organizatorului reconcilierea înaintea depunerii.

## 15. Prezentarea în engleză

Scriptul și timpii din [pitch/english-pitch.md](pitch/english-pitch.md) urmăresc banca fictivă, abonamentele, acțiunile confirmate și recalcularea după schimbarea unei condiții. Povestea este descrisă în [PRODUCT-SCOPE.md](PRODUCT-SCOPE.md); exemplele financiare anterioare pot demonstra amploarea agentului. Scenariul covrigăriei noi intră în prezentare doar după verificarea efectivă a implementării și o repetiție care încape în trei minute.

Deck de șase slide-uri: 1) promisiunea și banca fictivă, 2) problema și feedback-ul efectiv, 3) demo cu utilizare, oportunități, aprobare și confirmare, 4) condiții schimbate și obiective mai mari, 5) concurență/GTM/prețuri ipotetice, 6) ce funcționează și ce pilot cerem. Sunt conținuturi propuse; nu au fost create slide-urile sau înregistrarea.

Întrebări probabile:

- **Why not use a general chatbot?** Calcule datate, date persistente, instrumente și acțiuni revizuite, cu dovezi în demo. Nu pretindeți că un chatbot general nu poate calcula.
- **Is this already available?** Origin/ERIC și alte produse acoperă părți importante. Arătați exact bucla implementată și contextul local; diferențierea comercială rămâne de validat.
- **Does it approve loans?** Compară scenarii și oferte furnizate; pregătește discuția și informațiile. Disponibilitatea/eligibilitatea nu rezultă din simulare.
- **How can it serve everyone?** Aceeași structură de obiective, fluxuri și obligații, plus instrumente specifice; suportul demonstrat este explicit.
- **How do you make money?** Test de plată pe decizie personală și abonament business; parteneriate după dovezi de utilizare.
- **What if the data is wrong?** Datele și ipotezele sunt inspectabile, câmpurile lipsă cer clarificări, iar modificările recalculează planul.

## 16. Verificarea înainte de depunere

- Calculele din `demo/cases.json` trec verificarea independentă; apoi sunt comparate cu rezultatul implementării.
- Sunt rulate live un caz personal, unul de locuință și unul business, inclusiv schimbarea unei informații.
- O factură, o plată și un împrumut nu sunt numărate de două ori; principalul nu este profit.
- Lipsa unui cost important produce întrebare, nu rezultat fictiv complet.
- Refuzul, aprobarea expirată și apăsarea repetată nu produc acțiunea greșită.
- Fișierele descărcate conțin sumele/datele aprobate și etichetele simulării.
- README funcționează dintr-un checkout curat, arată variabilele necesare fără valori secrete și descrie exact datele și serviciile.
- Video-ul are maximum trei minute, linkurile sunt accesibile juriului, iar commit-ul depus este identificat.
- Datele sintetice, replay-urile și rezultatele pregătite sunt etichetate corect. Afirmațiile despre utilizatori, integrare, venit și parteneriate reflectă numai ce s-a întâmplat.

## Surse și materiale

- [Câștigători și lecții](research/hackathon-winners.md).
- [Repo-uri, licențe și compatibilitate](research/github-components.md).
- [Produs, concurență și GTM](research/product-and-gtm.md).
- Prezentarea atașată, slide-urile 14, 19 și 22; imaginea programului. Orele exacte se reconfirmă prin canalele oficiale ale evenimentului.
- [Regulament NEXXT](https://nexxtsummit.com/rulebook/).

Starea livrării acestui pachet: cercetare statică, plan și exemple numerice verificate. Aplicația, integrările, slide deck-ul și înregistrarea urmează să fie construite de echipă.
