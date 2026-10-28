# NextMove: securitate, control și execuție la scară

Decizie de produs, 28 octombrie 2026: **produsul real va fi o funcție integrată într-o bancă, prin parteneriat**. Prototipul rămâne banca fictivă cu comercianți și bani sintetici. Acesta este un contract de construcție, nu o implementare, certificare juridică sau dovadă de performanță.

Toate cele 22 de grupuri de funcții acceptate în [PRODUCT-SCOPE.md](../PRODUCT-SCOPE.md) rămân. Regulile de aici se aplică fiecăruia: de la abonamente până la scenarii pentru locuință și afacere. În caz de conflict, această revizie prevalează pentru securitate, loturi și recuperare; [cercetarea juridică](../research/eu-regulatory-boundaries.md) explică limitele legale, fără să înlocuiască analiza băncii.

## Ce cumpără utilizatorul

„Spune-i băncii ce vrei să rezolvi. Agentul verifică, îți arată consecințele și duce la capăt acțiunile pe care le-ai aprobat. Vezi ce a reușit, ce așteaptă și ce are nevoie de tine.”

O solicitare precum „anulează toate cele 200 de abonamente” pornește o analiză și pregătește o listă de acțiuni. Nu autorizează implicit pierderea stocării, întreruperea asigurării, plata unor penalități sau modificarea contului altui membru al familiei.

## 1. Rolurile sunt separate

| Componentă | Poate | Nu primește |
|---|---|---|
| Modelul | Interpretează obiectivul și dovezile, cere informații, alege instrumentele și propune variante | Puterea de a aproba, secretele băncii, acces direct la registrul de bani, shell general |
| Motorul de politici | Verifică identitatea, proprietatea, permisiunea exactă, termenii și limitele înaintea oricărei acțiuni | Instrucțiuni de autorizare din pagini, capturi sau răspunsuri ale modelului |
| Motorul de execuție | Rulează pași persistenți, limitați, pe resursa aprobată și verifică rezultatul | Dreptul de a extinde mandatul când întâlnește un obstacol |
| Banca/comerciantul | Confirmă operațiunea în sistemul care deține starea relevantă | Obligația de a considera un click sau un mesaj AI drept confirmare |
| Utilizatorul | Revizuiește, aprobă, exclude elemente, oprește și preia o sarcină | Obligația de a ține aplicația deschisă până la terminare |

Această separare este o alegere de arhitectură. Principiul autorizării în afara modelului este susținut de [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html).

### Permisiuni pe niveluri

1. **Citire:** numai datele necesare sarcinii și contului autorizat; monitorizarea are surse, scop și durată proprii.
2. **Pregătire:** calcule, comparații și propuneri; nu schimbă contracte sau solduri.
3. **Execuție aprobată:** o operațiune exactă ori o listă fixă de operațiuni verificate. Aprobarea unui lot înseamnă o confirmare a listei complete, nu 200 de confirmări identice.
4. **Consecințe suplimentare:** cost, pierdere de date, serviciu esențial, contract pe termen fix sau alt proprietar cer analiză distinctă și, dacă operațiunea este permisă, o nouă aprobare. Unele operațiuni rămân indisponibile.

Blocarea plății pe card, revocarea unui mandat și încetarea contractului sunt acțiuni diferite. Niciuna nu este folosită automat drept înlocuitor pentru celelalte.

Pentru un drept legal de retragere, efectul poate depinde de notificarea trimisă la timp, fără aprobarea comerciantului. Păstrăm separat dovada expedierii, confirmarea primirii, efectul legal/contractual și reconcilierea plăților. Un refuz nu anulează automat dreptul legal; disputa merge la fluxul de clarificare/suport. Prototipul de anulare obișnuită demonstrează confirmarea comerciantului fictiv, nu interpretarea automată a tuturor drepturilor consumatorului.

## 2. Cum anulăm 200 de abonamente

### Analiză și selecție

Agentul construiește un inventar deduplicat după comerciant, cont de abonat și contract. Două tranzacții asemănătoare nu dovedesc două abonamente. Fiecare element primește termenii observați, proprietarul, următoarea taxă, data-limită, data efectului, costurile, accesul rămas și sursa utilizării. Utilizarea lipsă se afișează `Not reported`.

Utilizatorul poate căuta, filtra, exclude sau selecta un grup cu aceleași consecințe. Elementele cu date materiale necunoscute sau risc de întrerupere sunt excluse din selecția executabilă până la clarificare. Nici „nefolosit”, nici „esențial” nu se deduce definitiv din numele comerciantului.

### Aprobare precisă a lotului

Serverul creează o propunere imuabilă. Manifestul include `tenantId`, actorul, contextul, ID-urile și conturile exacte, operațiunea per element, versiunile termenilor, perioada, costul maxim, efectul asupra accesului, dependențele și expirarea. Utilizatorul vede sumarul și poate inspecta fiecare rând înainte să confirme.

Înregistrarea aprobării și amprenta manifestului sunt create/verificate pe server; o semnătură nu înlocuiește autentificarea și controlul resurselor. Fiecare copil executabil consumă o autorizare legată de acțiunea sa. Refolosirea aceleiași cereri întoarce aceeași operațiune; schimbarea parametrilor este refuzată. Niciun `approved: true` furnizat de client/model nu este autoritate.

Regulă propusă pentru fixture: aprobarea lotului permite **începerea operațiunilor timp de 60 de minute**, cu maximum zero taxe suplimentare. UI afișează această durată; nu extinde în tăcere regula existentă de 10 minute pentru o singură acțiune. După expirare, elementele neîncepute cer aprobare nouă; citirea unei confirmări are propria permisiune. Un nou membru descoperit ulterior nu intră în manifestul aprobat.

### Execuție și rezultat

Lista devine o sarcină părinte cu copii persistenți, fiecare cu starea și dovada sa. Coada și starea sunt pe server; închiderea telefonului nu oprește operațiunea și nu o retrimite. Instrumentele primesc pagini de rezultate și rezumate; nu se trimit toate documentele celor 200 de comercianți în fiecare apel al modelului.

- API oficial ori conector partener, când există și permite operațiunea; browser izolat pentru site-uri suportate; instrucțiuni/manual pentru restul. Acoperirea fiecărui conector este declarată.
- Serializare după `(tenant, merchant, subscriber account, subscription)`, inclusiv între loturi și acțiuni individuale. Nu blocăm global toate cele 200 de elemente.
- Limite inițiale propuse pentru demo: maximum 4 operațiuni API simultane pe utilizator, 2 contexte de browser, o modificare pe contul aceluiași comerciant. Valorile sunt configurabile și încă nemăsurate.
- Limite globale și per comerciant, programare echitabilă între utilizatori, `Retry-After`, backoff cu variație și bugete de cost/timp/încercări. Sarcinile urgente au prioritate limitată; nu ocupă permanent toți workerii.
- O acțiune refuzată, un CAPTCHA ori un contract schimbat nu pornește o buclă de încercări. Un refuz al comerciantului nu este tratat drept permisiune de a ocoli procedura.
- Confirmarea independentă a rezultatului actualizează numai înregistrarea și prognoza relevante. Istoricul plăților și soldul nu cresc din anulare.

### Fixture de acceptanță: 200 de elemente, rezultate parțiale

Datele exacte sunt în [demo/bulk-cancellations.json](../demo/bulk-cancellations.json). Este un scenariu sintetic proiectat; nu este un benchmark rulat.

| După verificarea inițială | Număr | Tratament |
|---|---:|---|
| Eligibile, cost suplimentar zero, consecințe cunoscute | 120 | Utilizatorul poate selecta și aproba lista exactă |
| Reînnoire deja oprită | 25 | Fără operațiune și fără economie nouă |
| Necesită autentificare înaintea verificării | 20 | Așteaptă utilizatorul; fără parole în chat |
| Angajament minim / cost de ieșire | 15 | Analiză și decizie separată; rămân excluse |
| Cont comun / serviciu protejat | 10 | Verifică drepturile și consecințele; rămân excluse |
| Comerciant fără conector/procedură suportată | 10 | Arată ruta manuală; nu promite anulare automată |
| **Total** | **200** | **120 selectabile, 80 excluse din acest mandat** |

După aprobarea celor 120, scenariul de referință are **100 confirmate, 8 în așteptarea comerciantului, 5 cu autentificare expirată, 4 cu termeni schimbați și 3 cu rezultat necunoscut**. Cele 80 excluse rămân vizibile. Lotul se afișează `Needs attention`, nu `All cancelled`.

Dacă toate cele 200 sunt eligibile și utilizatorul le aprobă pe toate, manifestul poate conține 200 de elemente. Același mecanism le procesează în coadă, cu aceleași limite. Fixture-ul mixt este ales ca să verifice excepțiile, nu ca limită de 120 a produsului.

Din cele 120, 90 sunt rutate spre API și 30 spre browser; aceasta este o distribuție de test, nu acoperire comercială verificată. Pentru cele 100 confirmate, calculul fixture-ului este **2.824 RON taxe viitoare evitate în fereastra declarată de 30 de zile**. Soldul rămâne neschimbat. Nu anualizăm această sumă și nu adăugăm economii pentru celelalte 100.

### Stări per element

`DISCOVERED → NEEDS_REVIEW / READY → APPROVED → QUEUED → CLAIMED → DISPATCHED → VERIFYING → CONFIRMED`

Ramuri explicite: `ALREADY_OFF`, `WAITING_EXTERNAL`, `NEEDS_AUTH`, `TERMS_CHANGED`, `REFUSED`, `OUTCOME_UNKNOWN`, `UNSUPPORTED`, `REVOKED`, `EXPIRED`. Pentru notificări legale: `NOTICE_DISPATCHED` și, dacă este cazul, `LEGAL_EFFECT_DISPUTED`. Starea contractului, starea încercării și starea reconcilerii prognozei sunt câmpuri separate. Un worker care moare poate lăsa o încercare ambiguă; următorul worker nu presupune că nu s-a întâmplat nimic.

## 3. Oprire, reluare și operațiuni ambigue

**Oprire:** serverul înregistrează revocarea și nu mai acordă dreptul de trimitere pentru elementele neîncepute. Acordarea acestui drept și verificarea revocării au o ordine atomică, verificabilă. O operațiune care trecuse deja de acest punct poate totuși ajunge la comerciant; UI o identifică drept începută, nu promite anularea ei. Fără suport al comerciantului nu există oprire distribuită instantanee.

**Reluare:** recitește starea și termenii; solicită un mandat nou pentru elementele rămase dacă a expirat ori a fost revocat. Nu reexecută elementele confirmate. Un nou mandat nu transformă operațiunile necunoscute în operațiuni sigure de repetat.

**Timeout după click:** dacă comerciantul poate să fi acceptat cererea, marchează `OUTCOME_UNKNOWN`. Mai întâi verifică contul, referința și confirmările. Fără dovadă concludentă, escaladează către utilizator/suport; nu repetă automat clickul de confirmare. Deduplificarea locală nu garantează o singură execuție pe un site extern.

**Retry:** citirile și comenzile cu idempotency verificată pot avea retry limitat. Aceeași cheie cu alt payload este refuzată. Confirmarea cu același eveniment nu se aplică de două ori; evenimentele întârziate nu suprascriu o versiune mai nouă. Documentația [Temporal despre activități](https://docs.temporal.io/activity-definition) explică de ce retry-ul cere operațiuni proiectate pentru idempotency; adoptarea Temporal nu este necesară pentru demo și nu rezolvă singură efectele externe.

**Rollback:** anularea confirmată nu poate fi anulată universal. Reactivarea ori cumpărarea unui plan nou este o operațiune nouă, cu preț și aprobare noi. Dacă înlocuirea unui serviciu eșuează, dependențele împiedică oprirea serviciului vechi când ar pierde date/acces.

### Contractul tehnic de implementat

Revizia independentă [SECURITY-SCALE-REVIEW.md](SECURITY-SCALE-REVIEW.md) identifică zece puncte care cer precizie și apoi dovadă la rulare. Deciziile de construcție sunt:

1. **Autoritate verificabilă.** În monolitul local, un ID opac de mandat are autoritate doar prin înregistrarea server-side și verificarea online atomică; o semnătură nu este necesară ca substitut pentru baza de date. Între servicii separate, serviciul de autorizare poate emite capabilități per acțiune, semnate prin biblioteca și serviciul de chei aprobate de bancă. Formatul leagă emitentul, destinatarul, cheia/versiunea, mandatul, actorul și drepturile curente, ID-ul canonic al contului/contractului, operațiunea și amprenta parametrilor canonici, versiunile datelor/termenilor, costurile/obligațiile rămase, accesul și dependențele, intervalul de valabilitate și versiunea revocării. Verificăm și starea online, nu doar semnătura. Modelul nu primește capabilitatea sau dreptul de a o emite. Alegerea concretă de protocol/serializare criptografică se fixează și se verifică la integrarea băncii, fără criptografie inventată de echipă.
2. **Coadă fără gol între salvare și publicare.** Salvăm mandatul, copiii și evenimentul de trimis în aceeași tranzacție. Un dispatcher citește acest outbox. Fiecare lease are un număr de generație crescător; poarta finală de scriere refuză workerii cu generație veche. Încercarea și autorizarea trimiterii sunt persistate înainte de efect. API-urile și cererile finale ale browserului trec prin aceeași poartă; nu ținem o tranzacție DB deschisă în timpul navigării. O generație nouă nu permite repetarea unei trimiteri anterioare ambigue.
3. **Conector cu limite declarate.** Registrul fiecărui adaptor conține identificarea contului/contractului, cererea finală permisă, precondițiile ce pot fi impuse comerciantului, suportul și durata idempotency, dovada rezultatului și regula de reconciliere. Nu transferăm garanțiile comerciantului fictiv asupra site-urilor reale. Dacă nu putem constrânge efectul aprobat ori rezolva ambiguitatea suficient, execuția automată sau retry-ul respectiv rămâne indisponibil. Chiar încărcarea unui URL poate avea efecte; metoda HTTP nu este singură un indicator de siguranță.
4. **Identitate comună a resursei.** Același cont/contract al comerciantului are un ID canonic derivat pe server, inclusiv când doi titulari ai băncii au mandate asupra lui. Serializarea și deduplificarea nu depind doar de ID-ul sesiunii care a început sarcina. Drepturile comune și eventualele aprobări multiple sunt verificate potrivit mandatului băncii.
5. **Topologie de izolare.** Workerii fără privilegii rulează în celule separate, fără filesystem/credente largi ale gazdei. Ieșirea în rețea trece prin proxy/firewall obligatoriu; traficul direct alternativ este refuzat. Verificarea destinației are loc la conectare, inclusiv pentru IPv4/IPv6, redirecturi, frame-uri, popup-uri, WebSocket și subresurse. Capturarea cererilor în biblioteca browserului este un control suplimentar. Fișierele se parsează separat, cu limite și preview inert.
6. **Preluare protejată.** Vizualizarea și inputul au sesiuni scurte, autentificate și autorizate separat. La preluare, agentul pierde dreptul de input; la revenire se invalidează vechile sesiuni și se recitește starea. Autentificarea are loc pe suprafața protejată aprobată de bancă/furnizor, cu observarea DOM, capturile și înregistrarea sensibile oprite; dacă nu putem garanta acest lucru, folosim ruta manuală fără a observa credentialele.
7. **Admitere și bugete finite.** Limitele de utilizator de mai sus sunt completate în demo de maximum 8 operațiuni API și 4 celule browser active global, maximum o modificare activă pe comerciant global și limita mai strictă a furnizorului. Un lot are inițial cel mult 200 de copii; un inventar mai mare este paginat și împărțit în loturi revizuite, fără elemente abandonate în tăcere. Coada are plafon configurat, termen de lucru, programare echitabilă și capacitate rezervată verificărilor. Costul per sarcină/utilizator/zi este configurat în unități monetare întregi și rezervat înainte de apel; lipsa bugetului blochează admiterea. Nu presupunem un cost real pe model fără măsurare.
8. **Încercări finite, păstrate la restart.** Valori inițiale de test: 3 încercări totale pentru o citire sigură, 20 de interacțiuni/90 de secunde pentru o încercare de browser, 8 tool steps per rundă de decizie și 3 runde automate per lot, nu 200 de conversații lungi. Reconcilierea automată are maximum 5 verificări în 24 de ore, cu respectarea permisiunii de citire și a termenelor. După buget, rezultatul rămâne în așteptare/necunoscut cu atenționare, fără retry nepermis. Acestea sunt limite propuse, nu timpi demonstrați.
9. **Evenimente și restaurare.** Inbox-ul verifică autentificarea/semnătura webhook-ului, contul și ID-ul unic al evenimentului, plus replay și versiunea resursei. Fără ordine autoritativă, recitește starea. După restaurarea unui backup care poate fi pierdut jurnalul trimiterilor, oprim modificările afectate și reconciliem cu comerciantul. Backup-ul local nu poate derula înapoi efectele externe.
10. **Numărători și porți de lansare.** Persistăm separat inventariate, suportate, selectate, aprobate, trimise, confirmate, aplicate prognozei și decontate în cont. Un rezultat confirmat poate avea prognoza încă nereconciliată. Pentru pilot real trebuie numiți responsabilii din bancă și de la furnizor pentru produs, juridic, date, securitate și incidente; documentate scopul, furnizorii și conectorii; apoi probate controalele. Aceste dovezi și acordul băncii sunt încă deschise, chiar dacă specificația este completată.

Toate valorile-limită sunt configurație de pornire propusă și vor fi modificate numai pe baza cerințelor băncii, politicilor furnizorilor și măsurătorilor. [Revizia independentă](SECURITY-SCALE-REVIEW.md) păstrează observațiile și snapshot-urile inițiale; completările de aici sunt răspunsul de integrare al autorului planului, nu un audit de securitate repetat și trecut.

## 4. Bariere de securitate obligatorii

| Suprafață | Cerință de implementat | Dovadă de cerut |
|---|---|---|
| Conturi și date | Identitate/context derivate de server; verificare a proprietății la fiecare citire, fișier, job, aprobare și chitanță | Utilizatorul B nu poate accesa sau executa resursa lui A prin schimbarea unui ID |
| Aprobare | Interfață proprie băncii, protecție contra cererilor falsificate și reutilizării, mandat exact și expirat/revocabil; autentificare suplimentară conform politicii băncii | Modificarea sumei, listei, contului ori termenilor este refuzată înainte de efect |
| Pagini și documente ostile | Conținut tratat ca dovezi neîncrezătoare; fără putere de a adăuga instrumente, destinatari sau permisiuni | O factură care cere exportul tranzacțiilor nu poate produce acel export |
| Browser | Izolare de proces/container și cont; fără profilul personal; egress controlat pentru navigare, redirect, subresurse și descărcări | Fără acces la rețeaua internă, metadata cloud, fișierele gazdei sau sesiunea altui utilizator |
| URL și scraping | Domenii/conectori aprobați, rute/argumente și payload-uri permise, validarea schemei/adresei și reverificare la redirect/DNS; fără a ocoli controalele furnizorului | Un redirect spre IP privat ori date bancare codificate într-un URL de „citire” sunt blocate; allowlist-ul de domenii singur nu este suficient |
| Upload | Tip verificat din conținut, dimensiune/pagini/pixeli limitate, procesare izolată, scanare și fișiere private fără execuție | Fișiere nepotrivite, arhive-bombă și acces între conturi sunt refuzate |
| Date către model | Câmpuri minime pe sarcină, identificatori pseudonimi unde posibil; fără parole, OTP, PIN, tokenuri, număr complet de card | Inspecție a payload-urilor și jurnalelor redactate pe buildul testat |
| Transport și stocare | TLS pentru fluxurile reale; date, fișiere și backup-uri criptate cu chei gestionate separat și acces minim; politici distincte de retenție/ștergere | Verificarea configurației, accesului și restaurării pe infrastructura pilotului; fără afirmații de protecție doar din alegerea găzduirii |
| Secrete și sesiuni | Vault/chei gestionate, criptare, tokenuri cu scop restrâns; autentificarea pe suprafață protejată; logurile și capturile nu rețin secrete | Revocare și rotație testate; loginul nu este vizibil modelului sau în replay |
| Interfață și export | Escape pentru răspunsuri/extracții, fără HTML executabil din model; CSV protejat contra formulelor; linkuri verificate | Payload XSS/CSV nu se execută în UI sau fișierul deschis |
| Consum și lanț de dependențe | Limite pe utilizator și global, versiuni fixate, inventar de dependențe și scanare relevantă | Bucla agentului se oprește la buget; un utilizator nu blochează serviciul |
| Dovezi și incidente | Evenimente minimale cu versiuni/referințe, acces controlat, retenție separată și alertare; plan de incident cu banca | Putem explica cine a aprobat ce și ce a confirmat comerciantul, fără jurnale cu date excesive |

Filtrarea instrucțiunilor ostile și un al doilea model pot reduce riscul; nu sunt o frontieră de autorizare. „Browser context separat” nu este singur o garanție de izolare a rețelei sau gazdei. În producție, verificările de securitate includ aplicația mobilă/web, API, worker, conectori și operațiuni.

## 5. Reguli juridice și traseul prin banca parteneră

Produsul nu se lansează cu eticheta „conform UE” pe baza acestui plan. Banca și furnizorul trebuie să stabilească serviciul real, rolurile GDPR, acordurile cu furnizorii, fluxurile de date, responsabilitățile și activitățile reglementate. [Raportul juridic](../research/eu-regulatory-boundaries.md) conține articolele, sursele primare și calendarul verificat.

- **Date:** datele bancare, capturile și preferințele primesc scop, temei și retenție definite; permisiunea de a anula nu este un temei universal pentru orice prelucrare. Datele fictive nu elimină obligațiile pentru conturi, telemetrie ori capturi reale introduse de oameni.
- **Decizii:** calculele de buget și simularea unei locuințe nu acordă credit. Analiza bonității, deciziile automate cu efect semnificativ și recomandările de investiții cer evaluări și fluxuri distincte. Un buton de confirmare nu rezolvă singur aceste obligații.
- **Acces bancar:** ruta aleasă este integrarea controlată de bancă, prin serviciile acesteia. Nu cerem clientului credențiale bancare pentru un robot extern. Dacă arhitectura/rolul furnizorului intră într-un serviciu de informare asupra conturilor sau inițiere de plăți, banca și consilierii stabilesc autorizările necesare înainte de conectare.
- **Furnizor ICT:** banca își evaluează cerințele DORA și contractul, inclusiv incidente, subcontractori, continuitate, audit și ieșire. A fi furnizor al unei bănci nu înseamnă automat că orice startup este furnizor terț critic desemnat.
- **Consumator:** comerciantul, legea și contractul determină când încetează serviciul și eventualele sume datorate. Reînnoirea oprită, retragerea din contract și rambursarea au reguli diferite. Drepturile consumatorilor nu se transferă automat contractelor business.
- **AI:** informarea despre interacțiunea cu AI, pregătirea personalului și clasificarea funcției se verifică potrivit regulilor și datelor de aplicare în vigoare. Nu clasificăm întreg produsul drept risc redus ori ridicat doar pentru că este bancar.
- **Accesibilitate:** evaluăm și cerințele pentru serviciile bancare destinate consumatorilor, inclusiv identificarea/aprobarea, citirea întregii liste cu tehnologii asistive și explicarea consecințelor în limbaj ușor de înțeles. [Legea 232/2022, art. 2(3)(c) și anexa 1 pct. 4.1(e)](https://legislatie.just.ro/Public/DetaliiDocument/257778) este o sursă națională relevantă; imaginile și un test de contrast nu probează singure conformitatea.

Pentru prototip: fișiere sintetice furnizate de echipă, comercianți controlați, conturi de demo distincte, fără conectare la plăți sau conturi reale. Pentru primul pilot: analiză juridică și de securitate pe fluxurile reale, evaluarea necesității DPIA, contracte cu procesatorii, mecanisme pentru drepturile persoanelor, transferuri și retenție, teste pe integrare și responsabilități de incident. Găzduirea în UE singură nu dovedește conformitatea.

## 6. Edge case-uri care decid acceptarea

| Caz | Comportament obligatoriu |
|---|---|
| Două importuri ale aceleiași facturi/tranzacții | Identificare și confirmare a potrivirii; fără două contracte sau economii duble |
| Telefon puțin folosit, televizor/familie activă | Cere context; utilizarea necunoscută nu devine zero |
| Serviciu esențial ori contul altei persoane | Verifică titularul, mandatul și efectul; exclude până sunt lămurite |
| Taxă anuală, penalitate sau preț promoțional | Arată totalul, obligația rămasă și data efectivă; fără „anulare gratuită” implicită |
| Anulare care șterge date ori dezactivează echipa | Blochează lotul simplu pentru acel element; pregătește migrarea/confirmarea distinctă |
| Trial care a expirat între analiză și execuție | Revalidează ora și termenii; nu promite evitarea unei taxe deja scadente |
| Doi membri aprobă aceeași operațiune | Control de drepturi și blocare per resursă; același efect verificabil |
| Două loturi ating același abonament | Un singur proprietar al încercării active; celălalt citește rezultatul |
| Rețea pierdută după click / worker mort | Stare necunoscută, reconciliere înainte de retry |
| Termen schimbat în timpul lotului | Oprește doar elementele/dependențele afectate; cere o decizie nouă |
| Utilizatorul revocă în timpul execuției | Nicio trimitere nou autorizată după revocare; operațiunile deja începute sunt marcate sincer |
| Aprobare expirată după așteptare în coadă | Nu începe operațiunea; propune o nouă aprobare a restului |
| Login expirat, CAPTCHA sau 2FA | Pauză și intervenție protejată a utilizatorului; fără ocolire |
| Comerciant indisponibil sau limită de trafic | Retry sigur limitat; termenul ratat și acoperirea incompletă rămân vizibile |
| Confirmări duplicate ori sosite în altă ordine | Deduplificare și versiuni; fără dublă economie sau regresie de stare |
| Comerciantul confirmă, prognoza băncii eșuează | Contract confirmat, reconciliere în așteptare; nu repetă anularea |
| Comerciantul refuză ori nu confirmă | Fără succes inventat; rută de clarificare/suport |
| Rambursare acceptată, banii nu au intrat | Separă promisiunea de creditarea reală; sold neschimbat |
| Monedă, TVA, proratizare, zi/oră diferite | Compară aceeași perioadă și monedă, păstrează ipotezele; cere costul material lipsă |
| Pagină/PDF cere tokenuri sau altă acțiune | Conținut neîncrezător; politica refuză exportul/acțiunea neaprobată |
| Se solicită ștergerea datelor după operațiune | Ștergere conform politicii; păstrează doar dovezile justificate legal, cu acces/retenție limitate |
| Telefonul se închide / utilizatorul revine mâine | Sarcina se reîncarcă din server; nu se reexecută din istoricul chatului |

Acestea sunt scenarii de acceptanță pentru implementare. Verificarea unui fixture sau a unui document nu le face teste de securitate/runtime trecute.

## 7. Ce construim în cele 24 de ore

Replanificare relativă la începerea construcției; orele și formatul depunerii se reconfirmă cu organizatorii. Brief-ul PDF actual cere cod, demo end-to-end live și prezentarea conceptului/arhitecturii. Nu publică procente, nu impune aici video de trei minute și nu menționează certificare juridică. Formatul de 180 de secunde rămâne o repetiție propusă și poate fi cerut de alte materiale.

| Interval | Teo | Colegul | Poarta de acceptare |
|---|---|---|---|
| H0–H2 | Model de date, identitate de demo, politici și calculator | Reconfirmă regulile; verifică lista de 200 și costurile | Conturi separate, manifest și fixture validate |
| H2–H6 | O anulare exactă prin browserul comerciantului fictiv, confirmare independentă | Testează schimbarea termenilor și refuzul; pregătește date sintetice | Flux complet pentru un singur abonament |
| H6–H10 | Coada persistentă, copii, idempotency și reconciliere | Scenarii cu răspuns pierdut, restart, dublă apăsare | Fără repetare după rezultat ambiguu |
| H10–H14 | Revizuirea și aprobarea lotului pe telefon; stop și excepții | Izolare între conturi, fișier ostil, login și termeni schimbați | 200 de elemente cu rezultate și excluderi corecte |
| H14–H18 | Leagă economia verificată de obiective și reutilizează calculele telefon/casă/business | Feedback real cu mentorul; documentează ce a schimbat | Poveste financiară completă și impact verificabil |
| H18–H22 | Remedieri, pornire curată, verificări relevante | Repetiție în engleză, deck și evidența limitelor | Demo reproductibil, fără afirmații de conformitate neprobate |
| H22–H24 | Îngheață versiunea și păstrează rezerva de depunere | Verifică accesul la materiale și regulile | Versiune depusă identificabilă |

Nu introducem microservicii/Kubernetes doar pentru un lot de 200. SQLite pe host persistent și o coadă tranzacțională pot susține demonstrația, după măsurare; nu reprezintă o promisiune de capacitate. Pentru bancă: bază de date partajată persistentă, workeri scalabili separat, izolare și limite pe clienți, recuperare din backup, observabilitate și teste cu mai mulți utilizatori. 200 de înregistrări nu dovedesc 200 de browsere ori un serviciu pregătit de producție.

Măsurăm pe build și hardware declarate: timpul până la propunere și confirmare, timp în coadă, operațiuni API/browser, rata stărilor necunoscute, cereri duplicate cu efect, scurgeri între conturi, cost per sarcină, termen-limită ratat și corectitudinea prognozei. Testul cu două loturi simultane și restart are prioritate față de promisiuni precum „suportă milioane”.

## 8. Povestea pentru juriu

Problema rămâne banii și timpul pierdute de client. Într-o singură poveste: agentul descoperă o taxă evitabilă, verifică dacă serviciul este util, compară opțiuni, pregătește lista, primește acordul și dovedește ce s-a schimbat. Lotul de 200 arată că mecanismul poate organiza multe cazuri; un termen schimbat și un răspuns pierdut arată de ce poți avea încredere în rezultat.

Nu recităm legi în demo și nu prezentăm securitatea drept noutatea comercială în sine. Arătăm consecința ei: agentul refuză o instrucțiune străină, nu pierde datele clientului și nu raportează 200 de reușite când are numai 100 confirmate. Finalul leagă taxele evitate de obiectivul locuinței sau de rezerva unei firme.

[Cercetarea suplimentară despre câștigători](../research/hackathon-winners-followup.md) separă premiile confirmate, comentariile organizatorilor și interpretările noastre. Din aceste exemple nu rezultă o formulă garantată de câștig.
