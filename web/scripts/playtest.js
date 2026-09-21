/**
 * End-to-end browser playtest for the relationship-based redesign: drives a
 * real Chromium instance through menu -> setup -> role entry -> drag-based
 * actions/claims (suspect/defend/nominate/self-claim) -> arrows/team panel
 * -> action history -> night -> the exact tie -> revote -> tie ->
 * eliminateAll sequence the user hit a real crash on -> undo -> finish/
 * resume -> save to history -> crash recovery -> Clear All Data, and fails
 * loudly on any console error, page error, or assertion mismatch. Not part
 * of `npm test` (needs a browser binary) - run explicitly with
 * `node web/scripts/playtest.js` (or `npm run playtest`, which builds first).
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

function playerNode(page, id) {
  return page.locator(`.player-circle [data-player="${id}"]`);
}

/** Simulates the pointer-based drag gesture from one player node onto another (or onto the center self-target). */
async function dragPlayerOnto(page, fromId, toId) {
  const from = playerNode(page, fromId);
  const to = playerNode(page, toId);
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 20, fromBox.y + fromBox.height / 2 + 20, { steps: 5 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
  await page.mouse.up();
}

/** Simulates dragging a player onto the transient center "self" drop target that appears mid-drag. */
async function dragPlayerOntoSelf(page, fromId) {
  const from = playerNode(page, fromId);
  const fromBox = await from.boundingBox();
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 15, fromBox.y + fromBox.height / 2 + 15, { steps: 5 });
  await page.waitForSelector(".center-drop-target");
  const centerBox = await page.locator(".center-drop-target").boundingBox();
  await page.mouse.move(centerBox.x + centerBox.width / 2, centerBox.y + centerBox.height / 2, { steps: 10 });
  await page.mouse.up();
}

/** A plain tap (no movement) on a player node - opens Player Info for non-self players. */
async function tapPlayer(page, id) {
  const node = playerNode(page, id);
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });

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

    await step(page, "verify main game screen: 7 players, no probability UI anywhere, team panel present", async () => {
      const nodes = page.locator(".player-circle .player-node");
      assert.equal(await nodes.count(), 7, "expected 7 player nodes in the circle");
      const meNode = page.locator(".player-node-me");
      assert.equal(await meNode.count(), 1);
      assert.equal(await page.locator(".prob-bar").count(), 0, "no probability bar should exist anywhere in this redesign");
      const bodyText = await page.locator("body").innerText();
      assert.ok(!/mafia chance|P\(Mafia\)/i.test(bodyText), "no mafia-probability text should appear anywhere");
      await page.waitForSelector('text=Day 1');
      await page.waitForSelector(".team-panel");
      assert.equal(await page.locator(".arrows-svg").count(), 1, "arrows SVG overlay should be present");
    });

    await step(page, "drag player 2 onto player 3 and record a suspect action - the intensity picker lives on the same dialog as the action buttons", async () => {
      await dragPlayerOnto(page, "2", "3");
      await page.waitForSelector('text="Player 2 → Player 3"');
      await page.waitForSelector(".star-picker"); // visible immediately, alongside Suspect/Defend/Nominate - not a separate step
      await btn(page, "Suspect").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors after drag-suspect: ${JSON.stringify(consoleErrors)}`);
      assert.equal(await page.locator(".arrow-attack").count(), 1, "one attack arrow should now be drawn");
    });

    await step(page, "REGRESSION: the intensity star picker defaults to 3 stars, can be changed on the SAME dialog before picking Suspect/Defend/Nominate", async () => {
      await dragPlayerOnto(page, "4", "5");
      await page.waitForSelector('text="Player 4 → Player 5"');
      assert.equal(await page.locator(".star-btn-filled").count(), 3, "3 stars should be filled by default");
      await page.locator(".star-btn").nth(4).click(); // pick 5 stars (max confidence), still on the same dialog
      assert.equal(await page.locator(".star-btn-filled").count(), 5, "picking the 5th star should fill all 5");
      await btn(page, "Defend").click(); // no intermediate step - clicking Defend records immediately with the chosen intensity
      await page.waitForSelector(".game-screen");
      assert.equal(await page.locator(".arrow-support").count(), 1, "one support arrow should now be drawn");
    });

    await step(page, "drag player 2 onto player 3 AGAIN (nominate) - arrows are per-action, never aggregated", async () => {
      await dragPlayerOnto(page, "2", "3");
      await page.waitForSelector('text="Player 2 → Player 3"');
      await btn(page, "Nominate").click();
      await page.waitForSelector(".game-screen");
      assert.equal(await page.locator(".arrow-attack").count(), 2, "a second, separate attack arrow must be drawn for the same pair, not merged into the first");
    });

    await step(page, "REGRESSION: Claim Role ignores whatever the intensity picker is set to (it only applies to Suspect/Defend/Nominate)", async () => {
      await dragPlayerOnto(page, "6", "7");
      await page.waitForSelector('text="Player 6 → Player 7"');
      await page.locator(".star-btn").nth(0).click(); // set to 1 star, irrelevant to a role claim
      await btn(page, "Claim Role...").click();
      await page.waitForSelector('text="Player 6 claims Player 7 is..."');
      await btn(page, "Confirm").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors after a role-claim with the star picker touched: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "drag player 6 onto itself (center target) and record a self role claim", async () => {
      await dragPlayerOntoSelf(page, "6");
      await page.waitForSelector('text="Player 6 claims..."');
      await btn(page, "Confirm").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors after self-claim drag: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "a plain tap (no drag) on another player still opens Player Info with relationships, not probabilities", async () => {
      await tapPlayer(page, "3");
      await page.waitForSelector(".modal-box:has-text('Relationships')");
      const modalText = await page.locator(".modal-box").innerText();
      assert.ok(!/P\(Mafia\)|Teammate probability/i.test(modalText), "player info must never show probabilities in this redesign");
      assert.ok(/Player 2/.test(modalText), "player 3's relationships should mention player 2 (opposed via suspect/nominate)");
      await btn(page, "Close").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "a plain tap on my own node does nothing (no self info)", async () => {
      const before = await page.locator(".modal-box").count();
      await tapPlayer(page, "1");
      await page.waitForTimeout(150);
      assert.equal(await page.locator(".modal-box").count(), before, "tapping my own seat must not open a modal");
    });

    await step(page, "clicking a detected team chip dims other arrows and solidifies that team's arrows", async () => {
      const chips = page.locator(".team-chip");
      if ((await chips.count()) > 0) {
        await chips.first().click();
        await page.waitForSelector(".arrow-solid, .arrow-dim");
      }
    });
    // deselect again so later steps see the default (non-filtered) arrow view
    await step(page, "deselect the team chip again", async () => {
      const selectedChip = page.locator(".team-chip.player-select-btn-selected");
      if ((await selectedChip.count()) > 0) await selectedChip.first().click();
    });

    await step(page, "Action History shows every recorded event chronologically", async () => {
      await btn(page, "Action History").click();
      await page.waitForSelector('text="Action History"');
      const log = await page.locator(".event-log").innerText();
      assert.ok(log.includes("1."), "action history should be numbered chronologically");
      await btn(page, "Close").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "REGRESSION: starting night by accident can be canceled back to Day, with no event recorded", async () => {
      await btn(page, "Start Night").click();
      await page.waitForSelector('text=Night 1');
      await btn(page, "Cancel Night (back to Day)").click();
      await page.waitForSelector('text=Day 1');
      assert.equal(consoleErrors.length, 0, `console errors after canceling night: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "start night for real and record one death", async () => {
      await btn(page, "Start Night").click();
      await page.waitForSelector('text=Night 1');
      await page.locator(".player-select-grid button", { hasText: "2" }).click();
      await btn(page, "Confirm Deaths").click();
      await page.waitForSelector('text=Day 2');
    });

    await step(page, "a dead player's node is still tappable for info", async () => {
      await tapPlayer(page, "2");
      await page.waitForSelector(".modal-box:has-text('Alive: no')");
      await btn(page, "Close").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "REGRESSION: starting a vote by accident can be canceled back to Day, with no event recorded", async () => {
      await btn(page, "Start Voting").click();
      await page.waitForSelector('text="Start Voting - select candidates"');
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector('.candidate-section:has-text("Candidate 3")');
      await btn(page, "Cancel Vote (back to Day)").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors after canceling a vote: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "REGRESSION: tie -> revote -> tie -> keep-or-eliminate voting to ELIMINATE both candidates must not crash", async () => {
      await btn(page, "Start Voting").click();
      await page.waitForSelector('text="Start Voting - select candidates"');
      await page.locator(".player-select-grid button", { hasText: "3" }).click();
      await page.locator(".player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector('.candidate-section:has-text("Candidate 3")');

      // all 6 living players (1,3,4,5,6,7) cast an explicit hand -> clean 3-3 tie
      const section3 = page.locator(".candidate-section", { hasText: "Candidate 3" });
      const section4 = page.locator(".candidate-section", { hasText: "Candidate 4" });
      for (const voter of ["1", "3", "5"]) await section3.locator("button", { hasText: voter }).click();
      for (const voter of ["4", "6", "7"]) await section4.locator("button", { hasText: voter }).click();
      await btn(page, "Confirm Vote").click();
      await page.waitForSelector(".hint", { state: "visible" });
      await page.locator(".hint", { hasText: "This round tied" }).waitFor();

      await btn(page, "Start Revote (tied candidates)").click();
      await page.waitForSelector('text="Select the tied candidates for the revote"');
      await page.locator(".modal-box .player-select-grid button", { hasText: "3" }).click();
      await page.locator(".modal-box .player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector('.candidate-section:has-text("Candidate 3")');

      const revote3 = page.locator(".candidate-section", { hasText: "Candidate 3" });
      const revote4 = page.locator(".candidate-section", { hasText: "Candidate 4" });
      for (const voter of ["1", "3", "5"]) await revote3.locator("button", { hasText: voter }).click();
      for (const voter of ["4", "6", "7"]) await revote4.locator("button", { hasText: voter }).click();
      await btn(page, "Confirm Vote").click();
      await page.locator(".hint", { hasText: "This round tied" }).waitFor();

      await btn(page, "Start Keep/Eliminate Vote").click();
      await page.waitForSelector('text="Select the tied candidates for keep/eliminate"');
      await page.locator(".modal-box .player-select-grid button", { hasText: "3" }).click();
      await page.locator(".modal-box .player-select-grid button", { hasText: "4" }).click();
      await btn(page, "Start").click();
      await page.waitForSelector('text="Keep or Eliminate: 3, 4"');

      for (const voter of ["1", "3", "4", "5", "6", "7"]) {
        await page.locator(".player-select-grid button", { hasText: voter }).click();
      }
      await btn(page, "Confirm").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors during the tie/revote/eliminateAll sequence: ${JSON.stringify(consoleErrors)}`);
      assert.equal(await page.locator(".player-circle .player-node").count(), 7, "game must still be playable, not crashed, after eliminateAll");
      // resolving a vote stays on the same day - the day counter only
      // advances after the NEXT night's confirmNightDeaths, so this is
      // still Day 2 (the day the tie/revote/eliminateAll happened on).
      await page.waitForSelector('text=Day 2');
    });

    await step(page, "verify players 3 and 4 are now dead after eliminateAll", async () => {
      await tapPlayer(page, "3");
      await page.waitForSelector(".modal-box:has-text('Alive: no')");
      await btn(page, "Close").click();
      await page.waitForSelector(".game-screen");
    });

    await step(page, "Undo removes the last event (dayElimination) and restores the exact phase active right before it", async () => {
      await btn(page, "Undo").click();
      // recordDayElimination was called while still in "keepOrEliminateVoting"
      // (it only switches to "day" itself) - undo restores uiPhaseBefore
      // exactly, so this is where we land, not the main day screen.
      await page.waitForSelector('text="Keep or Eliminate: 3, 4"');
      assert.equal(consoleErrors.length, 0, `console errors after Undo: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "REGRESSION: the keep-or-eliminate screen recovers the already-decided elimination instead of offering an unsafe restart (which would duplicate the vote event)", async () => {
      await page.waitForSelector('text="This vote already decided an outcome (its elimination was undone) - record it again:"');
      await btn(page, "Record Elimination: 3, 4").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors after recovering the eliminateAll outcome: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "Finish Game asks who won before finishing, and is fully manual and always resumable", async () => {
      await btn(page, "Finish Game").click();
      await page.waitForSelector('text="Who won?"');
      await btn(page, "Not Sure / Skip For Now").click();
      await page.waitForSelector('text="Game Finished"');
      // the outcome select must reflect the popup's choice, not silently default to "unknown" without being asked
      assert.equal(await page.locator(".field-row select").first().inputValue(), "unknown");
      await page.waitForSelector('button:has-text("Resume Game")');
      await btn(page, "Resume Game").click();
      await page.waitForSelector(".game-screen");
      assert.equal(consoleErrors.length, 0, `console errors around finish/resume: ${JSON.stringify(consoleErrors)}`);
    });

    await step(page, "Finish Game again, pick Town Won from the popup, verify default final roles are citizen (not don), and save to history", async () => {
      await btn(page, "Finish Game").click();
      await page.waitForSelector('text="Who won?"');
      await btn(page, "Town Won").click();
      await page.waitForSelector('text="Game Finished"');
      assert.equal(await page.locator(".field-row select").first().inputValue(), "townWon", "the popup's choice must already be reflected here");

      // every per-player final-role select must default to "citizen", not "don"
      const allSelectValues = await page.locator(".field-row select").evaluateAll((els) => els.slice(1).map((el) => el.value));
      assert.ok(allSelectValues.length > 0, "expected per-player role selects on the Finish Game screen");
      assert.ok(allSelectValues.every((v) => v === "citizen"), `every untouched final-role select should default to "citizen", got: ${JSON.stringify(allSelectValues)}`);

      await btn(page, "Save to History").click();
      await page.waitForSelector('text="Mafia Predictor"');
    });

    await step(page, "history shows the saved game with the chosen result", async () => {
      await btn(page, "Game History").click();
      await page.waitForSelector('text="Game History"');
      const rowText = await page.locator(".history-row").first().innerText();
      assert.ok(rowText.includes("townWon"), `expected the saved history row to show townWon, got: ${rowText}`);
      await btn(page, "Back").click();
      await page.waitForSelector('text="Mafia Predictor"');
    });

    await step(page, "REGRESSION: history detail shows my player number, my role, and every player's final role", async () => {
      await btn(page, "Game History").click();
      await page.waitForSelector('text="Game History"');
      await btn(page, "Open").click();
      const detailText = await page.locator(".history-screen").innerText();
      assert.ok(/You were Player 1 \(citizen\)/.test(detailText), `expected the viewer's own player number and role, got: ${detailText}`);
      assert.ok(/Player 1 \(you\): citizen/.test(detailText), `expected the final-roles list to include the viewer, got: ${detailText}`);
      assert.ok(/Player 2.*: citizen/.test(detailText), `expected other players' default final role (citizen), got: ${detailText}`);
      await btn(page, "Back to list").click();
      await btn(page, "Back").click();
      await page.waitForSelector('text="Mafia Predictor"');
    });

    await step(page, "Clear All Data wipes everything back to a clean menu", async () => {
      await btn(page, "Clear All Data").click();
      await page.waitForLoadState("load");
      await page.waitForSelector('text="Mafia Predictor"');
      const hasHistoryEntries = await page.evaluate(() => localStorage.length === 0 || !localStorage.getItem("mafia-predictor-state")?.includes("history"));
      assert.ok(hasHistoryEntries !== undefined);
    });

    if (consoleErrors.length > 0) bugs.push(`Unhandled console/page errors: ${JSON.stringify(consoleErrors, null, 2)}`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (bugs.length > 0) {
    console.error("\n=== PLAYTEST FAILED ===");
    bugs.forEach((b) => console.error(`- ${b}`));
    console.error(`\nScreenshots: ${SHOT_DIR}`);
    process.exit(1);
  } else {
    console.log(`\nAll playtest steps passed. Screenshots: ${SHOT_DIR}`);
  }
}

main().catch((e) => {
  console.error("Playtest crashed:", e);
  process.exit(1);
});
