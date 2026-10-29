    // Shared helpers (film/shared.js, inlined by film/build.mjs). Times are seconds from the scene start.
    // The score runs at 128 BPM, and every scene starts on a downbeat, so b(n) is the n-th beat of the scene.
    const B = 60 / 128;
    const b = (n) => Math.round(n * B * 1000) / 1000;
    const tl = gsap.timeline({ paused: true });
    const IN = "expo.out";
    /** Hard cut: the element is on screen from a to z. */
    function shot(sel, a, z) {
      tl.set(sel, { autoAlpha: 1 }, a);
      if (z !== undefined) tl.set(sel, { autoAlpha: 0 }, z);
    }
    /** Kinetic entrance: rises and settles. */
    function pop(sel, t, o = {}) {
      tl.fromTo(sel, { autoAlpha: 0, y: o.y ?? 48, scale: o.s ?? 0.95 }, { autoAlpha: 1, y: 0, scale: 1, duration: o.d ?? 0.42, ease: o.e ?? IN, stagger: o.st ?? 0, immediateRender: false }, t);
    }
    /** Snap entrance: lands from slightly larger, on the beat. */
    function snap(sel, t, o = {}) {
      tl.fromTo(sel, { autoAlpha: 0, scale: o.s ?? 1.16 }, { autoAlpha: 1, scale: 1, duration: o.d ?? 0.34, ease: IN, stagger: o.st ?? 0, immediateRender: false }, t);
    }
    function off(sel, t, d = 0.18) {
      tl.fromTo(sel, { autoAlpha: 1 }, { autoAlpha: 0, duration: d, ease: "power2.in", immediateRender: false }, t);
    }
    function dim(sel, t, to = 0.25) {
      tl.fromTo(sel, { opacity: 1 }, { opacity: to, duration: 0.25, ease: "power2.out", immediateRender: false }, t);
    }
    /** Phone camera: put screen point (px, py), in CSS px of the 390x844 screen, at frame point (fx, fy), at scale k. */
    function cam(k, px, py, fx = 1400, fy = 540) {
      return { x: fx - k * (px + 12), y: fy - k * (py + 12), scale: k };
    }
    function place(sel, t, st) {
      tl.set(sel, st, t);
    }
    function move(sel, t, d, from, to, ease = "power2.inOut") {
      tl.fromTo(sel, from, { ...to, duration: d, ease, immediateRender: false }, t);
    }
    /** A number that counts from `from` to `to` (ease-out), drawn as pre-rendered frames so any seek is exact. */
    function counter(id, from, to, t0, dur, fmt = (v) => Math.round(v).toLocaleString("en-US")) {
      const el = document.getElementById(id);
      const n = Math.max(2, Math.round((dur * 30) / 2));
      const ghost = document.createElement("span");
      ghost.className = "ghost";
      ghost.textContent = fmt(to);
      el.appendChild(ghost);
      for (let i = 0; i <= n; i++) {
        const p = 1 - Math.pow(1 - i / n, 3);
        const s = document.createElement("span");
        s.className = "cv";
        s.textContent = fmt(from + (to - from) * p);
        el.appendChild(s);
        tl.set(s, { autoAlpha: 1 }, t0 + (dur * i) / n);
        if (i < n) tl.set(s, { autoAlpha: 0 }, t0 + (dur * (i + 1)) / n);
      }
    }
    /** Tap ripple at a frame point. */
    function tap(sel, t) {
      tl.fromTo(sel, { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.16, ease: "power2.out", immediateRender: false }, t);
      tl.fromTo(sel, { autoAlpha: 1, scale: 1 }, { autoAlpha: 0, scale: 1.7, duration: 0.45, ease: "power2.out", immediateRender: false }, t + 0.16);
    }
