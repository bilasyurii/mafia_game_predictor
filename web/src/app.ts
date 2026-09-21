import { LocalStorageAdapter } from "./storageAdapter";
import { GameFacadeError, MafiaPredictorFacade } from "../../src/app/gameFacade";
import { CandidateVoteDraft, RoleCounts, defaultRoleCountsForPlayerCount } from "../../src/app/types";
import { buildGameScreenViewModel, buildHistoryListViewModel, buildRoleEntryViewModel } from "../../src/web/viewModel";
import { assignVoterHands, dedupeHandsRaised, handsRaisedHasDuplicateVoter, voterAssignments } from "../../src/web/votingDraftHelpers";
import { InvestigationMechanic } from "../../src/investigation";
import { describeGameEvent } from "../../src/describeGameEvent";
import { ActionIntensity, PlayerId, RoleExpression, RoleId } from "../../src/types";

/**
 * The one file in this application that touches the DOM. Every decision
 * about WHAT to show comes from the facade (src/app/gameFacade.ts) or the
 * pure view-model builders (src/web/viewModel.ts) - this file only turns
 * that data into elements and routes clicks/drags back into facade calls.
 * No probability/likelihood code is referenced here at all - see this
 * app's relationship-based redesign.
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
/** Index into the current relationship view's `teams` array - clicking a team chip toggles this; while set, that team's arrows render solid and every other arrow is dimmed (see buildArrowsSvg). Never persisted. */
let selectedTeamIndex: number | null = null;
/**
 * True while the user has navigated to the menu WITHOUT discarding or
 * finishing the active game - the active session stays exactly as-is in
 * `facade`/localStorage the whole time (see goToMenu()). Purely a view
 * toggle: it is never persisted and a page reload always lands back on the
 * active game if one exists, same as before this feature existed.
 */
let atMenuOverGame = false;

/** Clears view-only state that would otherwise point at a modal/selection from a previous game or a previous moment in this one. */
function resetGameUiState(): void {
  infoPlayer = null;
  selectedTeamIndex = null;
}

// ============================================================
// tiny DOM helpers
// ============================================================

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
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
 * renderStartVotingOverlay, showActionTypePopup, showExportModal). Must NOT
 * go through button()/safely() - that always finishes with a full top-level
 * render(), which clears `root.innerHTML` and would erase the overlay
 * synchronously, before the browser ever paints it.
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
  resetGameUiState(); // don't leave a stale "open" modal/selection waiting for when the user returns via Continue Game
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
    actions.appendChild(button("Discard This Game", () => { facade.discardGame(); atMenuOverGame = false; menuScreen = "MENU"; resetGameUiState(); }, "btn btn-danger btn-huge"));
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
      resetGameUiState();
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

/** Same percentage-space (0-100) coordinate a player's circle position AND the arrows SVG (viewBox="0 0 100 100") both use - keeping the two in one function guarantees they never drift apart. */
function circlePosition(index: number, count: number): { left: number; top: number } {
  const radiusPct = 42;
  const angle = (2 * Math.PI * index) / count - Math.PI / 2;
  return { left: 50 + radiusPct * Math.cos(angle), top: 50 + radiusPct * Math.sin(angle) };
}

/** Shrinks a line from `a` to `b` so it starts/ends just clear of each player's icon instead of running straight through their centers. */
function arrowEndpoints(a: { left: number; top: number }, b: { left: number; top: number }): { x1: number; y1: number; x2: number; y2: number } {
  const t0 = 0.14;
  const t1 = 0.86;
  return {
    x1: a.left + (b.left - a.left) * t0,
    y1: a.top + (b.top - a.top) * t0,
    x2: a.left + (b.left - a.left) * t1,
    y2: a.top + (b.top - a.top) * t1,
  };
}

/**
 * One arrow per individual suspect/nominate ("attack") or defend
 * ("support") action - never aggregated by pair (see RelationshipArrow's
 * own doc in gameFacade.ts). Cooperation/opposition strength is never
 * encoded in arrow appearance; the only thing arrow appearance reacts to is
 * whether a team is currently selected in the team panel (see
 * `selectedTeamIndex`), which dims every arrow whose actor is NOT a member
 * of that team.
 */
function buildArrowsSvg(vm: ReturnType<typeof buildGameScreenViewModel>, positions: Map<PlayerId, { left: number; top: number }>): SVGSVGElement {
  const svg = svgEl("svg");
  svg.setAttribute("class", "arrows-svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");

  const defs = svgEl("defs");
  (["attack", "support"] as const).forEach((kind) => {
    const marker = svgEl("marker");
    marker.setAttribute("id", `arrowhead-${kind}`);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = svgEl("path");
    path.setAttribute("d", "M0,0 L10,5 L0,10 z");
    path.setAttribute("class", kind === "attack" ? "arrowhead-attack" : "arrowhead-support");
    marker.appendChild(path);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);

  const selectedTeam = selectedTeamIndex !== null ? vm.teams[selectedTeamIndex] : null;

  vm.arrows.forEach((arrow) => {
    const a = positions.get(arrow.actor);
    const b = positions.get(arrow.target);
    if (!a || !b) return;
    const { x1, y1, x2, y2 } = arrowEndpoints(a, b);
    const line = svgEl("line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("vector-effect", "non-scaling-stroke");
    line.setAttribute("marker-end", `url(#arrowhead-${arrow.type})`);
    let cls = `arrow-line ${arrow.type === "attack" ? "arrow-attack" : "arrow-support"}`;
    if (selectedTeam) cls += selectedTeam.members.includes(arrow.actor) ? " arrow-solid" : " arrow-dim";
    line.setAttribute("class", cls);
    svg.appendChild(line);
  });

  return svg;
}

/** The clickable list of detected teams - clicking one toggles `selectedTeamIndex` (see buildArrowsSvg). Singleton clusters aren't shown as their own "team", just summarized as a count. */
function buildTeamPanel(vm: ReturnType<typeof buildGameScreenViewModel>): HTMLDivElement {
  const panel = el("div", "team-panel");
  panel.appendChild(el("h3", "subtitle", "Detected Teams"));

  const multiTeamIndices = vm.teams.map((_, i) => i).filter((i) => vm.teams[i].members.length >= 2);
  const singleCount = vm.teams.length - multiTeamIndices.length;

  if (multiTeamIndices.length === 0) {
    panel.appendChild(el("p", "hint", "No cooperation/opposition patterns detected yet."));
  } else {
    const grid = el("div", "actions-row actions-wrap");
    multiTeamIndices.forEach((i) => {
      const team = vm.teams[i];
      const selected = selectedTeamIndex === i;
      grid.appendChild(
        button(
          `Team: ${team.members.join(", ")}`,
          () => { selectedTeamIndex = selected ? null : i; },
          "btn team-chip" + (selected ? " player-select-btn-selected" : "")
        )
      );
    });
    panel.appendChild(grid);
  }
  if (singleCount > 0) {
    panel.appendChild(el("p", "hint", `${singleCount} player(s) not yet showing a clear pattern.`));
  }
  return panel;
}

/**
 * Wires up the drag gesture on one alive player's node: dragging onto
 * another player opens the actor->target action popup; dragging onto the
 * center "self" target (a live duplicate of this same player's icon,
 * shown only while dragging) opens the self-claim popup. A pointerdown/up
 * with no real movement (a plain tap) instead opens that player's info
 * (unchanged from before this redesign) - never for the viewer's own node,
 * matching getPlayerInfo()'s own restriction.
 */
function attachDragHandlers(node: HTMLDivElement, actor: PlayerId, isMe: boolean, circle: HTMLDivElement): void {
  node.addEventListener("pointerdown", (downEvent: PointerEvent) => {
    downEvent.preventDefault();
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    let dragging = false;
    let ghost: HTMLDivElement | null = null;
    let centerTarget: HTMLDivElement | null = null;
    let hovered: HTMLElement | null = null;

    function beginDrag(): void {
      dragging = true;
      ghost = el("div", "drag-ghost", "\u{1F464}");
      document.body.appendChild(ghost);
      centerTarget = el("div", "player-node center-drop-target");
      centerTarget.dataset.dropTarget = "self";
      centerTarget.appendChild(el("div", "player-icon", "\u{1F464}"));
      centerTarget.appendChild(el("div", "player-number", actor));
      circle.appendChild(centerTarget);
    }

    function findDropTarget(x: number, y: number): HTMLElement | null {
      const under = document.elementFromPoint(x, y);
      return (under?.closest("[data-player],[data-drop-target]") as HTMLElement | null) ?? null;
    }

    function onMove(moveEvent: PointerEvent): void {
      if (!dragging) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 10) return;
        beginDrag();
      }
      if (ghost) {
        ghost.style.left = `${moveEvent.clientX}px`;
        ghost.style.top = `${moveEvent.clientY}px`;
      }
      if (hovered) hovered.classList.remove("drop-hover");
      const target = findDropTarget(moveEvent.clientX, moveEvent.clientY);
      hovered = target && target !== node ? target : null;
      if (hovered) hovered.classList.add("drop-hover");
    }

    function onUp(upEvent: PointerEvent): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);

      // Hit-test BEFORE tearing down the ghost/center-target - both sit
      // exactly at the drop point, so removing them first would make
      // elementFromPoint see whatever is underneath instead (dropping the
      // gesture on the floor every time).
      const target = dragging ? findDropTarget(upEvent.clientX, upEvent.clientY) : null;

      if (hovered) hovered.classList.remove("drop-hover");
      if (ghost) ghost.remove();
      if (centerTarget) centerTarget.remove();

      if (!dragging) {
        if (!isMe) { infoPlayer = actor; render(); }
        return;
      }

      if (!target) return;
      if (target.dataset.dropTarget === "self") {
        showSelfClaimPopup(actor);
      } else if (target.dataset.player && target.dataset.player !== actor) {
        showActionTypePopup(actor, target.dataset.player as PlayerId);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function renderMainGameScreen(): void {
  const vm = buildGameScreenViewModel(facade);
  const c = el("div", "screen game-screen");

  const header = el("div", "game-header");
  header.appendChild(backToMenuButton());
  header.appendChild(el("div", "phase-label", vm.phaseLabel));
  if (vm.canUndo) header.appendChild(button("Undo", () => facade.undoLastEvent(), "btn btn-undo"));
  c.appendChild(header);

  const circle = el("div", "player-circle");
  const positions = new Map<PlayerId, { left: number; top: number }>();
  vm.players.forEach((p, i) => positions.set(p.player, circlePosition(i, vm.players.length)));
  circle.appendChild(buildArrowsSvg(vm, positions));

  vm.players.forEach((p) => {
    const pos = positions.get(p.player)!;
    const node = el(
      "div",
      "player-node" +
        (p.isMe ? " player-node-me" : "") +
        (p.alive ? "" : " player-node-dead") +
        (p.confirmedTeam === "mafia" ? " player-node-confirmed-mafia" : "") +
        (p.confirmedTeam === "town" ? " player-node-confirmed-town" : "")
    );
    node.dataset.player = p.player;
    node.style.left = `${pos.left}%`;
    node.style.top = `${pos.top}%`;
    node.appendChild(el("div", "player-icon", p.alive ? "\u{1F464}" : "\u{1F480}"));
    node.appendChild(el("div", "player-number", p.player));
    if (p.isMe) node.appendChild(el("div", "you-label", "you"));
    if (p.alive) {
      attachDragHandlers(node, p.player, p.isMe, circle);
    } else if (!p.isMe) {
      // dead players can't be dragged from (they can no longer act), but
      // stay tappable for Player Info, same as before this redesign.
      node.onclick = () => { infoPlayer = p.player; render(); };
    }
    circle.appendChild(node);
  });
  c.appendChild(circle);
  c.appendChild(el("p", "hint", "Drag from a player onto another to record an action or claim - drag onto the center icon to make a claim about themselves."));

  c.appendChild(buildTeamPanel(vm));

  const actions = el("div", "actions-row actions-wrap");
  actions.appendChild(overlayButton("Start Voting", () => renderStartVotingOverlay(), "btn"));
  actions.appendChild(button("Start Night", () => facade.startNight(), "btn"));
  actions.appendChild(overlayButton("Action History", () => renderActionHistoryModal(), "btn"));
  actions.appendChild(overlayButton("Finish Game", () => renderFinishGameOutcomePopup(), "btn btn-danger"));
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
    if (info.confirmedTeam) {
      box.appendChild(el("div", "info-row confirmed-banner", `CONFIRMED: ${info.confirmedTeam === "mafia" ? "Mafia" : "Town"}`));
    }

    box.appendChild(el("h4", "subtitle", "Relationships"));
    if (info.relationships.length === 0) {
      box.appendChild(el("div", "info-row hint", "no signal yet"));
    } else {
      info.relationships.forEach((r) => {
        const sign = r.score > 0 ? "+" : "";
        box.appendChild(el("div", "info-row", `Player ${r.other}: ${sign}${r.score} (${r.score > 0 ? "cooperating" : "opposed"})`));
      });
    }

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

// ---- Action History modal (full chronological event log for the live game) ----

function renderActionHistoryModal(): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  box.appendChild(el("h3", "title", "Action History"));
  const log = facade.getEventLog();
  const list = el("div", "event-log");
  if (log.length === 0) list.appendChild(el("div", "info-row hint", "No events recorded yet."));
  log.forEach((entry, i) => list.appendChild(el("div", "info-row", `${i + 1}. ${entry.description}`)));
  box.appendChild(list);
  box.appendChild(button("Close", () => render(), "btn btn-huge"));
  overlay.appendChild(box);
  root.appendChild(overlay);
}

// ---- action-type popup (opened by dropping actor onto target) ----

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

/** Opened by dragging `actor` onto `target`. Suspect/Defend/Nominate commit immediately; the two claim types step into a small in-place sub-form first. */
/** A 1-5 star picker for an action's intensity (see ActionIntensity's own doc) - clicking a star just redraws the popup with the new local selection, it never mutates the facade itself. */
function buildStarPicker(current: number, onChange: (n: number) => void): HTMLDivElement {
  const row = el("div", "star-picker");
  for (let n = 1; n <= 5; n++) {
    const star = overlayButton(n <= current ? "★" : "☆", () => onChange(n), "btn star-btn" + (n <= current ? " star-btn-filled" : ""));
    row.appendChild(star);
  }
  return row;
}

function showActionTypePopup(actor: PlayerId, target: PlayerId): void {
  const session = facade.getPublicSessionView();
  let step: "menu" | "roleAssertion" | "investigationReport" = "menu";
  let intensity = 3;

  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");

  function redraw(): void {
    box.innerHTML = "";
    box.appendChild(el("h3", "title", `Player ${actor} → Player ${target}`));

    if (step === "menu") {
      // The intensity picker lives on this same screen (not a separate
      // step after picking an action) - it's only actually USED by
      // Suspect/Defend/Nominate below; Claim Role/Investigation Report
      // simply ignore whatever it's set to, since those aren't
      // confidence-scored actions (see recordAction's own doc).
      box.appendChild(el("p", "hint", "Confidence (used by Suspect/Defend/Nominate only):"));
      box.appendChild(buildStarPicker(intensity, (n) => { intensity = n; redraw(); }));

      const typeGrid = el("div", "actions-row actions-wrap");
      (["suspect", "defend", "nominate"] as const).forEach((type) => {
        const label = type[0].toUpperCase() + type.slice(1);
        typeGrid.appendChild(button(label, () => facade.recordAction(actor, type, target, intensity as ActionIntensity), "btn btn-huge"));
      });
      box.appendChild(typeGrid);

      const claimsRow = el("div", "actions-row actions-wrap");
      claimsRow.appendChild(overlayButton("Claim Role...", () => { step = "roleAssertion"; redraw(); }, "btn"));
      claimsRow.appendChild(overlayButton("Investigation Report...", () => { step = "investigationReport"; redraw(); }, "btn"));
      box.appendChild(claimsRow);

      box.appendChild(button("Cancel", () => render()));
    } else if (step === "roleAssertion") {
      box.appendChild(el("p", "hint", `Player ${actor} claims Player ${target} is...`));
      const claimSelect = roleClaimSelect(session);
      box.appendChild(claimSelect);
      const actions = el("div", "actions-row");
      actions.appendChild(overlayButton("Back", () => { step = "menu"; redraw(); }));
      actions.appendChild(button("Confirm", () => facade.recordRoleAssertion(actor, target, parseClaim(claimSelect.value)), "btn btn-primary btn-huge"));
      box.appendChild(actions);
    } else {
      box.appendChild(el("p", "hint", `Player ${actor} claims to have investigated Player ${target}...`));
      const mechSelect = selectEl([
        { value: "checkIsCommissioner", label: "Check Is Commissioner (Don)" },
        { value: "checkIsMafia", label: "Check Is Mafia (Commissioner)" },
      ]);
      box.appendChild(mechSelect);
      const resultSelect = selectEl([{ value: "true", label: "Yes" }, { value: "false", label: "No" }]);
      box.appendChild(resultSelect);
      const actions = el("div", "actions-row");
      actions.appendChild(overlayButton("Back", () => { step = "menu"; redraw(); }));
      actions.appendChild(
        button(
          "Confirm",
          () => facade.recordInvestigationReport(actor, target, mechSelect.value as InvestigationMechanic, resultSelect.value === "true"),
          "btn btn-primary btn-huge"
        )
      );
      box.appendChild(actions);
    }
  }
  redraw();
  overlay.appendChild(box);
  root.appendChild(overlay);
}

/** Opened by dragging `actor` onto the center "self" target - the only claim type that makes sense about oneself. */
function showSelfClaimPopup(actor: PlayerId): void {
  const session = facade.getPublicSessionView();
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  box.appendChild(el("h3", "title", `Player ${actor} claims...`));
  const claimSelect = roleClaimSelect(session);
  box.appendChild(claimSelect);
  const actions = el("div", "actions-row");
  actions.appendChild(button("Cancel", () => render()));
  actions.appendChild(button("Confirm", () => facade.recordSelfRoleClaim(actor, parseClaim(claimSelect.value)), "btn btn-primary btn-huge"));
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);
}

/** Opened by the main game screen's "Finish Game" button - asks for the actual result up front instead of silently defaulting to "unknown" (the Finish Game screen still lets it be changed afterward). */
function renderFinishGameOutcomePopup(): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  box.appendChild(el("h3", "title", "Who won?"));
  const grid = el("div", "actions-row actions-wrap");
  grid.appendChild(button("Town Won", () => facade.finishGame("townWon"), "btn btn-huge"));
  grid.appendChild(button("Mafia Won", () => facade.finishGame("mafiaWon"), "btn btn-huge"));
  box.appendChild(grid);
  box.appendChild(button("Not Sure / Skip For Now", () => facade.finishGame("unknown")));
  box.appendChild(button("Cancel", () => render()));
  overlay.appendChild(box);
  root.appendChild(overlay);
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
  actions.appendChild(
    button(
      "Cancel Night (back to Day)",
      () => {
        facade.cancelCurrentSubPhase();
        deathSelection.clear();
      },
      "btn"
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
    // Reached either because this round just tied, because it just
    // resolved decisively, or because Undo removed some later event.
    // getVoteRecoveryState() tells us which - critically, "Restart This
    // Vote" is only ever offered when it's actually SAFE (no vote event
    // for this exact round+stage already recorded): restarting when one
    // already exists would append a duplicate, which dayEliminationValidation.ts
    // later rejects as an illegal chain (see its own doc).
    const recovery = facade.getVoteRecoveryState();

    if (recovery.kind === "tied") {
      c.appendChild(el("p", "hint", "This round tied - move on to resolve it:"));
      const tieActions = el("div", "actions-row");
      if (phase.stage === "initial") {
        tieActions.appendChild(overlayButton("Start Revote (tied candidates)", () => renderTieFollowupOverlay("revote"), "btn"));
      } else {
        tieActions.appendChild(overlayButton("Start Keep/Eliminate Vote", () => renderTieFollowupOverlay("keepOrEliminate"), "btn"));
      }
      c.appendChild(tieActions);
    } else if (recovery.kind === "decisive") {
      const eliminated = recovery.eliminated;
      c.appendChild(el("p", "hint", "This round's vote already decided an outcome (its elimination was undone) - record it again:"));
      c.appendChild(
        button(
          eliminated.length > 0 ? `Record Elimination: ${eliminated.join(", ")}` : "Record: Nobody Eliminated",
          () => facade.recordDayElimination(eliminated),
          "btn btn-primary btn-huge"
        )
      );
    } else {
      c.appendChild(el("p", "hint", "No votes are recorded for this round right now."));
      c.appendChild(
        button(
          "Restart This Vote",
          () => facade.startVoting(phase.stage, phase.candidates),
          "btn btn-primary btn-huge"
        )
      );
    }
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
  actions.appendChild(
    button(
      phase.stage === "initial" ? "Cancel Vote (back to Day)" : "Cancel Revote (back to tied vote)",
      () => facade.cancelCurrentSubPhase(),
      "btn"
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

  // Undo clears votingDraft unconditionally (it can't safely reconstruct an
  // arbitrary in-progress draft - see undoLastEvent()'s own doc), which can
  // leave this phase active with no draft to record hands into - the same
  // gap that used to make the OLD app get permanently stuck mid-vote.
  // getVoteRecoveryState() decides whether it's safe to restart this vote,
  // or whether it already resolved and just needs its elimination
  // re-recorded (restarting THEN would append an illegal duplicate vote
  // event for the round - see dayEliminationValidation.ts).
  if (!draft) {
    const recovery = facade.getVoteRecoveryState();
    if (recovery.kind === "decisive") {
      const eliminated = recovery.eliminated;
      c.appendChild(el("p", "hint", "This vote already decided an outcome (its elimination was undone) - record it again:"));
      c.appendChild(
        button(
          eliminated.length > 0 ? `Record Elimination: ${eliminated.join(", ")}` : "Record: Nobody Eliminated",
          () => facade.recordDayElimination(eliminated),
          "btn btn-primary btn-huge"
        )
      );
    } else {
      c.appendChild(el("p", "hint", "No hands are recorded for this keep-or-eliminate vote right now."));
      c.appendChild(button("Restart This Vote", () => facade.startKeepOrEliminateVote(phase.candidates), "btn btn-primary btn-huge"));
    }
    root.appendChild(c);
    return;
  }

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
  actions.appendChild(button("Cancel (back to tied revote)", () => facade.cancelCurrentSubPhase(), "btn"));
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

  c.appendChild(el("p", "hint", "Finish Game is never a dead end - resume the game if it isn't actually over."));
  c.appendChild(button("Resume Game", () => facade.resumeGame(), "btn btn-huge"));

  const outcomeRow = el("div", "field-row");
  outcomeRow.appendChild(el("label", "field-label", "Result"));
  const outcomeSelect = selectEl(OUTCOME_OPTIONS, session.confirmedOutcome ?? "unknown");
  outcomeSelect.onchange = () => safely(() => facade.finishGame(outcomeSelect.value as "townWon" | "mafiaWon" | "unknown"));
  outcomeRow.appendChild(outcomeSelect);
  c.appendChild(outcomeRow);
  c.appendChild(el("p", "hint", "Pick the actual result - there is no automatic suggestion anymore."));

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
        resetGameUiState();
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
        resetGameUiState();
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
      c.appendChild(
        el(
          "div",
          "info-row",
          `You were Player ${entry.session.myPlayerNumber}${entry.session.myRole ? ` (${entry.session.myRole})` : ""}`
        )
      );

      c.appendChild(el("h4", "subtitle", "Final roles"));
      const roles = el("div", "event-log");
      entry.session.config.players.forEach((player) => {
        const role = entry.session.finalRoles?.[player];
        const isMe = player === entry.session.myPlayerNumber;
        roles.appendChild(el("div", "info-row", `Player ${player}${isMe ? " (you)" : ""}: ${role ?? "not recorded"}`));
      });
      c.appendChild(roles);

      c.appendChild(el("h4", "subtitle", "Event log"));
      const log = el("div", "event-log");
      if (entry.session.eventLog.length === 0) log.appendChild(el("div", "info-row hint", "no events recorded"));
      entry.session.eventLog.forEach(({ event }, i) => {
        log.appendChild(el("div", "info-row", `${i + 1}. ${describeGameEvent(event)}`));
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
