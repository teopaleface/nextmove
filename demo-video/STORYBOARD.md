# NextMove demo film: script and storyboard

1920x1080, 30 fps, 180 s. No voiceover: on-screen type carries the story, cut to "Nonstop" by Kevin MacLeod (CC BY 4.0, 128 BPM, see `assets/audio/LICENSE.md`). One beat is 0.46875 s, and every scene and most shots start on a downbeat.
The structure follows the organisers' three minutes:
- 0:00–0:35.6: user, problem and solution (the five leaks hold one bar each, so they can be read)
- 0:35.6–2:05.6: working workflows, from input to outcome
- 2:05.6–2:31.9: value and difference
- 2:31.9–3:00: how it is built, its limits, and the next step

The score is re-cut on whole bars to fit (`capture/build-score.sh`): three intro bars play twice under the leaks, and three bars are taken out later (two before c9, one in the c9 stats card), so every scene still sits on the music it was cut to and the film stays 180 s.

Style: big type, negative space, real UI in a plain device frame, punch-ins for anything that must be read. Palette from `src/app/globals.css`: canvas #f7f7f2, ink #151515, muted #60605a, yellow #fee600. Font: Inter (OFL). Logo: the NextMove mark (`deck/img/nextmove-logo*.svg`). Yellow appears only as the dot, and the mark is drawn, never re-set in a font.

Every screen in the phone is the running app, recorded on fresh isolated copies of the demo customers (see `capture/`). NextMove is a fictional bank, and every customer, merchant and amount is synthetic. Every number on screen is either visible in the recorded UI or comes from the repository (tests, checks, the batch scenario).

Scenes are written in `film/scenes/` and built into `compositions/` by `node film/build.mjs`. The build adds the shared CSS/JS helpers and the logo SVG.

| Block | Scene | Time | On screen | Footage (`assets/media/v2/`) |
|-------|-------|------|-----------|------------------------------|
| 1 User, problem, solution | c1-open | 0:00–0:35.6 | "Money leaks. Quietly." ("Quietly." on the yellow marker). The five leaks for Alex, one bar (1.875 s) each: FitFlow 79 RON trial about to charge, PulseGym 250 RON a month with no visits, CloudBox 35 RON paid twice, Streamly 39 → 49, StudioMart 249 RON refund not credited. "Your bank shows where it went. Not where it's going." The logo draws: "A bank with an agent inside." "It reads. It does the maths. It prepares. You approve." "Meet Alex." "For people. For small businesses." | `home.png`, `laziz-home.png` |
| 2 Working demo | c2-fitflow | 0:35.6–1:05.6 | "Alex asks.": the question is typed live. "It reads first. Live model. Read-only tools." "Code does the maths.": 242 counts down to 163 RON of upcoming charges. "One exact action. Nothing has been sent." Then one continuous take: "See exactly what happens." (the review sheet), "One tap. Exact approval." (the press on the beat drop). "Sent once. Then checked." (simulated merchant, isolated browser: "Renewal stopped"). "Read back. Verified. Receipt NF-1047". "79 RON kept. A charge avoided, not a refund." | `ff.mp4` (live model, request 19) |
| | c3-putwork | 1:05.6–1:13.1 | "Put it to work? 79 RON kept. Balance unchanged." "Savings, 5% a year. Demo rate. Or government bonds, simulated." "Your yes again. Move 79.00 RON to Savings." "Stop the leaks. Grow the rest." on Home (Savings 97,599.00). Small print: "In 12 months: 82.95 RON at the demo rate. A projection, not a promise." | `ff.mp4` (same take) |
| | c4-offscript | 1:13.1–1:35.6 | "Off script?" "Cancel everything." It asks, one at a time. "Model too fast? It reads first." (labelled simulated planner). "Don't cancel anything." No false "done": a claim the records don't back is withheld. "Merchant text is data. Never instructions." "Tampered offer? Refused." "Nothing moves without your yes." | `edge-chips.png`, `edge-planner.png`, `negate.png` (live), `offer-signed.png`, `offer-tampered.png` |
| | c5-sim | 1:35.6–1:46.9 | "A 6,000 RON phone? Will Alex still reach the home goal?" "It answers with a what-if." "Drag.": the term slider moves, "March 2027. Shorter term: one month later." "Drag back. February. A what-if. Nothing moves." | `sim.mp4` (live model, request 17) |
| | c6-airbag | 1:46.9–1:58.1 | "Money tight? Financial Airbag." "One tap. Every optional service. Essential bills stay protected." The count reaches 358.99 RON less due in 30 days (2,036.99 → 1,678.00 RON scheduled · future charges, not a refund). "Approve the exact list." "3 confirmed. DashEats Plus · FitFlow · PulseGym". | `airbag.mp4`, `airbag-numbers.png` |
| | c7-more | 1:58.1–2:05.6 | Laziz Products, a small business: "Take the 40,000 RON order?" "Only with conditions." "Not sure what you mean? It asks first." (gym) | `order.png`, `gym.png` (live) |
| 3 Value | c8-value | 2:05.6–2:31.9 | Summary: 79 RON kept (FitFlow), 358.99 RON less due (Airbag), 1 yes each. The count reaches 2,824 RON in future charges avoided, from a separate batch run of 200 subscriptions (synthetic data, not added to Alex's numbers). "Not just advice. Action. With your yes." A montage, one feature every four beats: Trial Shield, Route to your home, Bill vault, Overdraft shield, Hidden-loss detectors, Simple mode. "Numbers from code. Proof after every step. Your yes, exactly." (two beats apart) | `mont-T4/O6/O7/O8/A17/simple.png` |
| 4 Build, limits, next | c9-build | 2:31.9–2:50.6 | "How it's built.": 8 nodes on the beat (App, Agent, Read-only tools, Exact approval, Durable worker, One-shot gate, Merchant, Receipt read back). "Live model. Labelled fallback." Counts, top-aligned, one-line labels: 693 automated tests, 310 extension checks, 26 phone scenarios (the end-to-end suite in `tests/e2e`). On ink: "Synthetic data. Simulated merchants. No production." "Next: a pilot inside a partner bank." | none |
| | c10-close | 2:50.6–3:00 | Ink. "Stop the leaks. Grow the rest." The tagline steps down, and the lockup draws with the dot landing on the final hit. "Mr Laziz · Teo, Eduard and Cosmin". "Built for the Raiffeisen Bank challenge at NEXXT 2026 · Fictional demo bank. Synthetic data." Music credit. | none |

## Where the footage comes from

`capture/build-assets.sh` cuts these files from the raw recordings in `captures/rec/` (times are seconds into each raw recording). Stills come from `captures/stills/`. The scene files set where each clip starts (`data-media-start`). After a re-capture, check those against the marks in `captures/rec/<name>.json`.

| File | Source | What it shows |
|------|--------|---------------|
| `ff.mp4` | `ff3.mp4`, 0–70 s; `capture/shot-fitflow.mjs ff3` (live model claude-sonnet-5-5, isolated Alex) | The question typed, answer at 16.3 s, proposal, review tap 28.1, approve 33.3, merchant "Renewal stopped" 36.1, put-to-work 39.6, receipt 41.7, Savings 46.9, move approved 58.0, Home 65.5 |
| `sim.mp4` | `sim.mp4`, 0–46 s; `capture/shot-sim.mjs` (live model, isolated Alex) | The phone question, then the what-if card with its amount and term sliders dragged by a visible touch point |
| `airbag.mp4` | `airbag.mp4`, 0–45 s; `capture/shot-airbag.mjs` (no model, isolated Alex) | Home, then Review optional spending (1.2 s), Deploy the airbag (10.4), numbers (13.7), list (17.6), review (23.9), approve (35.8), 3 approved actions (~37.5) |
| `airbag-numbers.png` | `airbag-03-numbers.png` | Scheduled 2,036.99 → conditional 1,678.00 RON |
| `home.png`, `laziz-home.png` | `shots-ui.mjs home`, `explore.mjs` | Alex's Home; the Laziz Products business Home |
| `edge-*.png`, `negate.png` | `NO_ANSWER=1 shot-chat.mjs edge-all` (frames at 13.8 s and 17.5 s) / `edge-negate` (live, requests 20 and 21) | "Cancel everything" asks which one; the labelled simulated planner; the withheld "has been cancelled" sentence |
| `offer-*.png` | `shots-ui.mjs offer` (deterministic, Labs on /capabilities/E3) | A signed Streamly offer with the untrusted merchant text; a tampered offer refused |
| `order.png`, `gym.png` | `shot-chat.mjs order` / `gym2` (live, requests 22 and 23–24; `gym.png` is `gym2.mp4` at 15.5 s, before the answer) | The 40,000 RON order with conditions; "Are you still going to PulseGym?" |
| `mont-*.png` | `capture/shots-montage.mjs` (no model) | Trial Shield, Route to your home, Bill vault, Overdraft shield, Hidden-loss detectors, Simple mode |

Live model requests are counted in `captures/model-requests.log`. The film used 24 in all (the last five re-took the off-script, order and gym stills with the new logo). Failed and superseded takes count too.
