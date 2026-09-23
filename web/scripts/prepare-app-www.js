/**
 * Prepares the folder Capacitor packages into the Android app: web/www/index.html
 * is the self-contained single-file build (see build-single-file.js).
 */
const fs = require("fs");
const path = require("path");

const WEB_ROOT = path.join(__dirname, "..");
const outDir = path.join(WEB_ROOT, "www");
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(WEB_ROOT, "dist", "predictor.html"), path.join(outDir, "index.html"));
console.log(`Wrote ${path.join(outDir, "index.html")}`);
