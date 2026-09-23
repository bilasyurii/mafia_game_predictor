/**
 * Bundles index.html + styles.css + dist/bundle.js into ONE self-contained
 * file (web/dist/predictor.html) that works offline when simply copied to a
 * phone and opened in a browser - no server, and no relative paths that can
 * break when a file manager opens it. Run via `npm run build:offline`.
 */
const fs = require("fs");
const path = require("path");

const WEB_ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(WEB_ROOT, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(WEB_ROOT, "dist", "bundle.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const html = fs
  .readFileSync(path.join(WEB_ROOT, "index.html"), "utf8")
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}\n</style>`)
  .replace('<script src="dist/bundle.js"></script>', () => `<script>\n${js}\n</script>`);

const out = path.join(WEB_ROOT, "dist", "predictor.html");
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${Math.round(html.length / 1024)} KB)`);
