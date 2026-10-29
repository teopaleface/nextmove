# NextMove logo

## The idea

An N drawn as one stroke that stops short. The last upstroke halts, and the move ends in a separate dot. The agent
prepares the move; the gap is the pause where you approve it, and the dot is the one action it then takes. The dot sits
high and to the right, so it also reads as what you keep, moving up.

## Files

| File | Use |
|---|---|
| `nextmove-logo.svg` | Primary horizontal lockup, all ink, on light backgrounds |
| `nextmove-logo-reversed.svg` | Lockup on ink or other dark backgrounds: off-white with the yellow dot (strokes drawn about 4 % thinner so it doesn't look heavier than the light version) |
| `nextmove-mark.svg` | Symbol alone, ink N with the yellow dot. Use it on light backgrounds at 64 px or larger |
| `nextmove-mark-mono.svg` | One colour (`fill="currentColor"`, ink by default). Use it for print, stamps, embroidery and anything under 64 px on light |
| `nextmove-icon.svg` | App icon and favicon: ink rounded square (22 % radius), off-white N, yellow dot |
| `*-1024.png`, `nextmove-icon-512.png`, `-32.png`, `-16.png` | Transparent PNG renders |
| `board.png` | 1920 × 1080 presentation board |

Everything is hand-built vector: the wordmark is drawn from strokes on the same round-ended construction as the
mark, with no font and no `<text>`.

## Colours

| Name | Hex | Role |
|---|---|---|
| Ink | `#151515` | The mark and wordmark on light; the icon tile |
| Canvas | `#F7F7F2` | Light background; the mark on ink |
| Yellow | `#FEE600` | The move dot only. Never a background or tile |

These are the app's own tokens (`--ink`, `--canvas`, `--yellow` in `src/app/globals.css`).

## Clear space and minimum size

- **Clear space:** keep one dot diameter (D) clear on every side of the mark or lockup. In the 256-unit drawing,
  D = 52 units, about 30 % of the N's height.
- **Minimum size:** the icon works down to 16 px. The mark without its tile works down to 16 px in one colour. The
  lockup works down to 96 px wide (about 26 px tall); below that, use the icon alone. In print the lockup's minimum is
  25 mm wide and the mark's is 6 mm.

## Don'ts

- Don't close the gap or join the dot to the stroke. The gap is the idea.
- Don't put the mark on a yellow tile or set it in black on yellow. Yellow appears only as the dot.
- Don't use the yellow dot on light backgrounds below 64 px, where it fades. Use the mono or ink version.
- Don't recolour the dot (green, red and so on), add gradients, shadows or outlines, or animate it into a checkmark or arrow.
- Don't rotate, skew or stretch it, and don't redraw the N in another typeface.
- Don't set "NextMove" in a font beside the mark. Use the lockup file.
- Don't add arrows, coins or other symbols to the mark.

NextMove is a fictional demo bank built at a hackathon. The mark is original and is not affiliated with any bank. No
trademark search has been done.
