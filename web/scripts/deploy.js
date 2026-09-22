/**
 * Uploads the built web app (web/index.html, web/styles.css,
 * web/dist/bundle.js) to the FTP host configured in the repo root's .env
 * (see example.env for the expected keys). Only ever PUTs those exact
 * three files into FTP_REMOTE_DIR - it never lists, clears, or deletes
 * anything already there, so an existing sibling folder (e.g. a previous
 * "v1" release) is left completely untouched.
 *
 * Requires the system `curl` binary (present by default on macOS/Linux).
 * Run via `npm run deploy:web` (builds first) or directly with
 * `node web/scripts/deploy.js` once web/dist/bundle.js already exists.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const WEB_ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  fs.readFileSync(filePath, "utf8")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    });
  return env;
}

// Real environment variables (if set) win over .env file values, matching
// standard dotenv-style precedence.
const env = { ...loadEnvFile(ENV_PATH), ...process.env };

const REQUIRED_KEYS = ["FTP_HOST", "FTP_PORT", "FTP_USER", "FTP_PASSWORD", "FTP_REMOTE_DIR"];
const missing = REQUIRED_KEYS.filter((key) => !env[key]);
if (missing.length > 0) {
  console.error(`Missing required setting(s) in .env: ${missing.join(", ")}`);
  console.error("Copy example.env to .env (repo root) and fill in your real FTP details first.");
  process.exit(1);
}

const host = env.FTP_HOST.replace(/^ftps?:\/\//, "").replace(/\/+$/, "");
const port = env.FTP_PORT;
const user = encodeURIComponent(env.FTP_USER);
const password = encodeURIComponent(env.FTP_PASSWORD);
const remoteDir = env.FTP_REMOTE_DIR.replace(/^\/+/, "").replace(/\/+$/, "");
const baseUrl = `ftp://${user}:${password}@${host}:${port}/${remoteDir}/`;

// Local path (relative to web/) for every file this uploads.
const FILES = ["index.html", "styles.css", path.join("dist", "bundle.js")];

FILES.forEach((relativePath) => {
  const localPath = path.join(WEB_ROOT, relativePath);
  if (!fs.existsSync(localPath)) {
    console.error(`Missing local file: ${localPath} - run "npm run build:web" first.`);
    process.exit(1);
  }

  const remotePath = relativePath.split(path.sep).join("/");
  const targetUrl = baseUrl + remotePath;
  console.log(`Uploading ${relativePath} -> ${targetUrl.replace(password, "***")}`);

  try {
    // stderr is captured (not inherited) so curl's own error text can be
    // redacted before it's printed - node's thrown error otherwise embeds
    // the full argv (including the real, unredacted password in
    // targetUrl) in its own .message.
    execFileSync("curl", ["--silent", "--show-error", "--fail", "--ftp-create-dirs", "-T", localPath, targetUrl], { stdio: ["inherit", "inherit", "pipe"] });
  } catch (e) {
    const raw = e && e.stderr ? e.stderr.toString() : e instanceof Error ? e.message : String(e);
    const redacted = env.FTP_PASSWORD ? raw.split(env.FTP_PASSWORD).join("***") : raw;
    console.error(`Failed to upload ${relativePath}: ${redacted.trim()}`);
    process.exit(1);
  }
});

console.log("Deploy complete.");
