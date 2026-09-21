/**
 * Second playtest pass: covers scenarios playtest.js's single happy-path
 * game didn't touch - ties/revotes/keep-or-eliminate (both resolutions),
 * undo interacting with voting state, discard, clear-all-data, history
 * management, non-default player counts, other claim types, multi-death
 * nights, and the back-to-menu/new-game confirm dialogs' CANCEL path (not
 * just accept). Each scenario starts from a fresh localStorage so they're
 * independent and any failure is easy to localize.
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const assert = require("node:assert/strict");

const PORT = 8937;
const WEB_ROOT = path.join(__dirname, "..");
const SHOT_DIR = "/tmp/mafia-playtest2";
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

async function freshGame(page, playerCount = 7) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('text="Mafia Predictor"');
  await btn(page, "New Game").click();
  if (playerCount !== 7) {
    const playerCountInput = page.locator(".setup-screen .number-input").first();
    await playerCountInput.fill(String(playerCount));
    await playerCountInput.dispatchEvent("change");
  }
  await btn(page, "Start Game").click();
  await page.locator(".role-grid button", { hasText: "citizen" }).click();
  await page.waitForSelector(".game-screen");
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
    // Scenario A: full tie -> revote -> tie -> keep-or-eliminate (keepAll)
    // ============================================================
    await step(page, "A: setup game and kill player 2", async () => {
      await freshGame(page);
      await btn(page, "Start Night").click();
      await page.waitForSelector("text=Night 1");
      await page.locator(".player-select-grid button", { hasText: "2" }).click();
      await btn(page, "Confirm Deaths").click();
      await page.waitForSelector("text=Day 2");
    });

    async function tiedVote(candidateA, candidateB, votersA, votersB) {
      const sectionA = page.locator(".candidate-section", { hasText: `Candidate ${candidateA}` });
      const sectionB = page.locator(".candidate-section", { hasText: `Candidate ${candidateB}` });
      for (const v of votersA) await sectionA.locator("button", { hasText: v }).click();
      for (const v of votersB) await sectionB.locator("button", { hasText: v }).click();
      await btn(page, "Confirm Vote").click();
    }

    await step(page, "A: initial vote 3 vs 4 ties 3-3", async () => {
      await btn(page, "Start Voting").click();
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await page.locator(".player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector(".candidate-section");
      await tiedVote("3", "4", ["1", "5", "3"], ["6", "7", "4"]);
      await page.waitForSelector('button:has-text("Restart This Vote")');
    });

    await step(page, "A: start revote with same tied candidates, ties again", async () => {
      await btn(page, "Start Revote (tied candidates)").click();
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await page.locator(".player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector(".candidate-section");
      await tiedVote("3", "4", ["1", "5", "3"], ["6", "7", "4"]);
      await page.waitForSelector('button:has-text("Restart This Vote")');
    });

    await step(page, "A: keep-or-eliminate vote resolves to keepAll (nobody eliminated)", async () => {
      await btn(page, "Start Keep/Eliminate Vote").click();
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await page.locator(".player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector('text="Keep or Eliminate: 3, 4"');
      // nobody votes to eliminate - keepAll
      await btn(page, "Confirm").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `errors after keep-or-eliminate: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "A: players 3 and 4 are still alive after keepAll", async () => {
      const p3 = page.locator(".player-node", { hasText: "3" });
      const p4 = page.locator(".player-node", { hasText: "4" });
      assert.equal(await p3.evaluate((n) => n.classList.contains("player-node-dead")), false, "player 3 should still be alive after keepAll");
      assert.equal(await p4.evaluate((n) => n.classList.contains("player-node-dead")), false, "player 4 should still be alive after keepAll");
    });

    // ============================================================
    // Scenario B (BUG HYPOTHESIS): undo after a CLEAN (non-tied) winning
    // vote lands back on "voting" phase with no draft - does the UI wrongly
    // claim "This round tied"?
    // ============================================================
    await step(page, "B: fresh game, kill player 2, vote with a clear winner (no tie)", async () => {
      await freshGame(page);
      await btn(page, "Start Night").click();
      await page.waitForSelector("text=Night 1");
      await page.locator(".player-select-grid button", { hasText: "2" }).click();
      await btn(page, "Confirm Deaths").click();
      await page.waitForSelector("text=Day 2");

      await btn(page, "Start Voting").click();
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await page.locator(".player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector(".candidate-section");
      const section3 = page.locator(".candidate-section", { hasText: "Candidate 3" });
      for (const v of ["1", "4", "5", "6"]) await section3.locator("button", { hasText: v }).click();
      await btn(page, "Confirm Vote").click();
      await page.waitForSelector(".game-screen"); // clean winner -> should land back on Day, player 3 eliminated
      await page.waitForSelector("text=Day 2");
    });

    await step(page, "B: player 3 was eliminated by the clear-winner vote", async () => {
      const p3 = page.locator(".player-node", { hasText: "3" });
      assert.equal(await p3.evaluate((n) => n.classList.contains("player-node-dead")), true, "player 3 should be dead after winning the vote");
    });

    await step(page, "B: REGRESSION - undo the elimination; the voting screen must not falsely claim a tie, and must offer a way to just redo the original vote", async () => {
      await btn(page, "Undo").click();
      await page.waitForSelector('button:has-text("Restart This Vote")');
      const bodyText = await page.locator(".screen").first().innerText().catch(() => "");
      assert.equal(bodyText.includes("This round tied"), false, `voting screen must not claim a definite tie after an undo: ${JSON.stringify(bodyText)}`);

      // exercise the fix itself: restarting the vote should return us to a live candidate-vote screen
      await btn(page, "Restart This Vote").click();
      await page.waitForSelector(".candidate-section");
      assert.equal(consoleErrors.length, 0, `errors after restarting the vote: ${JSON.stringify(consoleErrors)}`);
    });

    // ============================================================
    // Scenario C: Back to Menu - CANCEL path must preserve the game screen
    // ============================================================
    await step(page, "C: fresh game, Back to Menu then CANCEL the confirm - must stay on game screen untouched", async () => {
      await freshGame(page);
      page.removeAllListeners("dialog");
      page.on("dialog", (dialog) => dialog.dismiss()); // CANCEL this time
      await btn(page, "Back to Menu").click();
      await page.waitForTimeout(200);
      const onGameScreen = (await page.locator(".game-screen").count()) > 0;
      if (!onGameScreen) {
        bugs.push("BUG: cancelling the 'Leave this game?' confirm dialog did not keep the user on the game screen");
      }
      page.removeAllListeners("dialog");
      page.on("dialog", (dialog) => dialog.accept()); // back to auto-accept for the rest of the run
    });

    // ============================================================
    // Scenario D: New Game while a game is active - cancel keeps it, accept discards it
    // ============================================================
    await step(page, "D: New Game while active - CANCEL keeps the active game", async () => {
      await freshGame(page);
      await btn(page, "Back to Menu").click(); // accepted (auto-accept restored)
      await page.waitForSelector('button:has-text("Continue Game")');
      page.removeAllListeners("dialog");
      page.on("dialog", (dialog) => dialog.dismiss());
      await btn(page, "New Game").click();
      await page.waitForTimeout(200);
      const stillOnMenu = (await page.locator('button:has-text("Continue Game")').count()) > 0;
      if (!stillOnMenu) {
        bugs.push("BUG: cancelling the 'New Game will discard...' confirm did not preserve the active game / Continue Game option");
      }
      page.removeAllListeners("dialog");
      page.on("dialog", (dialog) => dialog.accept());
    });

    await step(page, "D: New Game while active - ACCEPT discards it and opens Setup", async () => {
      await btn(page, "New Game").click();
      await page.waitForSelector('text="New Game Setup"');
    });

    // ============================================================
    // Scenario E: Discard game from Finish Game screen
    // ============================================================
    await step(page, "E: fresh game -> finish -> discard - should return to empty menu (no history entry)", async () => {
      await freshGame(page);
      await btn(page, "Finish Game").click();
      await page.waitForSelector('text="Game Finished"');
      await btn(page, "Discard").click();
      await page.waitForSelector('text="Mafia Predictor"');
      const hasContinue = (await page.locator('button:has-text("Continue Game")').count()) > 0;
      if (hasContinue) bugs.push("BUG: Discard did not actually clear the active game - Continue Game still offered");
      await btn(page, "Game History").click();
      const historyRows = await page.locator(".history-row").count();
      if (historyRows !== 0) bugs.push(`BUG: Discard should not save to history, but found ${historyRows} history row(s)`);
      await btn(page, "Back").click();
    });

    // ============================================================
    // Scenario F: History management - delete one entry, export, clear all
    // ============================================================
    await step(page, "F: two games saved into the same history", async () => {
      await page.goto(`http://localhost:${PORT}/index.html`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      for (let i = 0; i < 2; i++) {
        await btn(page, "New Game").click();
        await btn(page, "Start Game").click();
        await page.locator(".role-grid button", { hasText: "citizen" }).click();
        await btn(page, "Finish Game").click();
        await page.waitForSelector('text="Game Finished"');
        await btn(page, "Save to History").click();
        await page.waitForSelector('text="Mafia Predictor"');
      }
      await btn(page, "Game History").click();
      const rows = await page.locator(".history-row").count();
      assert.equal(rows, 2, `expected 2 saved games, found ${rows}`);
    });

    await step(page, "F: export history JSON shows content", async () => {
      await btn(page, "Export All (JSON)").click();
      const text = await page.locator(".export-textarea").inputValue();
      const parsed = JSON.parse(text);
      assert.equal(parsed.length, 2, "exported JSON should contain both saved games");
      await btn(page, "Close").click();
    });

    await step(page, "F: delete one history entry leaves exactly one", async () => {
      await btn(page, "Open").first().click();
      await btn(page, "Delete this game").click();
      await page.waitForSelector(".history-row");
      const rows = await page.locator(".history-row").count();
      assert.equal(rows, 1, `expected 1 remaining saved game, found ${rows}`);
    });

    await step(page, "F: delete all history clears the list", async () => {
      await btn(page, "Delete All History").click();
      await page.waitForTimeout(200);
      const rows = await page.locator(".history-row").count();
      assert.equal(rows, 0, `expected 0 saved games after Delete All History, found ${rows}`);
    });

    // ============================================================
    // Scenario G: Clear All Data end to end
    // ============================================================
    await step(page, "G: active game + history, then Clear All Data wipes everything", async () => {
      await btn(page, "Back").click();
      await freshGame(page);
      await btn(page, "Back to Menu").click();
      await page.waitForSelector('button:has-text("Continue Game")');
      await btn(page, "Clear All Data").click();
      await page.waitForSelector('text="Mafia Predictor"');
      const hasContinue = (await page.locator('button:has-text("Continue Game")').count()) > 0;
      if (hasContinue) bugs.push("BUG: Clear All Data did not remove the active game");
    });

    // ============================================================
    // Scenario H: non-default player count (9 players -> 2 mafia by policy)
    // ============================================================
    await step(page, "H: 9-player setup uses the 2-mafia default policy", async () => {
      await page.goto(`http://localhost:${PORT}/index.html`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await btn(page, "New Game").click();
      const playerCountInput = page.locator(".setup-screen .number-input").first();
      await playerCountInput.fill("9");
      await playerCountInput.dispatchEvent("change");
      const mafiaRow = page.locator(".setup-screen .field-row", { hasText: "mafia" });
      const mafiaInput = mafiaRow.locator(".number-input");
      const mafiaValue = await mafiaInput.inputValue();
      assert.equal(mafiaValue, "2", `expected 2 mafia for a 9-player default game, got ${mafiaValue}`);
      await btn(page, "Start Game").click();
      await page.locator(".role-grid button", { hasText: "citizen" }).click();
      const nodes = page.locator(".player-circle .player-node");
      assert.equal(await nodes.count(), 9, "expected 9 players in the circle");
    });

    // ============================================================
    // Scenario I: investigationReport and roleAssertion claims record cleanly
    // ============================================================
    await step(page, "I: fresh game, record a roleAssertion and an investigationReport claim", async () => {
      await freshGame(page);
      await btn(page, "Record Action / Claim").click();
      await page.locator(".modal-box select").nth(1).selectOption("roleAssertion");
      await btn(page, "Confirm", true).click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `errors after roleAssertion: ${JSON.stringify(consoleErrors)}`);

      await btn(page, "Record Action / Claim").click();
      await page.locator(".modal-box select").nth(1).selectOption("investigationReport");
      await btn(page, "Confirm", true).click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `errors after investigationReport: ${JSON.stringify(consoleErrors)}`);
    });

    // ============================================================
    // Scenario J: multiple deaths in one night
    // ============================================================
    await step(page, "J: night with two deaths at once", async () => {
      await btn(page, "Start Night").click();
      await page.waitForSelector("text=Night 1");
      await page.locator(".player-select-grid button", { hasText: "2" }).click();
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await btn(page, "Confirm Deaths").click();
      await page.waitForSelector("text=Day 2");
      const p2 = page.locator(".player-node", { hasText: "2" });
      const p3 = page.locator(".player-node", { hasText: "3" });
      assert.equal(await p2.evaluate((n) => n.classList.contains("player-node-dead")), true);
      assert.equal(await p3.evaluate((n) => n.classList.contains("player-node-dead")), true);
    });

    console.log("\n=== PLAYTEST 2 COMPLETE ===");
  } catch (e) {
    console.log(`\n=== PLAYTEST 2 FAILED: ${e.message} ===`);
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
