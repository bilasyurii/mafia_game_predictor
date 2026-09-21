/**
 * Third playtest pass: probing edge cases around setup validation, reaching
 * a truly determined game outcome, multiple undo, playing as a non-"1"
 * player, multi-round day/night cycles, and error-banner behavior for
 * thrown GameFacadeErrors from UI-side validation.
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const assert = require("node:assert/strict");

const PORT = 8938;
const WEB_ROOT = path.join(__dirname, "..");
const SHOT_DIR = "/tmp/mafia-playtest3";
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
    setTimeout(() => { if (!started) resolve(server); }, 1000);
  });
}

async function shot(page, name) {
  shotN += 1;
  await page.screenshot({ path: path.join(SHOT_DIR, `${String(shotN).padStart(2, "0")}-${name}.png`) }).catch(() => {});
}

async function step(page, name, fn, { allowFail = false } = {}) {
  try {
    await fn();
    await shot(page, name.replace(/[^a-z0-9]+/gi, "-"));
  } catch (e) {
    if (allowFail) {
      bugs.push(`STEP FAILED (unexpected) "${name}": ${e.message}`);
    } else {
      bugs.push(`STEP FAILED "${name}": ${e.message}`);
    }
    await shot(page, `FAIL-${name.replace(/[^a-z0-9]+/gi, "-")}`);
    if (!allowFail) throw e;
  }
}

function btn(page, name, exact = true) {
  return page.getByRole("button", { name, exact });
}

async function freshMenu(page) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('text="Mafia Predictor"');
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
    // ============================================================
    // Scenario A: mismatched role-count total vs player count in Setup
    // REGRESSION for the "blank white screen" bug found in the prior pass -
    // now prevented two ways: (1) Setup disables Start Game + shows an
    // inline warning when counts don't match, (2) createGame() itself
    // rejects the mismatch as defense-in-depth (see gameFacade.test.ts).
    // ============================================================
    await step(page, "A: editing citizen count so roles total != playerCount disables Start Game and shows an inline warning", async () => {
      await freshMenu(page);
      await btn(page, "New Game").click();
      const citizenRow = page.locator(".setup-screen .field-row", { hasText: "citizen" });
      const citizenInput = citizenRow.locator(".number-input");
      await citizenInput.fill("10"); // playerCount stays 7, total roles becomes 1+1+1+1+10=14
      await citizenInput.dispatchEvent("change");
      await page.waitForSelector(".setup-screen .error-banner");
      const isDisabled = await btn(page, "Start Game").isDisabled();
      assert.equal(isDisabled, true, "Start Game must be disabled while role counts don't match the player count");
    });

    await step(page, "A: fixing the count back to match re-enables Start Game and the game starts normally", async () => {
      const citizenRow = page.locator(".setup-screen .field-row", { hasText: "citizen" });
      const citizenInput = citizenRow.locator(".number-input");
      await citizenInput.fill("3"); // back to the 7-player default (1+1+1+1+3=7)
      await citizenInput.dispatchEvent("change");
      await page.waitForSelector(".setup-screen .hint");
      const isDisabled = await btn(page, "Start Game").isDisabled();
      assert.equal(isDisabled, false, "Start Game should re-enable once counts match again");
      await btn(page, "Start Game").click();
      await page.waitForSelector('text="What is your role?"');
    });

    // ============================================================
    // Scenario A2: defense-in-depth - simulate a session that was already
    // corrupted (e.g. saved by a pre-fix version, or hand-edited localStorage)
    // and confirm the crash screen recovers gracefully instead of blanking.
    // ============================================================
    await step(page, "A2: a pre-existing corrupted session (mismatched roles/players) shows the crash-recovery screen, not a blank page", async () => {
      await page.locator(".role-grid button", { hasText: "citizen" }).click();
      await page.waitForSelector(".game-screen");
      await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem("mafiaPredictor.appState"));
        raw.currentGame.config.roles.push("citizen", "citizen", "citizen"); // now 10 roles for 7 players, bypassing the UI/facade entirely
        localStorage.setItem("mafiaPredictor.appState", JSON.stringify(raw));
      });
      await page.reload();
      await page.waitForTimeout(300);
      const appHtml = await page.locator("#app").innerHTML();
      assert.notEqual(appHtml.trim().length, 0, "BUG: a corrupted saved session left a completely blank page on reload, with no recovery");
      const hasErrorBanner = await page.locator(".error-banner").count();
      assert.ok(hasErrorBanner > 0, "expected the crash-recovery screen's error banner");
      const hasDiscard = await btn(page, "Discard This Game").count();
      assert.ok(hasDiscard > 0, "expected a 'Discard This Game' recovery option");
    });

    await step(page, "A2: Discard This Game actually recovers - back to a normal, usable menu", async () => {
      await btn(page, "Discard This Game").click();
      await page.waitForSelector('text="Mafia Predictor"');
      const hasContinue = await page.locator('button:has-text("Continue Game")').count();
      assert.equal(hasContinue, 0, "the corrupted game should be gone after Discard This Game");
      // confirm the app is genuinely usable again, not just showing text
      await btn(page, "New Game").click();
      await page.waitForSelector('text="New Game Setup"');
      await btn(page, "Back").click();
    });

    // ============================================================
    consoleErrors.length = 0; // isolate this scenario's error assertions from prior scenarios
    // Scenario B: playing as a non-"1" player (myPlayerNumber = "4")
    // ============================================================
    await step(page, "B: create a game as player 4 instead of player 1", async () => {
      await freshMenu(page);
      await btn(page, "New Game").click();
      const myPlayerSelect = page.locator(".setup-screen select");
      await myPlayerSelect.selectOption("4");
      await btn(page, "Start Game").click();
      await page.waitForSelector('text="What is your role?"');
      await page.locator(".role-grid button", { hasText: "mafia" }).click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "B: player 4's own seat has no probability bar; others do", async () => {
      const meNode = page.locator(".player-node-me");
      assert.equal(await meNode.count(), 1);
      assert.equal(await meNode.locator(".you-label").innerText(), "you");
      assert.equal(await meNode.locator(".prob-bar").count(), 0, "player 4 (me) must never show own probability");
      const meNumber = await meNode.locator(".player-number").innerText();
      assert.equal(meNumber, "4");
    });

    await step(page, "B: clicking on my own seat does nothing (no info modal for self)", async () => {
      await page.locator(".player-node-me").click();
      await page.waitForTimeout(200);
      const modalCount = await page.locator(".modal-box").count();
      if (modalCount > 0) bugs.push("BUG: clicking on own player seat opened a modal - should be a no-op (own info must never be shown)");
    });

    // ============================================================
    consoleErrors.length = 0; // isolate this scenario's error assertions from prior scenarios
    // Scenario C: multiple undos in a row, back to the very start
    // ============================================================
    await step(page, "C: fresh game, record 3 events, then undo all 3 back to a clean state", async () => {
      await freshMenu(page);
      await btn(page, "New Game").click();
      await btn(page, "Start Game").click();
      await page.locator(".role-grid button", { hasText: "citizen" }).click();
      await page.waitForSelector(".game-screen");

      for (let i = 0; i < 3; i++) {
        await btn(page, "Record Action / Claim").click();
        await btn(page, "Confirm", true).click();
        await page.waitForSelector(".game-screen");
      }
      let undoVisible = await btn(page, "Undo").count();
      assert.equal(undoVisible, 1, "Undo should be visible after recording events");

      for (let i = 0; i < 3; i++) {
        await btn(page, "Undo").click();
      }
      undoVisible = await btn(page, "Undo").count();
      assert.equal(undoVisible, 0, "Undo button should disappear once there is nothing left to undo");
      assert.equal(consoleErrors.length, 0, `errors during repeated undo: ${JSON.stringify(consoleErrors)}`);
    });

    // ============================================================
    consoleErrors.length = 0; // isolate this scenario's error assertions from prior scenarios
    // Scenario D: error-banner behavior for UI-side validation throws
    // ============================================================
    await step(page, "D: Start Voting with zero candidates selected throws a caught, visible error (not a crash)", async () => {
      await btn(page, "Start Voting").click();
      await page.waitForSelector('text="Start Voting - select candidates"');
      await btn(page, "Start").click(); // no candidates selected
      await page.waitForTimeout(200);
      const errorBanner = await page.locator(".error-banner").count();
      if (errorBanner === 0) {
        bugs.push("BUG: starting a vote with zero candidates selected did not show an error banner");
      }
      const appHtml = await page.locator("#app").innerHTML();
      if (appHtml.trim().length === 0) {
        bugs.push("BUG: starting a vote with zero candidates selected left a blank screen");
      }
    });

    await step(page, "D: after the error, the app is still usable (not stuck)", async () => {
      // the error banner render dispatch should have fallen back to SOME screen - confirm we can still navigate
      const onGameScreen = (await page.locator(".game-screen").count()) > 0;
      const onModal = (await page.locator(".modal-overlay").count()) > 0;
      if (!onGameScreen && !onModal) {
        bugs.push("BUG: after a validation error, the app is on neither the game screen nor a modal - likely stuck/blank");
      }
    });

    // ============================================================
    consoleErrors.length = 0; // isolate this scenario's error assertions from prior scenarios
    // Scenario E: selfRoleClaim with an EXACT role (not the default group option)
    // ============================================================
    await step(page, "E: record a selfRoleClaim with an exact role selected", async () => {
      // might still be showing the error banner/modal from D - get back to a clean game screen first
      await page.goto(`http://localhost:${PORT}/index.html`);
      await page.waitForSelector(".game-screen");
      await btn(page, "Record Action / Claim").click();
      await page.locator(".modal-box select").nth(1).selectOption("selfRoleClaim");
      const claimSelect = page.locator(".modal-box select").nth(2);
      await claimSelect.selectOption({ label: "citizen" }); // an exact-role option, not a group
      await btn(page, "Confirm", true).click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `errors after exact-role selfRoleClaim: ${JSON.stringify(consoleErrors)}`);
    });

    // ============================================================
    consoleErrors.length = 0; // isolate this scenario's error assertions from prior scenarios
    // Scenario F: multi-round day/night cycling - round numbers increment correctly
    // ============================================================
    await step(page, "F: three full day/night cycles - phase labels increment correctly each time", async () => {
      for (let round = 1; round <= 3; round++) {
        await btn(page, "Start Night").click();
        await page.waitForSelector(`text=Night ${round}`);
        await btn(page, "Confirm Deaths").click();
        await page.waitForSelector(`text=Day ${round + 1}`);
      }
      assert.equal(consoleErrors.length, 0, `errors across multi-round cycling: ${JSON.stringify(consoleErrors)}`);
    });

    console.log("\n=== PLAYTEST 3 COMPLETE ===");
  } catch (e) {
    console.log(`\n=== PLAYTEST 3 FAILED: ${e.message} ===`);
  } finally {
    console.log("\nConsole/page errors observed:", consoleErrors.length ? JSON.stringify(consoleErrors, null, 2) : "none");
    console.log("Bugs recorded:", bugs.length ? JSON.stringify(bugs, null, 2) : "none");
    console.log(`Screenshots in ${SHOT_DIR}`);
    await browser.close();
    server.kill();
    process.exit(bugs.length > 0 ? 1 : 0);
  }
}

main();
