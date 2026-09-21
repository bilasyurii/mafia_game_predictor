/**
 * End-to-end browser playtest: drives a real Chromium instance through a
 * full game (menu -> setup -> role entry -> day actions -> night ->
 * voting, including the exact duplicate-vote scenario that used to crash
 * the app -> back-to-menu/continue -> reload persistence -> finish game ->
 * history) against the actual built static site, and fails loudly on any
 * console error, page error, or assertion mismatch. Not part of `npm test`
 * (needs a browser binary) - run explicitly with `node web/scripts/playtest.js`.
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const assert = require("node:assert/strict");

const PORT = 8935;
const WEB_ROOT = path.join(__dirname, "..");
const SHOT_DIR = "/tmp/mafia-playtest";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const consoleErrors = [];
const bugs = [];
let shotN = 0;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: WEB_ROOT });
    let started = false;
    server.stderr.on("data", (d) => {
      if (!started && d.toString().includes("Serving HTTP")) {
        started = true;
        resolve(server);
      }
    });
    server.on("error", reject);
    setTimeout(() => {
      if (!started) resolve(server);
    }, 1000);
  });
}

async function shot(page, name) {
  shotN += 1;
  const file = path.join(SHOT_DIR, `${String(shotN).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
}

async function step(page, name, fn) {
  try {
    await fn();
    await shot(page, name.replace(/[^a-z0-9]+/gi, "-"));
  } catch (e) {
    bugs.push(`STEP FAILED "${name}": ${e.message}`);
    await shot(page, `FAIL-${name.replace(/[^a-z0-9]+/gi, "-")}`);
    throw e;
  }
}

function btn(page, name, exact = true) {
  return page.getByRole("button", { name, exact });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("dialog", (dialog) => dialog.accept());

  try {
    await step(page, "load menu", async () => {
      await page.goto(`http://localhost:${PORT}/index.html`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForSelector('text="Mafia Predictor"');
    });

    await step(page, "open setup", async () => {
      await btn(page, "New Game").click();
      await page.waitForSelector('text="New Game Setup"');
    });

    await step(page, "start game with default 7-player setup", async () => {
      await btn(page, "Start Game").click();
      await page.waitForSelector('text="What is your role?"');
    });

    await step(page, "pick my role (citizen)", async () => {
      await page.locator(".role-grid button", { hasText: "citizen" }).click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "verify main game screen renders 7 players with no own probability", async () => {
      const nodes = page.locator(".player-circle .player-node");
      assert.equal(await nodes.count(), 7, "expected 7 player nodes in the circle");
      const meNode = page.locator(".player-node-me");
      assert.equal(await meNode.count(), 1);
      assert.equal(await meNode.locator(".prob-bar").count(), 0, "own player must never show a probability bar");
      await page.waitForSelector('text=Day 1');
    });

    await step(page, "record a suspect action", async () => {
      await btn(page, "Record Action / Claim").click();
      await page.waitForSelector('text="Record Action / Claim"');
      // defaults: actor=first alive (not necessarily "2"), action=suspect, target=first alive - just confirm as-is
      await btn(page, "Confirm").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "record a selfRoleClaim (group claim)", async () => {
      await btn(page, "Record Action / Claim").click();
      await page.locator(".modal-box select").nth(1).selectOption("selfRoleClaim");
      await btn(page, "Confirm").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "open and close player info modal for a living player", async () => {
      await page.locator(".player-circle .player-node:not(.player-node-me)").first().click();
      await page.waitForSelector(".modal-box:has-text('P(Mafia)')");
      await btn(page, "Close").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "start night and record one death", async () => {
      await btn(page, "Start Night").click();
      await page.waitForSelector('text=Night 1');
      // select player "2" as dead
      await page.locator(".player-select-grid button", { hasText: "2" }).click();
      await btn(page, "Confirm Deaths").click();
      await page.waitForSelector('text=Day 2');
    });

    await step(page, "verify dead player is still clickable for info", async () => {
      const deadNode = page.locator(".player-node-dead:not(.player-node-me)").first();
      await deadNode.click();
      await page.waitForSelector(".modal-box:has-text('Alive: no')");
      await btn(page, "Close").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "start voting with candidates 3 and 4", async () => {
      await btn(page, "Start Voting").click();
      await page.waitForSelector('text="Start Voting - select candidates"');
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await page.locator(".player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector('.candidate-section:has-text("Candidate 3")');
    });

    await step(page, "REGRESSION: assign voter 1 to candidate 3, then move to candidate 4 - must move, not duplicate", async () => {
      const section3 = page.locator(".candidate-section", { hasText: "Candidate 3" });
      const section4 = page.locator(".candidate-section", { hasText: "Candidate 4" });
      await section3.locator("button", { hasText: "1" }).click();
      await page.waitForSelector(".candidate-section button.player-select-btn-selected");
      let selectedIn3 = await section3.locator("button.player-select-btn-selected", { hasText: "1" }).count();
      assert.equal(selectedIn3, 1, "voter 1 should be selected under candidate 3 after first click");

      // now click voter 1 under candidate 4 WITHOUT deselecting from 3 first - the exact original crash scenario
      await section4.locator("button", { hasText: "1" }).click();
      selectedIn3 = await section3.locator("button.player-select-btn-selected", { hasText: "1" }).count();
      const selectedIn4 = await section4.locator("button.player-select-btn-selected", { hasText: "1" }).count();
      assert.equal(selectedIn3, 0, "voter 1 must be REMOVED from candidate 3 after voting for candidate 4");
      assert.equal(selectedIn4, 1, "voter 1 must now be selected under candidate 4");
      assert.equal(consoleErrors.length, 0, `expected no console errors after the move, got: ${JSON.stringify(consoleErrors)}`);

      // move voter 1 back to candidate 3 for the final tally we actually want
      await section3.locator("button", { hasText: "1" }).click();
    });

    await step(page, "finish assigning hands: 3 gets {1,4,5,6}, 4 gets {7}, voter 3 abstains", async () => {
      const section3 = page.locator(".candidate-section", { hasText: "Candidate 3" });
      const section4 = page.locator(".candidate-section", { hasText: "Candidate 4" });
      for (const voter of ["4", "5", "6"]) {
        await section3.locator("button", { hasText: voter }).click();
      }
      await section4.locator("button", { hasText: "7" }).click();
    });

    await step(page, "confirm vote - candidate 3 should win outright (no tie)", async () => {
      await btn(page, "Confirm Vote").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors during vote confirmation: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "back to menu mid-game keeps the session (Continue Game appears)", async () => {
      await btn(page, "Back to Menu").click();
      await page.waitForSelector('text="Mafia Predictor"');
      await page.waitForSelector('button:has-text("Continue Game")');
    });

    await step(page, "continue game resumes exactly where we left off", async () => {
      await btn(page, "Continue Game").click();
      await page.waitForSelector(".game-screen");
      await page.waitForSelector('text=Day 2');
    });

    await step(page, "reload mid-game: state survives a real page refresh", async () => {
      await page.reload();
      await page.waitForSelector(".game-screen");
      await page.waitForSelector('text=Day 2');
    });

    await step(page, "finish game and verify winner selector is present and editable even from 'unknown'", async () => {
      await btn(page, "Finish Game").click();
      await page.waitForSelector('text="Game Finished"');
      const resultSelect = page.locator(".field-row", { hasText: "Result" }).locator("select");
      await page.waitForSelector(".field-row select");
      await resultSelect.selectOption("townWon");
      const value = await resultSelect.inputValue();
      assert.equal(value, "townWon", "winner selector must accept an explicit override");
    });

    await step(page, "fill final roles and save to history", async () => {
      const roleSelects = page.locator(".finish-screen .field-row select");
      const count = await roleSelects.count();
      // index 0 is the outcome ("Result") select, already set above - only the rest are per-player final-role selects.
      for (let i = 1; i < count; i++) {
        await roleSelects.nth(i).selectOption({ index: 0 });
      }
      await btn(page, "Save to History").click();
      await page.waitForSelector('text="Mafia Predictor"');
    });

    await step(page, "open saved game in history and verify it recorded townWon", async () => {
      await btn(page, "Game History").click();
      await page.waitForSelector(".history-row");
      await btn(page, "Open").first().click();
      await page.waitForSelector('text=townWon');
    });

    console.log("\n=== PLAYTEST PASSED: all steps completed ===");
  } catch (e) {
    console.log(`\n=== PLAYTEST FAILED: ${e.message} ===`);
  } finally {
    console.log("\nConsole/page errors observed:", consoleErrors.length ? JSON.stringify(consoleErrors, null, 2) : "none");
    console.log("Bugs recorded:", bugs.length ? JSON.stringify(bugs, null, 2) : "none");
    console.log(`Screenshots in ${SHOT_DIR}`);
    await browser.close();
    server.kill();
    process.exit(bugs.length > 0 || consoleErrors.length > 0 ? 1 : 0);
  }
}

main();
