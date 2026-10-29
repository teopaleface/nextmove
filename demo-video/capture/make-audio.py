#!/usr/bin/env python3
"""Synthesises the film's ambient bed with ffmpeg only (no samples, no third-party music).

Two soft sine-pad chords that slowly breathe into each other, a gentle detune for width,
a low-pass and a short echo for air. Output: assets/audio/ambient-bed.mp3 (180 s).
Usage: python3 capture/make-audio.py [seconds]
"""
import subprocess, sys, pathlib

DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 180.0
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/audio/ambient-bed.mp3"

chord_a = [110.00, 164.81, 207.65, 246.94, 329.63]  # A2 E3 G#3 B3 E4
chord_b = [92.50, 138.59, 185.00, 220.00, 277.18]   # F#2 C#3 F#3 A3 C#4
PERIOD = 32.0  # seconds for one A -> B -> A breath

def voice(freqs, weight, detune):
    parts = []
    for k, f in enumerate(freqs):
        gain = 1.0 / (1 + 0.35 * k)                       # quieter as the notes go up
        swell = f"(0.72+0.28*sin(2*PI*t/{7 + 2 * k}+{k}))"  # each note breathes at its own rate
        parts.append(f"{gain:.3f}*{swell}*(sin(2*PI*{f}*t)+0.55*sin(2*PI*{f * detune:.3f}*t))")
    return f"({weight})*(" + "+".join(parts) + ")"

wa = f"(0.5+0.5*cos(2*PI*t/{PERIOD}))"
wb = f"(0.5-0.5*cos(2*PI*t/{PERIOD}))"
shimmer = "0.10*(0.5+0.5*sin(2*PI*t/11))*sin(2*PI*659.25*t)"
left = f"0.045*({voice(chord_a, wa, 1.0031)}+{voice(chord_b, wb, 1.0029)}+{shimmer})"
right = f"0.045*({voice(chord_a, wa, 0.9972)}+{voice(chord_b, wb, 0.9969)}+{shimmer})"

af = (
    "lowpass=f=2200,"
    "aecho=0.8:0.6:140|260:0.22|0.14,"
    f"afade=t=in:st=0:d=4,afade=t=out:st={DUR - 5:.2f}:d=5,"
    "volume=2.5"
)
subprocess.run([
    "ffmpeg", "-v", "error", "-y",
    "-f", "lavfi", "-i", f"aevalsrc=exprs='{left}|{right}':s=48000:d={DUR}",
    "-af", af, "-c:a", "libmp3lame", "-b:a", "192k", str(OUT),
], check=True)
print("wrote", OUT)
