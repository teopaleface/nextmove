// Builds compositions/*.html from film/scenes/*.html, inlining the shared CSS and helpers.
// Usage: node film/build.mjs   (run from demo-video/)
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const css = fs.readFileSync(path.join(root, "film/shared.css"), "utf8");
const js = fs.readFileSync(path.join(root, "film/shared.js"), "utf8");
const logoR = fs.readFileSync(path.join(root, "assets/brand/nextmove-logo-reversed.svg"), "utf8");
// The reversed lockup, inline, with ids made unique per use, plus a stroke twin of the N for the draw-on.
function logo(prefix) {
  const body = logoR
    .replace(/<\?xml[^>]*>/, "")
    .replace(/<title[^>]*>.*?<\/title>/s, "")
    .replace(/ role="img"| aria-labelledby="title"/g, "")
    .replace(/id="(\w+)"/g, (_, id) => `id="${prefix}-${id}"`)
    .replace("<svg ", `<svg class="logo" id="${prefix}-svg" `);
  // Centre line of the N in the drawing's own units: left stem up, diagonal down, short right stem up.
  const draw = `<path id="${prefix}-draw" d="M36 192V64L164 192V150" fill="none" stroke="#F7F7F2" stroke-width="38.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="360" stroke-dashoffset="360"/>`;
  // Hidden from frame 0 in CSS; the scene timeline reveals each part.
  const hide = `<style>#${prefix}-n,#${prefix}-move,#${prefix}-wordmark,#${prefix}-draw{visibility:hidden;opacity:0}</style>`;
  return hide + body.replace(/<g id="[\w-]+-symbol">/, (m) => m + draw);
}
fs.mkdirSync(path.join(root, "compositions"), { recursive: true });
for (const f of fs.readdirSync(path.join(root, "film/scenes")).filter((f) => f.endsWith(".html"))) {
  let src = fs.readFileSync(path.join(root, "film/scenes", f), "utf8");
  src = src.replace("/*@CSS*/", css).replace("/*@JS*/", js).replace(/<!--@LOGO:(\w+)-->/g, (_, p) => logo(p));
  fs.writeFileSync(path.join(root, "compositions", f), src);
  console.log("built", f);
}
