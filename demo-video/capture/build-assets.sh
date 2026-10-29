#!/bin/sh
# Cuts the raw captures (captures/rec, captures/stills) into the media the film uses (assets/media/v2).
# Re-run after re-capturing; then check the data-media-start values in film/scenes/ against the new marks
# (captures/rec/<name>.json). Times are seconds into each raw recording.
set -e
cd "$(dirname "$0")/.."
mkdir -p assets/media/v2
cut() { # name source start end
  ffmpeg -v error -y -ss "$3" -to "$4" -i "captures/rec/$2.mp4" -an -vf "fps=30,format=yuv420p" \
    -c:v libx264 -preset slow -crf 18 -g 15 -keyint_min 15 -movflags +faststart "assets/media/v2/$1.mp4"
}
cut ff     ff3     0 70     # live FitFlow stop, approve, put to work, Home (shot-fitflow.mjs ff3, model request 19)
cut sim    sim     0 46     # live what-if with the sliders (shot-sim.mjs, model request 17)
cut airbag airbag  0 45     # Financial Airbag, deterministic (shot-airbag.mjs)
s() { cp "captures/stills/$1.png" "assets/media/v2/$2.png"; }
s home-00 home                       # shots-ui.mjs home
s scout-laziz_home laziz-home        # explore.mjs
s airbag-03-numbers airbag-numbers
s airbag-04-list airbag-list
s v2-edge-all-chips edge-chips       # edge-all.mp4 at 13.8 s and 17.5 s (live, NO_ANSWER=1)
s v2-edge-all-planner edge-planner
s edge-negate-10-answer-top negate   # live
s offer-signed-2 offer-signed        # shots-ui.mjs offer (deterministic)
s offer-tampered-0 offer-tampered
s order-10-answer-top order          # live
s v2-gym2-question gym               # gym2.mp4 at 15.5 s, the question it asks back (live)
for m in T4 O7 O8 A15 A17 O9; do s "mont-$m-0" "mont-$m"; done   # shots-montage.mjs
s mont-O6-0 mont-O6
s mont-simple_home mont-simple
ls -la assets/media/v2
