# Music licence

The demo film uses one music track. Nothing else in the soundtrack comes from a third party.

| | |
|---|---|
| Title | Nonstop |
| Artist | Kevin MacLeod (incompetech.com) |
| Tempo | 128 BPM (catalogue value; matched by beat analysis) |
| Source page | https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600042 |
| File downloaded | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Nonstop.mp3 (29 Oct 2026) |
| Original file | `source/Nonstop - Kevin MacLeod.mp3`, SHA-256 `2f2cef2f811dc267f958e483fa17211a3f7efcd93535adfd865ce3224f9b9b7c` |
| ISRC | USUAN1600042 |
| Licence | Creative Commons Attribution 4.0 International (CC BY 4.0) |
| Licence text | https://creativecommons.org/licenses/by/4.0/ (legal code: https://creativecommons.org/licenses/by/4.0/legalcode) |

## Required credit

Kevin MacLeod's attribution code for this track, as shown on the source page:

> "Nonstop" Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0 License
> http://creativecommons.org/licenses/by/4.0/

The credit appears on the film's closing card and in `demo-video/README.md`.

## Changes made

CC BY 4.0 asks us to say whether the work was changed. We did change it. `score-nonstop.mp3` is an excerpt of the track:

- it starts 7.55 s into the original, so the film's cuts land on its beat grid;
- it is re-edited on whole bars (1 bar = 1.875 s) by `capture/build-score.sh`: three intro bars (1.875–7.5 s of the excerpt) play twice, and bars 77–78 and 86 are left out, with a 4 ms ramp at each join;
- it is 180 s long and ends on the track's own final hit, with a 0.6 s fade at the very end;
- the level is lowered by 2.8 dB to about −16 LUFS, with a peak limiter;
- it is re-encoded as 48 kHz MP3 at 256 kbps.

Apart from those bar edits there is no remix, and nothing is overlaid on the music.

## Not used any more

`ambient-bed.mp3` was the sine-pad bed from the earlier cut. We synthesised it ourselves with ffmpeg (`capture/make-audio.py`), so it is not a licensed work.
