# NextMove demo film

A 3-minute product film for NextMove, made with [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0): each scene is an HTML page animated with GSAP and rendered to MP4 in headless Chrome.

NextMove is a fictional demo bank. Every customer, account, merchant and amount in the film is synthetic, and the film says so on screen.

- Output: `out/nextmove-demo.mp4` (1920x1080, 30 fps, H.264 + AAC, 3:00)
- Script and scene list: `STORYBOARD.md` (four blocks: 0:00–0:30 user, problem and solution; 0:30–2:00 one workflow, input to outcome; 2:00–2:30 value; 2:30–3:00 build, limits, next step)
- Slide deck: `deck/index.html` (12 slides, 1920x1080), exported to `out/nextmove-deck.pdf`

## Layout

```
index.html              root composition: mounts the 10 scenes, the chapter marker and the audio bed
compositions/s01..s10   one file per scene (HTML + CSS + GSAP timeline inside <template>)
assets/fonts/           Inter variable (SIL OFL 1.1, licence alongside)
assets/audio/           ambient-bed.mp3, synthesised by capture/make-audio.py
deck/                   the slide deck: index.html, export.mjs, app stills in img/, Inter in fonts/
assets/media/           cut footage and stills used by the scenes (git-ignored; rebuilt by capture/build-assets.sh)
capture/                scripts that record the real app and cut the footage
captures/               raw recordings, stills and the model-request ledger (git-ignored)
out/                    renders (git-ignored)
```

## Re-render

Needs Node 22+, Chrome (HyperFrames finds or downloads its own) and ffmpeg.

```sh
cd demo-video
npm install --ignore-scripts      # installs the pinned hyperframes 0.8.214
export HYPERFRAMES_NO_TELEMETRY=1
npx hyperframes lint              # contract checks
npx hyperframes check --json      # lint + layout, contrast and craft audit in a browser
npx hyperframes render --quality delivery --output out/nextmove-demo.mp4
```

A full render takes about a minute. `npx hyperframes snapshot --at 60,90 .` saves single frames for a quick look; `npx hyperframes preview` opens the studio.

`assets/media/` is not committed. If it is missing, rebuild it from the raw captures with `capture/build-assets.sh`, or re-capture first (below).

## Re-capture the footage

The footage is the running app at `http://127.0.0.1:3210`, recorded with Playwright through the Chrome DevTools screencast at 390x844 CSS px and device scale 3 (1170x2532), in Inter, with dev overlays hidden. Every shot signs in as a fresh **isolated** copy of a demo customer, so the shared demo tenants are never touched.

```sh
# deterministic shots, no model calls
node capture/shots-ui.mjs home,route,monitoring,approval,offer

# live agent shots: each run sends one question to the model (plus one per follow-up answer)
node capture/shot-chat.mjs fitflow alex PERSONAL "Can you stop the FitFlow trial before it charges me?" approve
node capture/shot-chat.mjs phone   alex PERSONAL "Can I buy a 6,000 RON phone and still reach my home goal?"
node capture/shot-chat.mjs order   laziz BUSINESS "Can we take the 40,000 RON order?"
ANSWER="stopped going" node capture/shot-chat.mjs gym2 alex PERSONAL "Am I paying for a gym I don't use?"
node capture/shot-chat.mjs edge-all alex PERSONAL "Cancel everything"
node capture/shot-chat.mjs edge-negate alex PERSONAL "Don't cancel anything, just show my balance"

capture/build-assets.sh            # cut captures/rec/*.mp4 into assets/media
python3 capture/make-audio.py      # regenerate the audio bed
```

`capture/lib.mjs` counts every request that can reach the model (`POST /api/tasks`, `POST /api/tasks/:id/answer`) in `captures/model-requests.log` and refuses to go past `MODEL_BUDGET` (default 15). Live answers differ from run to run, so after a re-capture check the in/out points in `build-assets.sh` and the caption timings in the scene files against the new recordings (`captures/rec/<name>.json` has the marks).

`capture/explore.mjs` and `capture/scout-t2.mjs` are scouting helpers that save stills of the main screens; they send no model requests.

## Slide deck

```sh
cd demo-video
node deck/export.mjs     # out/nextmove-deck.pdf (one slide per page) and out/deck-pages/slide-NN.png
```

It uses the repository's Playwright (`../node_modules/playwright`). Open `deck/index.html` in a browser to present it directly. The stills in `deck/img/` are downscaled copies of `captures/stills/`.

## Audio and licences

- Music: none. The bed is two soft sine-pad chords synthesised by ffmpeg (`capture/make-audio.py`); no samples or third-party recordings, so there is nothing to license.
- Font: Inter, SIL Open Font License 1.1 (`assets/fonts/LICENSE-Inter-OFL.txt`).
- HyperFrames and GSAP: used as tools; HyperFrames is Apache-2.0, and GSAP is free to use under its standard licence.
- No voiceover.
