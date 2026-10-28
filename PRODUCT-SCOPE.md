# NextMove în banca fictivă — direcția acceptată

Actualizat la 28 octombrie 2026 după feedback-ul lui Teo. Acest document fixează direcția produsului; funcțiile descrise sunt propuse, nu implementate. Nu este un angajament că toate sunt deja funcționale în prototip.

**Revizie de siguranță și scalare:** produsul real este ales ca funcție într-o **bancă parteneră**, nu ca robot care primește parolele bancare ale clientului. [Contractul de securitate și execuție](design/SECURITY-AND-SCALE.md) fixează permisiunile, anularea în lot a 200 de abonamente, oprirea/reluarea, cazurile ambigue și condițiile pentru pilot. [Cercetarea juridică UE](research/eu-regulatory-boundaries.md) separă prototipul de obligațiile produsului real. Niciun document nu certifică o conformitate sau o securitate deja obținută.

## Produsul

O aplicație de banking fictivă, cu un agent AI funcțional în interior. Conturile, comercianții, tranzacțiile și ofertele sunt sintetice, construite după situații recognoscibile. Agentul citește informațiile disponibile, cere ce lipsește, compară variante, recomandă și execută acțiunile aprobate în mediul simulat.

Promisiune: **„Banca ta observă unde poți pierde sau economisi bani și te ajută să faci ceva concret.”** Agentul continuă să ajute și la obiective mari: telefon, locuință, afacere, venit personal și finanțare.

Utilizatori: persoane, studenți, familii, freelanceri și afaceri. Capabilitățile se activează după situație. Teo a ales ca agentul să recomande varianta potrivită obiectivelor sale și să pregătească acțiunile, iar utilizatorul să confirme angajamentele financiare.

## Cele cinci capacități inițiale rămân

1. **Decizii și obiective:** cumpărare, economisire, deschiderea sau dezvoltarea unei afaceri; consecințe asupra celorlalte obiective.
2. **Stoc și achiziții:** necesarul, stocul existent, termenele și banii necesari pentru aprovizionare.
3. **Venit personal și rezervă:** obligații protejate și scenarii pentru venituri variabile, cu evidențe personale și de firmă separate.
4. **Facturi de încasat:** solicitări pregătite, răspunsuri și impactul datei încasării asupra planului.
5. **Servicii financiare:** comparație de oferte, costuri și condiții, plus pregătirea informațiilor pentru următorul pas.

## Cele trei idei propuse de Teo

- **Utilizare versus preț:** încarci captura Screen Time și informațiile abonamentului; agentul analizează dacă planul corespunde folosirii și beneficiilor pe care le vrei. Timpul pe telefon este un indiciu; se verifică folosirea pe alte dispozitive, în fundal sau de către familie.
- **Trial-uri care devin plătite:** identifică termenul, prețul viitor și notifică înainte de taxare; cu acordul utilizatorului poate opri reînnoirea/anula în sistemul comerciantului simulat.
- **Oferte și eligibilitate:** compară abonamente separate, pachete și reduceri de student sau alte beneficii. Păstrează condițiile și durata promoției lângă calcul. Ofertele reale se folosesc cu sursă și dată; prețurile inventate sunt etichetate.

## Cele 14 idei suplimentare acceptate

1. **Beneficii plătite de două ori.** Găsește servicii incluse într-un pachet existent și verifică echivalența înainte de a propune eliminarea plății redundante.
2. **Plan prea mare pentru utilizare.** Compară consumul cu limitele unui plan mai ieftin și explică beneficiile pierdute înainte de schimbare.
3. **Lunar versus anual.** Calculează pragul de utilizare la care plata anuală merită, ținând cont de angajament, reînnoire și orizontul utilizatorului.
4. **Scumpiri observate automat.** Detectează o modificare de preț recurentă, caută explicația în informațiile furnizate și compară opțiunile.
5. **Abonare după conținutul dorit.** Pregătește un calendar pentru serviciile relevante, verificând disponibilitatea conținutului și condițiile de oprire/reînnoire.
6. **Pauză temporară.** Verifică suspendarea permisă a unui serviciu, efectele și data revenirii; execută numai opțiunea aprobată.
7. **Rambursare urmărită.** Leagă returul acceptat de termenul comunicat și de tranzacția de creditare; pregătește solicitarea dacă termenul este depășit.
8. **Posibilă plată dublă.** Distinge două plăți finalizate de o autorizare temporară sau două cumpărături diferite; cere confirmarea și pregătește dovezile.
9. **Ajustarea prețului după cumpărare.** Verifică politica fictivă/documentată a comerciantului, termenul și eligibilitatea, apoi pregătește solicitarea diferenței.
10. **Cost total de utilizare.** Compară achiziția împreună cu consumabile, întreținere și servicii obligatorii pe perioada aleasă.
11. **Facturi aliniate cu încasările.** Identifică problema de calendar și solicită schimbarea datei acolo unde furnizorul o permite.
12. **Credite și beneficii care expiră.** Verifică dacă pot acoperi o cheltuială deja intenționată și arată orice plată suplimentară necesară.
13. **Licențe software nefolosite în firmă.** Corelează utilizatorii, activitatea și facturile; pregătește reducerea licențelor cu aprobarea responsabilului.
14. **Optimizarea costurilor pentru călătorie.** Verifică beneficii existente, conectivitate și costuri furnizate pentru plăți; pregătește configurația potrivită perioadei și nevoilor.

## Cum apar într-un singur produs

Aplicația are conturi, tranzacții, plăți viitoare, abonamente, obiective și activitatea agentului. Acțiunile pot porni dintr-o conversație, dintr-o captură/factură încărcată sau dintr-un eveniment observat în date.

Agentul are patru direcții de lucru, care folosesc aceleași obiective și calcule:

- **Protejează:** trial-uri, reînnoiri, scumpiri, posibile plăți duble și termene.
- **Optimizează:** beneficii incluse, planuri, oferte, utilizare și calendarul plăților.
- **Recuperează:** rambursări, diferențe eligibile de preț și facturi de încasat.
- **Planifică:** cumpărături, locuință, afacere, rezerve și venituri.

O economie confirmată sau estimată poate actualiza un obiectiv, cum ar fi avansul pentru locuință. Agentul explică separat ce este deja realizat, ce este condiționat și ce reprezintă evitarea unei plăți viitoare.

## Ce înseamnă că agentul funcționează

Comercianții simulați au stare proprie: plan, preț, beneficii, perioadă de încercare, reînnoire, facturi, rambursări și condiții relevante. O acțiune aprobată schimbă acea stare și produce o confirmare. Banca își actualizează plățile viitoare pe baza rezultatului.

- Anularea abonamentului și blocarea plății pe card sunt operațiuni distincte.
- Cererea de anulare poate fi în așteptare, refuzată sau confirmată, cu o dată de efect. Un mesaj afișat nu dovedește finalizarea.
- O rambursare solicitată nu mărește soldul până când este confirmată creditarea în simulare.
- Istoricul tranzacțiilor rămâne istoric; oprirea reînnoirii modifică viitorul, fără să șteargă plățile anterioare.
- Beneficiile suprapuse nu produc economii numărate de două ori. Comparația include perioada promoțională și costul după promoție.
- Aprobarea este legată de serviciul, suma, termenii și versiunea planului. Schimbarea unei condiții cere revizuirea aprobării.
- Pentru multe abonamente, utilizatorul revizuiește și aprobă o listă fixă cu efectele per element. Sistemul execută prin sarcini persistente și limite de concurență, păstrează excepțiile și confirmă separat fiecare rezultat. „Anulează toate” nu autorizează penalități necunoscute, pierderi de date sau contractele altor persoane.
- Oprirea blochează autorizarea unor trimiteri noi; nu promite retragerea unei operațiuni deja începute la comerciant. Un rezultat necunoscut se verifică înainte de a repeta operațiunea.
- Agentul selectează instrumente și răspunde la informații schimbate. Chat-ul și scenariile numerice nu sunt răspunsuri predefinite prezentate ca inteligență live.

## Poveste de demo recomandată după această extindere

Un student deschide banca fictivă și încarcă utilizarea și abonamentele. Agentul găsește un trial apropiat de taxare, o suprapunere de beneficii și o alternativă potrivită utilizării. Verifică ce vrea utilizatorul să păstreze, compară costurile și pregătește modificările.

Utilizatorul aprobă. Un comerciant confirmă anularea, altul schimbă o condiție de eligibilitate; agentul recalculează și cere decizia pentru varianta revizuită. Plățile viitoare și obiectivul de economisire se actualizează. Un exemplu scurt de locuință sau afacere arată că același agent ajută și cu decizii mai mari.

Această poveste este propusă, nu înregistrată. Toate funcțiile rămân în direcția acceptată; ordinea de implementare și selecția scenelor pentru cele trei minute se stabilesc după ce există un flux complet verificat.

## Legătura cu materialele existente

- [Planul de hackathon](PLAN-HACKATHON.md) rămâne baza de organizare, cercetare și criterii.
- [Exemplele numerice](demo/cases.json) acoperă telefonul, locuința și afacerea; cele 42 de verificări existente nu validează noile funcții de abonamente sau comerciant.
- [Scriptul în engleză](pitch/english-pitch.md) urmărește noua poveste: banca fictivă, abonamente, confirmarea comerciantului și legătura cu obiectivele mai mari. Se cronometrează pe implementarea efectivă înainte de înregistrare.

Nu sunt create în acest pas aplicația, integrările sau noi oferte comerciale reale. Sunt fixate capabilitățile acceptate și comportamentul așteptat al prototipului.
