/**
 * Tiny static file server for the built web app (no external dependencies -
 * this project intentionally keeps its devDependency list small). Serves
 * web/ (index.html, styles.css, dist/bundle.js) so `npm start` gives a real
 * local preview instead of the old, now-deleted src/index.ts CLI entry
 * point this used to run (removed along with the Bayesian engine - see
 * this app's relationship-based redesign).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const WEB_ROOT = path.join(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(WEB_ROOT, urlPath);

  // Never serve a path that escapes web/ (e.g. "..%2F..%2Fpackage.json").
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Mafia Predictor running at http://localhost:${PORT}/index.html`);
});
