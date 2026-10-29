#!/bin/sh
# Cuts the raw captures (captures/rec, captures/stills) into the media the film uses (assets/media).
# Re-run after re-capturing. Times are seconds into each raw recording.
set -e
cd "$(dirname "$0")/.."
mkdir -p assets/media
cut() { # name source start end
  ffmpeg -v error -y -ss "$3" -to "$4" -i "captures/rec/$2.mp4" -an -vf "fps=30,format=yuv420p" \
    -c:v libx264 -preset slow -crf 15 -g 15 -keyint_min 15 -movflags +faststart "assets/media/$1.mp4"
}
cut ff-ask     fitflow  0.8 11.0
cut ff-done    fitflow 45.5 54.6
cut ff-approve fitflow 55.0 61.6
cut ff-receipt fitflow 68.0 75.4
cut phone-a    phone   10.5 22.5
cut order-a    order    5.5 17.7
cut gym-a      gym2    11.5 23.5
cut route-a    route    3.0 20.5
cut home-a     home     0.0 14.5
for s in home-00 fitflow-20-review approval-02 fitflow-10-answer-top gym2-10-answer-top phone-10-answer-top \
         fitflow-41-receipt-more fitflow-40-receipt monitoring-01 ffframe-60.2 fitflow-50_home_upcoming route-01 order-10-answer-top fitflow-12-proposal; do
  cp "captures/stills/$s.png" "assets/media/$s.png"
done
cp captures/stills/gym2-rec-8.png assets/media/stop-task.png      # gym2.mp4 frame at 8 s
cp captures/stills/gym2-rec-14.png assets/media/gym-question.png  # gym2.mp4 frame at 14 s
# Off-script beats: "Cancel everything" (edge-all.mp4 at 13 s and 16 s), the negated request, and the E3 offers.
ffmpeg -v error -y -ss 13.0 -i captures/rec/edge-all.mp4 -frames:v 1 captures/stills/edge-all-question.png
ffmpeg -v error -y -ss 16.0 -i captures/rec/edge-all.mp4 -frames:v 1 captures/stills/edge-all-question2.png
for s in edge-all-question edge-all-question2 edge-negate-10-answer-top offer-signed-2 offer-tampered-0 offer-signed-0; do
  cp "captures/stills/$s.png" "assets/media/$s.png"
done
ls -la assets/media
