# NextMove demo film: script and storyboard

1920x1080, 30 fps, 180 s. No voiceover: the on-screen type carries the story, over a synthesised ambient bed.
Structure follows the organisers' three minutes: user, problem and solution (0:00–0:30); one working workflow from input to outcome, with the technical decisions called out on screen (0:30–2:00); value and differentiation (2:00–2:30); how it is built, honest limits and the next step (2:30–3:00).
A chapter marker bottom-left names the block on screen.
Style: big type, negative space, real UI shown large in a plain device frame, punch-ins for anything that must be read.
Palette from `src/app/globals.css`: canvas #f7f7f2, ink #151515, muted #60605a, border #e4e5df, yellow #fee600, success #067647. Font: Inter (OFL).

Every screen in the phone is the running app, recorded on isolated demo tenants (see `capture/`).
NextMove is a fictional demo bank; all customers, merchants and amounts are synthetic.

| Block | # | Time | File | On screen | Footage |
|-------|---|------|------|-----------|---------|
| 1 User, problem, solution | 1 | 0:00–0:06 | `s01-open.html` | Ink ground. "Your bank shows where your money went." / "Not where it's about to go." | none |
| | 2 | 0:06–0:18 | `s02-leaks.html` | "Money leaks quietly." Five leaks for Alex: FitFlow trial (79 RON), PulseGym unused (250 RON a month), CloudBox duplicate (35 RON), Streamly 39 to 49 RON, StudioMart refund not credited (249 RON). Synthetic-data footnote. | none |
| | 3 | 0:18–0:30 | `s03-idea.html` | NextMove lockup. "A mobile bank with an agent built in, for people and small businesses." "Reads. Calculates. Prepares. You approve." | none |
| 2 Working demo | 4 | 0:30–0:56 | `s04-ask.html` | "Alex asks." (question typed live), "It reads, then does the maths." (242 to 163 RON), "Then prepares one exact action." Callouts: seven typed tools, none can move money; amounts come from deterministic calculations; the agent only prepares. | `ff-ask.mp4`, `ff-done.mp4`, `fitflow-12-proposal.png` |
| | 5 | 0:56–1:14 | `s05-approve.html` | "See exactly what will happen.", "Your approval covers exactly this.", the real approve tap, the simulated merchant's "Renewal stopped": "Approve, and it acts." Callouts: signed immutable manifest (changed term, expiry or replay sends nothing); the gate sends one request and reads back a lost reply. | `fitflow-20-review.png`, `approval-02.png`, `ff-approve.mp4`, `ffframe-60.2.png` |
| | 6 | 1:14–1:26 | `s06-proof.html` | Receipt NF-1047. "Subscriptions, next 30 days: ~~242~~ 163 RON", "Balance unchanged", "Receipt read back and verified". Callout: every step stored with its evidence level. | `ff-receipt.mp4`, `fitflow-50_home_upcoming.png` |
| | 7 | 1:26–2:00 | `s07-offscript.html` | "When it goes off script." Five beats: "Cancel everything." asks which one; the model answered before reading, so NextMove reads first (labelled simulated planner); "Don't cancel anything" and the withheld "has been cancelled" sentence; merchant text is data, never instructions; a tampered offer is refused. | `edge-all-question.png`, `edge-all-question2.png`, `edge-negate-10-answer-top.png`, `offer-signed-2.png`, `offer-tampered-0.png` |
| 3 Value | 8 | 2:00–2:30 | `s08-value.html` | "What Alex gets.": 79 RON, 1 tap, 2,824 RON of future charges avoided in a separate 200-subscription batch run (synthetic, not added to the FitFlow case). Three phones: the same loop for a big purchase, a business order, a gym. "What makes it different.": acts, not just advises; numbers come from code; proof after every step. | `phone-a.mp4`, `order-a.mp4`, `gym-a.mp4` |
| 4 Build, limits, next | 9 | 2:30–2:50 | `s09-build.html` | "How it is built.": diagram built along a request's path (app, agent loop, capabilities, exact approval, durable worker, dispatch gate, simulated merchant and read-back, live model with labelled fallback, evidence log). "Check it. Know its limits.": 678 tests, 310 extension checks, 26 phone end-to-end scenarios, evidence/MANIFEST.md; honest limits (loopback only, no production deployment), next step (a pilot inside a partner bank after its own review). | none |
| | 10 | 2:50–3:00 | `s10-close.html` | Ink ground. Lockup, "Prepared by the agent. Approved by you.", "Built by Mr Laziz · Teo, Retr0 and Cosman", "Built for the Raiffeisen Bank challenge at NEXXT 2026", synthetic-data disclaimer. | none |

## Where each clip comes from

Cut by `capture/build-assets.sh` from the raw recordings in `captures/rec/` (times are seconds into the raw recording). Stills come from `captures/stills/`.

| Clip | Raw recording | In–out | What it shows |
|------|---------------|--------|---------------|
| `ff-ask.mp4` | `fitflow.mp4` (live model, isolated Alex) | 0.8–11.0 | Typing "Can you stop the FitFlow trial before it charges me?", the task opens |
| `ff-done.mp4` | `fitflow.mp4` | 45.5–54.6 | Answer and calculation, scroll to the proposal |
| `ff-approve.mp4` | `fitflow.mp4` | 55.0–61.6 | Review sheet, approve tap, action page, simulated merchant |
| `ff-receipt.mp4` | `fitflow.mp4` | 68.0–75.4 | Receipt NF-1047 and how it was checked |
| `phone-a.mp4` | `phone.mp4` (live model) | 10.5–22.5 | 6,000 RON phone vs the home goal |
| `order-a.mp4` | `order.mp4` (live model, isolated Laziz business) | 5.5–17.7 | 40,000 RON order, conditions |
| `gym-a.mp4` | `gym2.mp4` (live model) | 11.5–23.5 | The agent asks "Are you still going to PulseGym?" |
| `edge-all-question*.png` | `edge-all.mp4` at 13 s and 16 s (live model) | | "Cancel everything" asks which one; the activity row with the labelled simulated planner |
| `edge-negate-10-answer-top.png` | `edge-negate` run (live model) | | The withheld "has been cancelled" sentence |
| `offer-*.png` | `shots-ui.mjs offer` (deterministic, Labs on /capabilities/E3) | | Signed Streamly offer with untrusted merchant text; a tampered offer refused |
