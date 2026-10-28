# Propunerile din #team-18-mr-laziz — ce s-a implementat

Actualizat 28 octombrie 2026, 17:35. Implementat inițial în worktree-ul `discord-proposals`, peste copia codului principal de la 16:53. Delta față de snapshot-ul `3a46066d8fff2a9613128bb087b04ae986c864e4` a fost integrată ulterior prin aplicare în trei direcții în checkout-ul principal; sursa din worktree a rămas nemodificată. Verificat pe varianta combinată: typecheck curat, 127/127 teste, `next build` trece, capturi la 390 px fără depășire orizontală.

## Implementat

| Cod | Propunere (autor) | Ce vede juriul |
| --- | --- | --- |
| — | Chat interactiv cu grafice și slidere (Retr0, aprobat de toți) | În răspunsul agentului: card cu rate (sumă, durată, dobândă fictivă) față de obiectivul de locuință, slider de salariu, „Invest the delta” la 1/3/5 ani. |
| T4 | Scutul Auto-Stop după 0 lei (Cosman) | Verificarea cardului de 0/1 RON pune comerciantul sub supraveghere; prima taxare întreagă e reținută; clientul blochează sau permite, cu chitanță. |
| A15–A18 | Mecanismele din `message.txt` (Cosman) | Abonament de livrare nerentabil, comision valutar la abonamente în EUR/USD, sală plătită dar nefolosită (fără cheltuieli în jurul ei), asigurare de călătorie dublată de card. |
| O6 | Google Maps for Money (Retr0) | Traseu spre avansul de locuință; obstacole adăugate de juriu; „Recalculating route…”; 4 trasee, unul respins pentru că atinge rezerva. |
| O7, O8 | Salary Autopilot / Idle Cash Sniper / Overdraft Shield (Cosman, Retr0) | Banii pentru facturi stau în „Bill vault” și revin cu o zi înainte de scadență; completare exactă din economii înainte de o factură care ar duce contul pe minus. Acțiune nouă: `INTERNAL_TRANSFER`. |

## Demo (Alex, Personal)

1. Agent → „Can I buy a 6,000 RON phone and still reach my home goal?” → trage termenul la 3 luni: ținta trece în martie 2027.
2. Capabilities → Trial Shield → Labs „Snapwise Pro tries to charge 120.00 RON” → Block → aprobare → chitanță; „tries again” e refuzat.
3. Agent → „Am I paying for a gym I don't use?” → răspunzi „I stopped going” → propunere de oprire a reînnoirii.
4. Goals → Route to your home → „Unexpected 900 RON dental bill”, apoi „Income −20% for 2 months” → trasee noi.
5. Capabilities → Bill vault → Labs „Salary arrives” → Review 3 actions → aprobare. Ultimul pas, pentru că mută ceasul demo-ului.

## Lăsate deoparte

- War Room cu 3 agenți / underwriter adversarial / licitație de produse: ar modifica orchestratorul la care lucrează încă agentul principal. Candidatul cel mai bun pentru după.
- Bunic Mode: strat de voce peste toate ecranele, care se construiesc acum în folderul principal.
- Financial Airbag (O9): rezervat, neconstruit.
- Stoozing: depinde de dobânzi și cashback inventate.
- Obiectiv comun cu prietenii care aduce clienți noi: merge în pitch/GTM ca sursă de clienți noi.
- Ideile B2B (Shadow CFO, e-Factura, granturi, negociere cu furnizori): fiecare e alt produs.

## Probleme cunoscute

- La 360 px, bara de acțiuni din ecranul de revizuire depășește cu 4 px (componenta existentă).
- „Salary arrives” și „Let 72 hours pass” mută ceasul demo-ului pentru tot tenantul (trece și de data trial-ului FitFlow).
- Eticheta aprobării pentru transferuri programate a fost corectată în checkout-ul principal: distinge acțiunile imediate de datele programate și afișează fereastra grantului.
- Răspunsurile clientului la A17/A18 venite prin planner contează doar după ce clientul a răspuns la o întrebare în aceeași sarcină.
