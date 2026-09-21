import { LocalStorageAdapter } from "./storageAdapter";
import { GameFacadeError, MafiaPredictorFacade } from "../../src/app/gameFacade";
import { CandidateVoteDraft, RoleCounts, defaultRoleCountsForPlayerCount } from "../../src/app/types";
import { buildGameScreenViewModel, buildHistoryListViewModel, buildRoleEntryViewModel } from "../../src/web/viewModel";
import { assignVoterHands, dedupeHandsRaised, handsRaisedHasDuplicateVoter, voterAssignments } from "../../src/web/votingDraftHelpers";
import { PlayerId, RoleExpression, RoleId } from "../../src/types";

/**
 * The one file in this application that touches the DOM. Every decision
 * about WHAT to show comes from the facade (src/app/gameFacade.ts) or the
 * pure view-model builders (src/web/viewModel.ts) - this file only turns
 * that data into elements and routes clicks back into facade calls. No
 * Bayesian/world-enumeration/likelihood code is referenced here at all.
 */

const storage = new LocalStorageAdapter();
let facade = new MafiaPredictorFacade(storage);

const root = document.getElementById("app")!;

// ---- ephemeral, NEVER-persisted UI-only navigation state ----
type MenuScreen = "MENU" | "HISTORY" | "SETUP";
let menuScreen: MenuScreen = "MENU";
let setupDraft = { playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) as RoleCounts };
let infoPlayer: PlayerId | null = null;
let openHistoryId: string | null = null;
let errorMessage: string | null = null;
/**
 * True while the user has navigated to the menu WITHOUT discarding or
 * finishing the active game - the active session stays exactly as-is in
 * `facade`/localStorage the whole time (see goToMenu()). Purely a view
 * toggle: it is never persisted and a page reload always lands back on the
 * active game if one exists, same as before this feature existed.
 */
let atMenuOverGame = false;

// ============================================================
// tiny DOM helpers
// ============================================================

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void, className = "btn"): HTMLButtonElement {
  const b = el("button", className, label);
  b.onclick = () => safely(onClick);
  return b;
}

/**
 * A button that only mutates LOCAL (non-facade, non-module-level) state,
 * such as an in-progress candidate-selection Set inside an open modal.
 * Deliberately does NOT call render() - unlike button()/safely(), which
 * always trigger a full top-level render() that would rebuild `root` from
 * scratch and silently close whatever modal this button lives in, since
 * that local selection state isn't part of anything render() knows to
 * redraw.
 */
function toggleButton(label: string, onToggle: (btn: HTMLButtonElement) => void, className = "btn player-select-btn"): HTMLButtonElement {
  const b = el("button", className, label);
  b.onclick = () => onToggle(b);
  return b;
}

/**
 * Opens a modal/overlay that appends itself directly onto `root` (e.g.
 * renderEventEntryOverlay, renderStartVotingOverlay, showExportModal).
 * Must NOT go through button()/safely() - that always finishes with a full
 * top-level render(), which clears `root.innerHTML` and would erase the
 * overlay synchronously, before the browser ever paints it.
 */
function overlayButton(label: string, onOpen: () => void, className = "btn"): HTMLButtonElement {
  const b = el("button", className, label);
  b.onclick = onOpen;
  return b;
}

function safely(fn: () => void): void {
  try {
    fn();
    errorMessage = null;
  } catch (e) {
    errorMessage = e instanceof GameFacadeError ? e.message : e instanceof Error ? e.message : String(e);
  }
  render();
}

/**
 * Leaves the current game screen for the menu WITHOUT discarding or
 * finishing the active game - confirms first whenever a real session
 * exists (createGame() has been called), since that session already holds
 * real recorded state; no confirmation is needed while still on the
 * pre-createGame() Setup screen, since there is nothing yet to lose.
 */
function goToMenu(): void {
  if (facade.getAppScreen() === "GAME") {
    if (!window.confirm("Leave this game? Your current game will remain saved and can be continued.")) return;
  }
  atMenuOverGame = true;
  menuScreen = "MENU";
  infoPlayer = null; // don't leave a stale "open" modal waiting for when the user returns via Continue Game
}

function backToMenuButton(): HTMLButtonElement {
  return button("Back to Menu", goToMenu, "btn btn-back-menu");
}

function selectEl(options: { value: string; label: string }[], selected?: string): HTMLSelectElement {
  const s = el("select", "select");
  options.forEach((o) => {
    const opt = el("option", undefined, o.label);
    opt.value = o.value;
    if (o.value === selected) opt.selected = true;
    s.appendChild(opt);
  });
  return s;
}

function playerOptions(players: PlayerId[]): { value: string; label: string }[] {
  return players.map((p) => ({ value: p, label: `Player ${p}` }));
}

// ============================================================
// Root render dispatcher
// ============================================================

function render(): void {
  root.innerHTML = "";
  if (errorMessage) {
    const banner = el("div", "error-banner", errorMessage);
    root.appendChild(banner);
  }

  // Everything that actually builds a screen can throw (e.g. a corrupted or
  // otherwise unrenderable saved session) - unlike a button's own onClick,
  // which safely() already wraps, nothing upstream of this call protects
  // it. Without this try/catch, an exception here would leave `root` empty
  // (already cleared above) with no way back in - a dead, blank white
  // screen - for the rest of this session's life.
  try {
    renderCurrentScreen();
  } catch (e) {
    renderCrashScreen(e);
  }
}

function renderCurrentScreen(): void {
  const hasActiveGame = facade.getAppScreen() === "GAME";
  if (!hasActiveGame || atMenuOverGame) {
    if (menuScreen === "MENU") renderMainMenu();
    else if (menuScreen === "HISTORY") renderHistory();
    else renderSetup();
    return;
  }

  // GAME screen
  const session = facade.getPublicSessionView();
  if (!session.hasMyRole) {
    renderRoleEntry();
    return;
  }
  if (session.uiPhase.kind === "night") {
    renderDeathEntry();
  } else if (session.uiPhase.kind === "voting") {
    renderCandidateVoting();
  } else if (session.uiPhase.kind === "keepOrEliminateVoting") {
    renderKeepOrEliminateVoting();
  } else if (session.uiPhase.kind === "finished") {
    renderFinishGame();
  } else {
    renderMainGameScreen();
  }
}

/**
 * Last-resort recovery screen for an exception that escaped renderCurrentScreen()
 * entirely (not a validation error from a button click - those already show as
 * the small error-banner via safely()/errorMessage). Nothing here can itself
 * throw: no facade calls except the two simple, always-safe escape actions.
 */
function renderCrashScreen(e: unknown): void {
  root.innerHTML = "";
  const c = el("div", "screen");
  c.appendChild(el("h2", "title", "Something went wrong"));
  c.appendChild(el("p", "error-banner", e instanceof Error ? e.message : String(e)));
  c.appendChild(el("p", "hint", "Nothing has been lost - your saved data is unchanged. Go back to the menu, or discard just this game if it's the one causing the problem."));

  const actions = el("div", "actions-row");
  actions.appendChild(button("Back to Menu", () => { atMenuOverGame = true; menuScreen = "MENU"; }, "btn btn-huge"));
  if (facade.getAppScreen() === "GAME") {
    actions.appendChild(button("Discard This Game", () => { facade.discardGame(); atMenuOverGame = false; menuScreen = "MENU"; }, "btn btn-danger btn-huge"));
  }
  c.appendChild(actions);
  root.appendChild(c);
}

// ============================================================
// MENU
// ============================================================

function renderMainMenu(): void {
  const c = el("div", "screen menu-screen");
  c.appendChild(el("h1", "title", "Mafia Predictor"));

  const hasActiveGame = facade.getAppScreen() === "GAME";
  if (hasActiveGame) {
    c.appendChild(button("Continue Game", () => { atMenuOverGame = false; }, "btn btn-primary btn-huge"));
  }
  c.appendChild(
    button(
      "New Game",
      () => {
        if (hasActiveGame && !window.confirm("Starting a new game will discard your current in-progress game (it has not been saved to history). Continue?")) {
          return;
        }
        menuScreen = "SETUP";
      },
      hasActiveGame ? "btn btn-huge" : "btn btn-primary btn-huge"
    )
  );
  c.appendChild(button("Game History", () => { menuScreen = "HISTORY"; }, "btn btn-huge"));
  c.appendChild(button("Clear All Data", onClearAllData, "btn btn-danger btn-huge"));
  root.appendChild(c);
}

function onClearAllData(): void {
  if (!window.confirm("This permanently deletes every saved game and any game in progress. Continue?")) return;
  facade.clearAllData();
  window.location.reload();
}

// ============================================================
// NEW GAME SETUP
// ============================================================

function renderSetup(): void {
  const c = el("div", "screen setup-screen");
  c.appendChild(el("h2", "title", "New Game Setup"));

  const playerCountRow = el("div", "field-row");
  playerCountRow.appendChild(el("label", "field-label", "Number of players"));
  const playerCountInput = el("input", "number-input") as HTMLInputElement;
  playerCountInput.type = "number";
  playerCountInput.min = "5";
  playerCountInput.max = "20";
  playerCountInput.value = String(setupDraft.playerCount);
  playerCountInput.onchange = () => {
    const n = Math.max(5, Math.min(20, Number(playerCountInput.value) || setupDraft.playerCount));
    setupDraft.playerCount = n;
    setupDraft.roleCounts = defaultRoleCountsForPlayerCount(n);
    if (Number(setupDraft.myPlayerNumber) > n) setupDraft.myPlayerNumber = "1";
    render();
  };
  playerCountRow.appendChild(playerCountInput);
  c.appendChild(playerCountRow);

  const myPlayerRow = el("div", "field-row");
  myPlayerRow.appendChild(el("label", "field-label", "My player number"));
  const myPlayerSelect = selectEl(
    Array.from({ length: setupDraft.playerCount }, (_, i) => String(i + 1)).map((p) => ({ value: p, label: p })),
    setupDraft.myPlayerNumber
  );
  myPlayerSelect.onchange = () => { setupDraft.myPlayerNumber = myPlayerSelect.value; };
  myPlayerRow.appendChild(myPlayerSelect);
  c.appendChild(myPlayerRow);

  c.appendChild(el("h3", "subtitle", "Role configuration"));
  (["don", "mafia", "commissioner", "doctor", "citizen"] as (keyof RoleCounts)[]).forEach((role) => {
    const row = el("div", "field-row");
    row.appendChild(el("label", "field-label", role));
    const input = el("input", "number-input") as HTMLInputElement;
    input.type = "number";
    input.min = "0";
    input.value = String(setupDraft.roleCounts[role]);
    input.onchange = () => {
      setupDraft.roleCounts = { ...setupDraft.roleCounts, [role]: Math.max(0, Number(input.value) || 0) };
      render();
    };
    row.appendChild(input);
    c.appendChild(row);
  });

  const roleTotal = Object.values(setupDraft.roleCounts).reduce((sum, n) => sum + n, 0);
  const countsMatch = roleTotal === setupDraft.playerCount;
  c.appendChild(
    el(
      "p",
      countsMatch ? "hint" : "error-banner",
      countsMatch
        ? `Total roles: ${roleTotal} / ${setupDraft.playerCount} players`
        : `Total roles (${roleTotal}) must equal the player count (${setupDraft.playerCount}) - adjust the counts above before starting.`
    )
  );

  const actions = el("div", "actions-row");
  actions.appendChild(button("Back", () => { menuScreen = "MENU"; render(); }));
  const startGameBtn = button(
    "Start Game",
    () => {
      facade.createGame({ playerCount: setupDraft.playerCount, myPlayerNumber: setupDraft.myPlayerNumber, roleCounts: setupDraft.roleCounts });
      menuScreen = "MENU";
      atMenuOverGame = false;
    },
    "btn btn-primary btn-huge"
  );
  startGameBtn.disabled = !countsMatch;
  actions.appendChild(startGameBtn);
  c.appendChild(actions);
  root.appendChild(c);
}

// ============================================================
// SECRET ROLE ENTRY
// ============================================================

function renderRoleEntry(): void {
  const vm = buildRoleEntryViewModel(facade);
  const c = el("div", "screen role-entry-screen");
  c.appendChild(backToMenuButton());
  c.appendChild(el("h2", "title", "What is your role?"));
  c.appendChild(el("p", "hint", "Make sure nobody else can see this screen before selecting."));
  const grid = el("div", "role-grid");
  vm.roleOptions.forEach((role) => {
    grid.appendChild(button(role, () => facade.setPlayerRole(role), "btn btn-huge role-btn"));
  });
  c.appendChild(grid);
  root.appendChild(c);
}

// ============================================================
// MAIN GAME SCREEN
// ============================================================

function renderMainGameScreen(): void {
  const vm = buildGameScreenViewModel(facade);
  const c = el("div", "screen game-screen");

  const header = el("div", "game-header");
  header.appendChild(backToMenuButton());
  header.appendChild(el("div", "phase-label", vm.phaseLabel));
  if (vm.canUndo) header.appendChild(button("Undo", () => facade.undoLastEvent(), "btn btn-undo"));
  c.appendChild(header);

  const circle = el("div", "player-circle");
  const radiusPct = 42;
  vm.players.forEach((p, i) => {
    const node = el("div", "player-node" + (p.isMe ? " player-node-me" : "") + (p.alive ? "" : " player-node-dead"));
    const angle = (2 * Math.PI * i) / vm.players.length - Math.PI / 2;
    const left = 50 + radiusPct * Math.cos(angle);
    const top = 50 + radiusPct * Math.sin(angle);
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    node.appendChild(el("div", "player-icon", p.alive ? "\u{1F464}" : "\u{1F480}"));
    node.appendChild(el("div", "player-number", p.player));
    if (!p.isMe) {
      if (p.alive && p.barStyle) {
        const bar = el("div", "prob-bar");
        const fill = el("div", "prob-bar-fill");
        fill.style.height = `${p.barStyle.heightPercent}%`;
        if (p.barStyle.direction === "down") {
          fill.style.top = "50%";
        } else {
          fill.style.bottom = "50%";
        }
        fill.classList.add(p.barStyle.color === "mafia" ? "prob-bar-mafia" : "prob-bar-town");
        bar.appendChild(fill);
        node.appendChild(bar);
      }
      // dead players stay clickable (for Player Info) even without a bar - only living, non-self players get one.
      node.onclick = () => { infoPlayer = p.player; render(); };
    } else {
      node.appendChild(el("div", "you-label", "you"));
    }
    circle.appendChild(node);
  });
  c.appendChild(circle);

  const actions = el("div", "actions-row actions-wrap");
  actions.appendChild(overlayButton("Record Action / Claim", () => renderEventEntryOverlay(), "btn btn-primary"));
  actions.appendChild(overlayButton("Start Voting", () => renderStartVotingOverlay(), "btn"));
  actions.appendChild(button("Start Night", () => facade.startNight(), "btn"));
  actions.appendChild(button("Finish Game", () => facade.finishGame(facade.getSuggestedOutcome()), "btn btn-danger"));
  c.appendChild(actions);

  root.appendChild(c);

  if (infoPlayer) renderPlayerInfoModal(infoPlayer);
}

// ---- Player Info modal ----

function renderPlayerInfoModal(player: PlayerId): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  try {
    const info = facade.getPlayerInfo(player);
    box.appendChild(el("h3", "title", `Player ${player}`));
    box.appendChild(el("div", "info-row", `Alive: ${info.alive ? "yes" : "no"}`));
    box.appendChild(el("div", "info-row", `P(Mafia): ${(info.mafiaProbability * 100).toFixed(1)}%`));
    box.appendChild(el("div", "info-row", `P(Commissioner): ${(info.commissionerProbability * 100).toFixed(1)}%`));
    box.appendChild(el("div", "info-row", `P(Doctor): ${(info.doctorProbability * 100).toFixed(1)}%`));
    if (info.donProbability !== undefined) box.appendChild(el("div", "info-row", `P(Don): ${(info.donProbability * 100).toFixed(1)}%`));

    box.appendChild(el("h4", "subtitle", "Teammate probability"));
    Object.entries(info.teammateProbabilities).forEach(([other, prob]) => {
      box.appendChild(el("div", "info-row", `Same team as ${other}: ${(prob * 100).toFixed(1)}%`));
    });

    box.appendChild(el("h4", "subtitle", "Events involving this player"));
    if (info.events.length === 0) box.appendChild(el("div", "info-row hint", "none yet"));
    info.events.forEach((e) => box.appendChild(el("div", "info-row", e.description)));
  } catch (err) {
    box.appendChild(el("div", "error-banner", err instanceof Error ? err.message : String(err)));
  }
  const actions = el("div", "actions-row");
  actions.appendChild(button("Close", () => { infoPlayer = null; render(); }, "btn btn-huge"));
  actions.appendChild(backToMenuButton());
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);
}

// ---- Event entry overlay (suspect/defend/nominate/claim) ----

function renderEventEntryOverlay(): void {
  const session = facade.getPublicSessionView();
  const alivePlayers = buildGameScreenViewModel(facade).players.filter((p) => p.alive).map((p) => p.player);

  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  box.appendChild(backToMenuButton());
  box.appendChild(el("h3", "title", "Record Action / Claim"));

  const actorRow = el("div", "field-row");
  actorRow.appendChild(el("label", "field-label", "Actor"));
  const actorSelect = selectEl(playerOptions(alivePlayers));
  actorRow.appendChild(actorSelect);
  box.appendChild(actorRow);

  const typeRow = el("div", "field-row");
  typeRow.appendChild(el("label", "field-label", "Action"));
  const typeSelect = selectEl([
    { value: "suspect", label: "Suspect" },
    { value: "defend", label: "Defend" },
    { value: "nominate", label: "Nominate" },
    { value: "selfRoleClaim", label: "Claim: I am..." },
    { value: "roleAssertion", label: "Claim: another player is..." },
    { value: "investigationReport", label: "Claim: investigation result" },
  ]);
  typeRow.appendChild(typeSelect);
  box.appendChild(typeRow);

  const detailContainer = el("div", "detail-container");
  box.appendChild(detailContainer);

  function renderDetails(): void {
    detailContainer.innerHTML = "";
    const type = typeSelect.value;

    if (type === "suspect" || type === "defend" || type === "nominate") {
      const targetRow = el("div", "field-row");
      targetRow.appendChild(el("label", "field-label", "Target"));
      const targetSelect = selectEl(playerOptions(alivePlayers));
      targetRow.appendChild(targetSelect);
      detailContainer.appendChild(targetRow);
      detailContainer.dataset.getTarget = "1";
      (detailContainer as any)._targetSelect = targetSelect;
    } else if (type === "selfRoleClaim") {
      const claimSelect = roleClaimSelect(session);
      const row = el("div", "field-row");
      row.appendChild(el("label", "field-label", "Claims to be"));
      row.appendChild(claimSelect);
      detailContainer.appendChild(row);
      (detailContainer as any)._claimSelect = claimSelect;
    } else if (type === "roleAssertion") {
      const targetRow = el("div", "field-row");
      targetRow.appendChild(el("label", "field-label", "About player"));
      const targetSelect = selectEl(playerOptions(session.config.players.filter((p) => p !== actorSelect.value)));
      targetRow.appendChild(targetSelect);
      detailContainer.appendChild(targetRow);

      const claimSelect = roleClaimSelect(session);
      const row = el("div", "field-row");
      row.appendChild(el("label", "field-label", "Claims they are"));
      row.appendChild(claimSelect);
      detailContainer.appendChild(row);
      (detailContainer as any)._targetSelect = targetSelect;
      (detailContainer as any)._claimSelect = claimSelect;
    } else if (type === "investigationReport") {
      const targetRow = el("div", "field-row");
      targetRow.appendChild(el("label", "field-label", "Target"));
      const targetSelect = selectEl(playerOptions(session.config.players.filter((p) => p !== actorSelect.value)));
      targetRow.appendChild(targetSelect);
      detailContainer.appendChild(targetRow);

      const mechRow = el("div", "field-row");
      mechRow.appendChild(el("label", "field-label", "Mechanic"));
      const mechSelect = selectEl([
        { value: "checkIsCommissioner", label: "Check Is Commissioner (Don)" },
        { value: "checkIsMafia", label: "Check Is Mafia (Commissioner)" },
      ]);
      mechRow.appendChild(mechSelect);
      detailContainer.appendChild(mechRow);

      const resultRow = el("div", "field-row");
      resultRow.appendChild(el("label", "field-label", "Result"));
      const resultSelect = selectEl([{ value: "true", label: "Yes" }, { value: "false", label: "No" }]);
      resultRow.appendChild(resultSelect);
      detailContainer.appendChild(resultRow);
      (detailContainer as any)._targetSelect = targetSelect;
      (detailContainer as any)._mechSelect = mechSelect;
      (detailContainer as any)._resultSelect = resultSelect;
    }
  }
  typeSelect.onchange = renderDetails;
  actorSelect.onchange = renderDetails;
  renderDetails();

  const actions = el("div", "actions-row");
  actions.appendChild(button("Cancel", () => render()));
  actions.appendChild(
    button(
      "Confirm",
      () => {
        const actor = actorSelect.value;
        const type = typeSelect.value;
        const d = detailContainer as any;
        if (type === "suspect" || type === "defend" || type === "nominate") {
          facade.recordAction(actor, type, d._targetSelect.value);
        } else if (type === "selfRoleClaim") {
          facade.recordSelfRoleClaim(actor, d._claimSelect.value === "" ? { kind: "group", group: "town" } : parseClaim(d._claimSelect.value));
        } else if (type === "roleAssertion") {
          facade.recordRoleAssertion(actor, d._targetSelect.value, parseClaim(d._claimSelect.value));
        } else if (type === "investigationReport") {
          facade.recordInvestigationReport(actor, d._targetSelect.value, d._mechSelect.value, d._resultSelect.value === "true");
        }
      },
      "btn btn-primary btn-huge"
    )
  );
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);
}

function roleClaimSelect(session: ReturnType<MafiaPredictorFacade["getPublicSessionView"]>): HTMLSelectElement {
  const roleOptions = Array.from(new Set(session.config.roles)).map((r) => ({ value: `role:${r}`, label: r }));
  const groupOptions = [
    { value: "group:mafia", label: "Mafia (group)" },
    { value: "group:town", label: "Town (group)" },
    { value: "group:activeTown", label: "Active Town - Doctor/Commissioner (group)" },
  ];
  return selectEl([...roleOptions, ...groupOptions]);
}

function parseClaim(value: string): RoleExpression {
  const [kind, name] = value.split(":");
  return kind === "role" ? { kind: "role", role: name as RoleId } : { kind: "group", group: name as any };
}

// ============================================================
// DEATH ENTRY (night)
// ============================================================

const deathSelection = new Set<PlayerId>();

function renderDeathEntry(): void {
  const vm = buildGameScreenViewModel(facade);
  const c = el("div", "screen death-entry-screen");
  c.appendChild(backToMenuButton());
  c.appendChild(el("h2", "title", vm.phaseLabel));
  c.appendChild(el("p", "hint", "Select every player who died last night, then confirm."));

  const grid = el("div", "player-select-grid");
  vm.players.filter((p) => p.alive).forEach((p) => {
    const selected = deathSelection.has(p.player);
    const node = button(`${p.isMe ? "you: " : ""}${p.player}`, () => {
      if (deathSelection.has(p.player)) deathSelection.delete(p.player);
      else deathSelection.add(p.player);
      render();
    }, "btn player-select-btn" + (selected ? " player-select-btn-selected" : ""));
    grid.appendChild(node);
  });
  c.appendChild(grid);

  const actions = el("div", "actions-row");
  actions.appendChild(
    button(
      "Confirm Deaths",
      () => {
        facade.confirmNightDeaths(Array.from(deathSelection));
        deathSelection.clear();
      },
      "btn btn-primary btn-huge"
    )
  );
  c.appendChild(actions);
  root.appendChild(c);
}

// ============================================================
// VOTING
// ============================================================

function renderStartVotingOverlay(): void {
  const vm = buildGameScreenViewModel(facade);
  const alive = vm.players.filter((p) => p.alive).map((p) => p.player);
  const selection = new Set<PlayerId>();

  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  box.appendChild(backToMenuButton());
  box.appendChild(el("h3", "title", "Start Voting - select candidates"));
  const grid = el("div", "player-select-grid");
  alive.forEach((p) => {
    const node = toggleButton(p, () => {
      if (selection.has(p)) selection.delete(p);
      else selection.add(p);
      node.classList.toggle("player-select-btn-selected");
    });
    grid.appendChild(node);
  });
  box.appendChild(grid);

  const actions = el("div", "actions-row");
  actions.appendChild(button("Cancel", () => render()));
  actions.appendChild(
    button(
      "Start",
      () => {
        if (selection.size < 1) throw new GameFacadeError("select at least one candidate");
        facade.startVoting("initial", Array.from(selection));
      },
      "btn btn-primary btn-huge"
    )
  );
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);
}

function renderCandidateVoting(): void {
  const session = facade.getPublicSessionView();
  const phase = session.uiPhase as Extract<typeof session.uiPhase, { kind: "voting" }>;
  const vm = buildGameScreenViewModel(facade);
  const alive = vm.players.filter((p) => p.alive).map((p) => p.player);

  const c = el("div", "screen voting-screen");
  c.appendChild(backToMenuButton());
  c.appendChild(el("h2", "title", phase.stage === "initial" ? "Voting" : "Revote"));

  // A just-confirmed tied vote leaves uiPhase at "voting" but clears
  // votingDraft - there is no in-progress draft to record hands into, so
  // the per-candidate voter grids below must not be shown (recordHandsForCandidate
  // would throw "no in-progress candidateVote draft" if tapped).
  const noDraft = session.votingDraft === null;

  if (noDraft) {
    // Reached either because this round just tied, OR because Undo just
    // removed the dayElimination/candidateVote that followed a CLEAN
    // (non-tied) win - undo never restores votingDraft (see
    // gameFacade.ts's undoLastEvent doc), so the two cases look identical
    // here and must not be presented as "this was definitely a tie".
    c.appendChild(el("p", "hint", "No votes are recorded for this round right now (either it just tied, or a vote/elimination was undone)."));
    const restartActions = el("div", "actions-row");
    restartActions.appendChild(
      button(
        "Restart This Vote",
        () => facade.startVoting(phase.stage, phase.candidates),
        "btn btn-primary btn-huge"
      )
    );
    c.appendChild(restartActions);

    c.appendChild(el("p", "hint", "If this round genuinely tied, move on instead:"));
    const tieActions = el("div", "actions-row");
    if (phase.stage === "initial") {
      tieActions.appendChild(overlayButton("Start Revote (tied candidates)", () => renderTieFollowupOverlay("revote"), "btn"));
    } else {
      tieActions.appendChild(overlayButton("Start Keep/Eliminate Vote", () => renderTieFollowupOverlay("keepOrEliminate"), "btn"));
    }
    c.appendChild(tieActions);
    root.appendChild(c);
    return;
  }

  const draft = session.votingDraft as CandidateVoteDraft;

  // Self-heal a draft saved before this fix existed, where a voter could
  // end up recorded under more than one candidate (the exact cause of the
  // "voter raised a hand more than once" crash) - see votingDraftHelpers.ts.
  if (handsRaisedHasDuplicateVoter(phase.candidates, draft.handsRaised)) {
    const repaired = dedupeHandsRaised(phase.candidates, draft.handsRaised);
    phase.candidates.forEach((candidate) => facade.recordHandsForCandidate(candidate, repaired[candidate] ?? []));
  }
  const hands = dedupeHandsRaised(phase.candidates, draft.handsRaised);
  const voterToCandidate = voterAssignments(phase.candidates, hands);

  /** The only place a voter's hand is ever reassigned - guarantees they end up under at most one candidate. */
  function setVote(voter: PlayerId, candidate: PlayerId | null): void {
    const next = assignVoterHands(phase.candidates, hands, voter, candidate);
    phase.candidates.forEach((c2) => facade.recordHandsForCandidate(c2, next[c2] ?? []));
  }

  phase.candidates.forEach((candidate) => {
    const section = el("div", "candidate-section");
    const count = (hands[candidate] ?? []).length;
    section.appendChild(el("h3", "subtitle", `Candidate ${candidate} - ${count} hand(s) recorded`));
    const grid = el("div", "player-select-grid");
    alive.forEach((voter) => {
      const isForThisCandidate = voterToCandidate.get(voter) === candidate;
      const node = button(
        voter,
        () => setVote(voter, isForThisCandidate ? null : candidate),
        "btn player-select-btn" + (isForThisCandidate ? " player-select-btn-selected" : "")
      );
      grid.appendChild(node);
    });
    section.appendChild(grid);
    c.appendChild(section);
  });

  const tallyDisplay = el("div", "tally-display");
  try {
    const currentTally = facade.getVoteTallySoFar();
    currentTally.forEach((t) => tallyDisplay.appendChild(el("div", "info-row", `${t.candidate}: ${t.count} vote(s)`)));
  } catch {
    tallyDisplay.appendChild(el("div", "hint", "vote counts unavailable until hands are resolved"));
  }
  c.appendChild(tallyDisplay);

  const actions = el("div", "actions-row");
  actions.appendChild(
    button(
      "Confirm Vote",
      () => {
        const outcome = facade.confirmVote();
        if (outcome.kind === "winner") {
          facade.recordDayElimination([outcome.candidate]);
        }
        // a tie leaves uiPhase in "voting" with no active draft - the next
        // render() will take the `noDraft` branch above and offer next steps.
      },
      "btn btn-primary btn-huge"
    )
  );
  c.appendChild(actions);

  root.appendChild(c);
}

function renderTieFollowupOverlay(next: "revote" | "keepOrEliminate"): void {
  const vm = buildGameScreenViewModel(facade);
  const alive = vm.players.filter((p) => p.alive).map((p) => p.player);
  const selection = new Set<PlayerId>();

  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  box.appendChild(backToMenuButton());
  box.appendChild(el("h3", "title", next === "revote" ? "Select the tied candidates for the revote" : "Select the tied candidates for keep/eliminate"));
  const grid = el("div", "player-select-grid");
  alive.forEach((p) => {
    const node = toggleButton(p, () => {
      if (selection.has(p)) selection.delete(p);
      else selection.add(p);
      node.classList.toggle("player-select-btn-selected");
    });
    grid.appendChild(node);
  });
  box.appendChild(grid);

  const actions = el("div", "actions-row");
  actions.appendChild(button("Cancel", () => render()));
  actions.appendChild(
    button(
      "Start",
      () => {
        if (selection.size < 2) throw new GameFacadeError("select exactly the tied candidates (at least 2)");
        if (next === "revote") facade.startVoting("revote", Array.from(selection));
        else facade.startKeepOrEliminateVote(Array.from(selection));
      },
      "btn btn-primary btn-huge"
    )
  );
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);
}

function renderKeepOrEliminateVoting(): void {
  const session = facade.getPublicSessionView();
  const phase = session.uiPhase as Extract<typeof session.uiPhase, { kind: "keepOrEliminateVoting" }>;
  const vm = buildGameScreenViewModel(facade);
  const alive = vm.players.filter((p) => p.alive).map((p) => p.player);
  const draft = session.votingDraft && session.votingDraft.kind === "keepOrEliminateVote" ? session.votingDraft : null;

  const c = el("div", "screen voting-screen");
  c.appendChild(backToMenuButton());
  c.appendChild(el("h2", "title", `Keep or Eliminate: ${phase.candidates.join(", ")}`));
  c.appendChild(el("p", "hint", "Select every player who votes to ELIMINATE all listed candidates."));

  const grid = el("div", "player-select-grid");
  const selected = new Set<PlayerId>(draft?.eliminateHands ?? []);
  alive.forEach((voter) => {
    const isSelected = selected.has(voter);
    const node = button(voter, () => {
      if (selected.has(voter)) selected.delete(voter);
      else selected.add(voter);
      facade.recordEliminateHands(Array.from(selected));
    }, "btn player-select-btn" + (isSelected ? " player-select-btn-selected" : ""));
    grid.appendChild(node);
  });
  c.appendChild(grid);

  const actions = el("div", "actions-row");
  actions.appendChild(
    button(
      "Confirm",
      () => {
        const outcome = facade.confirmKeepOrEliminateVote();
        facade.recordDayElimination(outcome.kind === "eliminateAll" ? outcome.candidates : []);
      },
      "btn btn-primary btn-huge"
    )
  );
  c.appendChild(actions);
  root.appendChild(c);
}

// ============================================================
// FINISH GAME
// ============================================================

const OUTCOME_OPTIONS: { value: "townWon" | "mafiaWon" | "unknown"; label: string }[] = [
  { value: "townWon", label: "Town Won" },
  { value: "mafiaWon", label: "Mafia Won" },
  { value: "unknown", label: "Unknown / not specified" },
];

function renderFinishGame(): void {
  const session = facade.getPublicSessionView();
  const c = el("div", "screen finish-screen");
  c.appendChild(backToMenuButton());
  c.appendChild(el("h2", "title", "Game Finished"));

  const outcomeRow = el("div", "field-row");
  outcomeRow.appendChild(el("label", "field-label", "Result"));
  const outcomeSelect = selectEl(OUTCOME_OPTIONS, session.confirmedOutcome ?? "unknown");
  outcomeSelect.onchange = () => safely(() => facade.finishGame(outcomeSelect.value as "townWon" | "mafiaWon" | "unknown"));
  outcomeRow.appendChild(outcomeSelect);
  c.appendChild(outcomeRow);
  c.appendChild(el("p", "hint", "The engine's own suggestion is pre-selected when it has one - confirm it or pick a different result."));

  c.appendChild(el("h3", "subtitle", "Enter each player's actual final role"));
  session.config.players.forEach((player) => {
    const row = el("div", "field-row");
    row.appendChild(el("label", "field-label", `Player ${player}`));
    const roleSelect = selectEl(facade.getRoleOptions().map((r) => ({ value: r, label: r })), session.finalRoles?.[player]);
    roleSelect.onchange = () => safely(() => facade.setFinalRole(player, roleSelect.value as RoleId));
    row.appendChild(roleSelect);
    c.appendChild(row);
  });

  const actions = el("div", "actions-row");
  actions.appendChild(
    button(
      "Save to History",
      () => {
        facade.saveGameToHistory();
        menuScreen = "MENU";
        atMenuOverGame = false;
      },
      "btn btn-primary btn-huge"
    )
  );
  actions.appendChild(
    button(
      "Discard",
      () => {
        if (!window.confirm("Discard this game without saving?")) return;
        facade.discardGame();
        menuScreen = "MENU";
        atMenuOverGame = false;
      },
      "btn btn-danger btn-huge"
    )
  );
  c.appendChild(actions);
  root.appendChild(c);
}

// ============================================================
// HISTORY
// ============================================================

function renderHistory(): void {
  const c = el("div", "screen history-screen");
  c.appendChild(el("h2", "title", "Game History"));
  const list = buildHistoryListViewModel(facade);

  if (openHistoryId) {
    const entry = facade.listHistory().find((h) => h.id === openHistoryId);
    if (entry) {
      c.appendChild(el("h3", "subtitle", `Game from ${new Date(entry.savedAt).toLocaleString()}`));
      c.appendChild(el("div", "info-row", `Players: ${entry.session.config.players.length}`));
      c.appendChild(el("div", "info-row", `Result: ${entry.session.confirmedOutcome ?? "unknown"}`));
      const log = el("div", "event-log");
      entry.session.eventLog.forEach(({ event }, i) => {
        log.appendChild(el("div", "info-row", `${i + 1}. ${event.type} (round ${event.round})`));
      });
      c.appendChild(log);
      c.appendChild(button("Delete this game", () => {
        if (!window.confirm("Delete this saved game permanently?")) return;
        facade.deleteHistoryEntry(entry.id);
        openHistoryId = null;
      }, "btn btn-danger"));
      c.appendChild(button("Back to list", () => { openHistoryId = null; render(); }));
      root.appendChild(c);
      return;
    }
  }

  if (list.length === 0) c.appendChild(el("p", "hint", "No saved games yet."));
  list.forEach((entry) => {
    const row = el("div", "history-row");
    row.appendChild(el("div", "info-row", `${new Date(entry.savedAt).toLocaleString()} - ${entry.playerCount} players - ${entry.result}`));
    row.appendChild(button("Open", () => { openHistoryId = entry.id; render(); }));
    c.appendChild(row);
  });

  const actions = el("div", "actions-row");
  actions.appendChild(overlayButton("Export All (JSON)", () => showExportModal(), "btn"));
  actions.appendChild(button("Delete All History", () => {
    if (!window.confirm("Delete ALL saved game history permanently?")) return;
    facade.clearHistory();
  }, "btn btn-danger"));
  actions.appendChild(button("Back", () => { menuScreen = "MENU"; render(); }));
  c.appendChild(actions);
  root.appendChild(c);
}

function showExportModal(): void {
  const json = facade.exportHistoryJson();
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  box.appendChild(el("h3", "title", "Export History"));
  const textarea = el("textarea", "export-textarea") as HTMLTextAreaElement;
  textarea.value = json;
  textarea.readOnly = true;
  box.appendChild(textarea);

  const actions = el("div", "actions-row");
  actions.appendChild(
    button("Copy to Clipboard", () => {
      navigator.clipboard?.writeText(json).catch(() => {});
    })
  );
  const nav = navigator as any;
  if (nav.share) {
    actions.appendChild(button("Share", () => nav.share({ title: "Mafia Predictor History", text: json }).catch(() => {})));
  }
  actions.appendChild(button("Close", () => render(), "btn btn-huge"));
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);
}

// ============================================================
// boot
// ============================================================

render();
