#!/usr/bin/env bash
# Builds assets/audio/score-nonstop.mp3 from the licensed source ("Nonstop", Kevin MacLeod, CC BY 4.0).
# The film is cut to the track's 128 BPM grid (1 bar = 1.875 s), counted from 7.55 s into the source.
# The score is re-edited on whole bars so every scene still sits on the music it was cut to:
#   film 0:00-0:07.5     bars 0-3 (intro)
#   film 0:07.5-0:13.125 bars 1-3 again (the five leaks hold one bar each)
#   then bars 4-76, 79-85 and 87-95 (two bars cut before c9, one in the c9 stats card), 180 s in all,
#   with a 4 ms ramp at each join and a 0.6 s fade-out at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="assets/audio/source/Nonstop - Kevin MacLeod.mp3"
O=7.55
seg() { echo "$(echo "$O + $1" | bc)" "$(echo "$O + $2" | bc)"; }
SEGS=("0 7.5" "1.875 7.5" "7.5 144.375" "148.125 161.25" "163.125 180")
F="[0:a]aresample=48000,asplit=${#SEGS[@]}"
for i in "${!SEGS[@]}"; do F+="[s$i]"; done
F+=";"
CAT=""
for i in "${!SEGS[@]}"; do
  read -r a z <<<"$(seg ${SEGS[$i]})"
  d=$(echo "$z - $a" | bc)
  F+="[s$i]atrim=start=$a:end=$z,asetpts=PTS-STARTPTS,afade=t=in:d=0.004,afade=t=out:st=$(echo "$d - 0.004" | bc):d=0.004[p$i];"
  CAT+="[p$i]"
done
F+="${CAT}concat=n=${#SEGS[@]}:v=0:a=1,volume=-2.8dB,alimiter=limit=0.84:level=false,afade=t=out:st=179.4:d=0.6[out]"
ffmpeg -v error -y -i "$SRC" -filter_complex "$F" -map "[out]" -t 180 -ar 48000 -c:a libmp3lame -b:a 256k assets/audio/score-nonstop.mp3
ffprobe -v error -show_entries format=duration -of csv=p=0 assets/audio/score-nonstop.mp3
