"use strict";
(() => {
  // web/src/storageAdapter.ts
  var LocalStorageAdapter = class {
    getItem(key) {
      return window.localStorage.getItem(key);
    }
    setItem(key, value) {
      window.localStorage.setItem(key, value);
    }
    removeItem(key) {
      window.localStorage.removeItem(key);
    }
  };

  // src/roles.ts
  var defaultRoleRegistry = {
    citizen: {
      id: "citizen",
      team: "town",
      unique: false,
      mechanics: []
    },
    mafia: {
      id: "mafia",
      team: "mafia",
      unique: false,
      mechanics: [
        {
          mechanic: "unanimousNightKill",
          targetsPlayer: true,
          requiresTeamConsensus: true
        }
      ]
    },
    don: {
      id: "don",
      team: "mafia",
      unique: true,
      mechanics: [
        /**
         * The Don's private preselection of 3 kill targets, declared to the
         * moderator on the initial night and known to all Mafia. This entry
         * is intentionally declarative-only in the current engine: it does
         * not constrain resolveNight or enumerateHiddenNightActions (each
         * night's mafia kill still requires every living killer to
         * independently choose the same target, exactly as the rules
         * specify - the plan does not mechanically determine that choice),
         * and it does not create any public evidence (no Evidence type
         * reveals it, and none should - the public observer never learns
         * the plan). The current uniform ActionModel correspondingly does
         * not model any behavioral influence from Mafia knowing the plan.
         * Any future such effect belongs exclusively in an explicit,
         * opt-in ActionModel - never as a default assumption, and never as
         * a mechanical restriction, unless the game rules themselves
         * change.
         */
        { mechanic: "planTargets", targetsPlayer: true, usesPerGame: 1 },
        {
          mechanic: "unanimousNightKill",
          targetsPlayer: true,
          requiresTeamConsensus: true
        },
        { mechanic: "checkIsCommissioner", targetsPlayer: true }
      ]
    },
    doctor: {
      id: "doctor",
      team: "town",
      unique: true,
      mechanics: [
        {
          mechanic: "protect",
          targetsPlayer: true,
          noConsecutiveRepeatTarget: true
        }
      ]
    },
    commissioner: {
      id: "commissioner",
      team: "town",
      unique: true,
      mechanics: [{ mechanic: "checkIsMafia", targetsPlayer: true }]
    }
  };
  function hasMechanic(registry, role, mechanic) {
    return registry[role].mechanics.some((m) => m.mechanic === mechanic);
  }
  function validateGameConfig(config, registry) {
    const counts = /* @__PURE__ */ new Map();
    config.roles.forEach((role) => {
      counts.set(role, (counts.get(role) ?? 0) + 1);
    });
    for (const [role, count] of counts) {
      if (registry[role].unique && count > 1) {
        throw new Error(`Role "${role}" is unique but appears ${count} times`);
      }
    }
  }

  // src/facts.ts
  function initAliveState(config) {
    const state = {};
    config.players.forEach((player) => {
      state[player] = true;
    });
    return state;
  }
  function markDead(state, player) {
    return { ...state, [player]: false };
  }

  // src/voting.ts
  function livingPlayers(alive) {
    return Object.keys(alive).filter((p) => alive[p] === true);
  }
  function assertLivingParticipant(alive, player, what) {
    if (alive[player] !== true) {
      throw new Error(`${what} "${player}" is not a living player`);
    }
  }
  function validateCandidates(candidates, alive, minimum) {
    if (candidates.length < minimum) {
      throw new Error(
        `expected at least ${minimum} candidate(s), got ${candidates.length}`
      );
    }
    const seen = /* @__PURE__ */ new Set();
    candidates.forEach((candidate) => {
      if (seen.has(candidate)) {
        throw new Error(`candidate "${candidate}" is listed more than once`);
      }
      seen.add(candidate);
      assertLivingParticipant(alive, candidate, "candidate");
    });
  }
  function validateCandidateVote(vote, alive) {
    validateCandidates(vote.candidates, alive, vote.stage === "revote" ? 2 : 1);
    const voted = /* @__PURE__ */ new Set();
    Object.entries(vote.handsRaised).forEach(([candidate, voters]) => {
      if (!vote.candidates.includes(candidate)) {
        throw new Error(`hands raised for "${candidate}", who is not a candidate`);
      }
      (voters ?? []).forEach((voter) => {
        assertLivingParticipant(alive, voter, "voter");
        if (voted.has(voter)) {
          throw new Error(
            `voter "${voter}" raised a hand more than once in round ${vote.round} (${vote.stage})`
          );
        }
        voted.add(voter);
      });
    });
  }
  function tallyCandidateVote(vote, alive) {
    validateCandidateVote(vote, alive);
    const voted = new Set(
      Object.values(vote.handsRaised).flatMap((voters) => voters ?? [])
    );
    const abstainers = livingPlayers(alive).filter((p) => !voted.has(p));
    const last = vote.candidates[vote.candidates.length - 1];
    return {
      candidates: vote.candidates.map((candidate) => {
        const raisedHands = vote.handsRaised[candidate] ?? [];
        const abstentionVotes = candidate === last ? abstainers : [];
        return {
          candidate,
          raisedHands,
          abstentionVotes,
          count: raisedHands.length + abstentionVotes.length
        };
      }),
      abstainers
    };
  }
  function resolveCandidateVote(vote, alive) {
    const { candidates } = tallyCandidateVote(vote, alive);
    const highest = Math.max(...candidates.map((c) => c.count));
    const top = candidates.filter((c) => c.count === highest).map((c) => c.candidate);
    return top.length === 1 ? { kind: "winner", candidate: top[0] } : { kind: "tie", candidates: top };
  }
  function validateKeepOrEliminateVote(vote, alive) {
    validateCandidates(vote.candidates, alive, 2);
    const seen = /* @__PURE__ */ new Set();
    vote.eliminateHands.forEach((voter) => {
      assertLivingParticipant(alive, voter, "voter");
      if (seen.has(voter)) {
        throw new Error(
          `voter "${voter}" raised a hand more than once in round ${vote.round} (keepOrEliminate)`
        );
      }
      seen.add(voter);
    });
  }
  function tallyKeepOrEliminateVote(vote, alive) {
    validateKeepOrEliminateVote(vote, alive);
    const eliminate = new Set(vote.eliminateHands);
    return {
      eliminate: [...vote.eliminateHands],
      keep: livingPlayers(alive).filter((p) => !eliminate.has(p))
    };
  }
  function resolveKeepOrEliminateVote(vote, alive) {
    const { eliminate, keep } = tallyKeepOrEliminateVote(vote, alive);
    return {
      kind: eliminate.length > keep.length ? "eliminateAll" : "keepAll",
      candidates: [...vote.candidates]
    };
  }

  // src/dayEliminationValidation.ts
  function sameEliminatedSet(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    if (setA.size !== setB.size) return false;
    for (const p of setA) {
      if (!setB.has(p)) return false;
    }
    return true;
  }
  function requiredPredecessorKind(vote) {
    if (vote.type === "candidateVote" && vote.stage === "revote") return "initial";
    if (vote.type === "keepOrEliminateVote") return "revote";
    return "none";
  }
  function validateVoteChainStep(vote, precedingSameRoundVote, alive) {
    const requiredKind = requiredPredecessorKind(vote);
    const subject = vote.type === "candidateVote" ? vote.stage === "initial" ? `round ${vote.round}'s initial vote` : `round ${vote.round}'s revote` : `round ${vote.round}'s keepOrEliminateVote`;
    if (requiredKind === "none") {
      if (precedingSameRoundVote !== void 0) {
        throw new Error(`${subject} must be the first vote of its round, but a vote event already precedes it in round ${vote.round}`);
      }
      return;
    }
    if (precedingSameRoundVote === void 0 || precedingSameRoundVote.type !== "candidateVote" || precedingSameRoundVote.stage !== requiredKind) {
      throw new Error(`${subject} must immediately follow a ${requiredKind} candidateVote of the same round`);
    }
    const outcome = resolveCandidateVote(precedingSameRoundVote, alive);
    if (outcome.kind !== "tie") {
      throw new Error(`${subject} must follow a tie, but its preceding ${requiredKind} vote had a unique winner ("${outcome.candidate}")`);
    }
    if (!sameEliminatedSet(outcome.candidates, vote.candidates)) {
      throw new Error(`${subject}'s candidates [${vote.candidates.join(", ")}] do not match the preceding tie [${outcome.candidates.join(", ")}]`);
    }
  }
  function expectedElimination(vote, alive) {
    if (vote.type === "candidateVote") {
      const outcome2 = resolveCandidateVote(vote, alive);
      if (outcome2.kind === "tie") {
        throw new Error(
          `round ${vote.round}'s last recorded vote (stage=${vote.stage}) ended in a tie among [${outcome2.candidates.join(", ")}] with no revote or keep-or-eliminate vote recorded to resolve it`
        );
      }
      return [outcome2.candidate];
    }
    const outcome = resolveKeepOrEliminateVote(vote, alive);
    return outcome.kind === "eliminateAll" ? [...outcome.candidates] : [];
  }
  function validateDayElimination(fact, history, alive) {
    const dayVotes = history.filter((event) => event.round === fact.round);
    if (dayVotes.length === 0) {
      throw new Error(`dayElimination for round ${fact.round} has no preceding candidateVote or keepOrEliminateVote to validate against`);
    }
    dayVotes.forEach((vote, i) => validateVoteChainStep(vote, dayVotes[i - 1], alive));
    const decisive = dayVotes[dayVotes.length - 1];
    const expected = expectedElimination(decisive, alive);
    if (!sameEliminatedSet(expected, fact.eliminated)) {
      throw new Error(
        `dayElimination for round ${fact.round} (eliminated=[${fact.eliminated.join(", ")}]) is inconsistent with its resolved vote (expected=[${expected.join(", ")}])`
      );
    }
  }

  // src/describeGameEvent.ts
  function describeGameEvent(event) {
    switch (event.type) {
      case "selfRoleClaim":
        return `${event.actor} claims ${describeExpression(event.claim)}`;
      case "roleAssertion":
        return `${event.actor} asserts ${event.target} is ${describeExpression(event.claim)}`;
      case "investigationReport":
        return `${event.actor} reports ${event.mechanic} on ${event.target} = ${event.result ? "YES" : "NO"}`;
      case "suspect":
        return `${event.actor} suspects ${event.target}${describeIntensity(event.intensity)}`;
      case "defend":
        return `${event.actor} defends ${event.target}${describeIntensity(event.intensity)}`;
      case "nominate":
        return `${event.actor} nominates ${event.target}${describeIntensity(event.intensity)}`;
      case "candidateVote":
        return `vote (${event.stage}): ${describeHandsRaised(event)}`;
      case "keepOrEliminateVote":
        return `keep/eliminate vote: candidates=[${event.candidates.join(",")}], voted to eliminate: ${describePlayerList(event.eliminateHands)}`;
      case "nightResult":
        return `night ${event.round}: died=[${event.died.join(",")}]`;
      case "dayElimination":
        return `day ${event.round} elimination: [${event.eliminated.join(",")}]`;
    }
  }
  function describePlayerList(players) {
    return players.length > 0 ? players.join(", ") : "(nobody)";
  }
  function describeHandsRaised(vote) {
    return vote.candidates.map((candidate) => `${candidate} <- ${describePlayerList(vote.handsRaised[candidate] ?? [])}`).join("; ");
  }
  function describeExpression(expr) {
    return expr.kind === "role" ? expr.role : `<${expr.group}>`;
  }
  function describeIntensity(intensity) {
    if (intensity === void 0 || intensity === 3) return "";
    return ` (${"\u2605".repeat(intensity)}${"\u2606".repeat(5 - intensity)})`;
  }

  // src/relations/affinity.ts
  var ROUND_DECAY = 0.8;
  var AFFINITY_WEIGHTS = {
    /** A defends B. */
    defend: 3,
    /** A suspects/nominates B, or A raises a hand for B as a candidate/to eliminate B. */
    directOpposition: -3,
    /**
     * Total cooperation credit shared among every pair of players who
     * independently targeted (suspected/nominated/voted for) the same third
     * player in the same round - split evenly across however many pairs that
     * group actually has (see this file's own doc), so a 2-player
     * coincidence gets the full weight and a near-unanimous vote gets almost
     * none.
     */
    sharedTarget: 1
  };
  function bump(matrix, a, b, amount) {
    if (a === b) return;
    [
      [a, b],
      [b, a]
    ].forEach(([x, y]) => {
      const row = matrix.get(x) ?? /* @__PURE__ */ new Map();
      row.set(y, (row.get(y) ?? 0) + amount);
      matrix.set(x, row);
    });
  }
  function affinityBetween(matrix, a, b) {
    if (a === b) return 0;
    return matrix.get(a)?.get(b) ?? 0;
  }
  function recordTargeting(targetedBy, target, round, actor) {
    const key = `${target}#${round}`;
    const group = targetedBy.get(key) ?? { round, actors: /* @__PURE__ */ new Set() };
    group.actors.add(actor);
    targetedBy.set(key, group);
  }
  function decayFor(round, latestRound) {
    const age = Math.max(0, latestRound - round);
    return Math.pow(ROUND_DECAY, age);
  }
  var DEFAULT_INTENSITY = 3;
  function intensityMultiplier(intensity) {
    return (intensity ?? DEFAULT_INTENSITY) / DEFAULT_INTENSITY;
  }
  function computeAffinityMatrix(players, events) {
    const matrix = new Map(players.map((p) => [p, /* @__PURE__ */ new Map()]));
    const targetedBy = /* @__PURE__ */ new Map();
    const latestRound = events.reduce((max, e) => Math.max(max, e.round), 0);
    events.forEach((event) => {
      const decay = decayFor(event.round, latestRound);
      if (event.type === "defend") {
        bump(matrix, event.actor, event.target, AFFINITY_WEIGHTS.defend * decay * intensityMultiplier(event.intensity));
      } else if (event.type === "suspect" || event.type === "nominate") {
        bump(matrix, event.actor, event.target, AFFINITY_WEIGHTS.directOpposition * decay * intensityMultiplier(event.intensity));
        recordTargeting(targetedBy, event.target, event.round, event.actor);
      } else if (event.type === "candidateVote") {
        event.candidates.forEach((candidate) => {
          const voters = event.handsRaised[candidate] ?? [];
          voters.forEach((voter) => {
            bump(matrix, voter, candidate, AFFINITY_WEIGHTS.directOpposition * decay);
            recordTargeting(targetedBy, candidate, event.round, voter);
          });
        });
      } else if (event.type === "keepOrEliminateVote") {
        event.eliminateHands.forEach((voter) => {
          event.candidates.forEach((candidate) => {
            bump(matrix, voter, candidate, AFFINITY_WEIGHTS.directOpposition * decay);
          });
        });
      }
    });
    targetedBy.forEach(({ round, actors }) => {
      const list = [...actors];
      const pairCount = list.length * (list.length - 1) / 2;
      if (pairCount === 0) return;
      const perPairBonus = AFFINITY_WEIGHTS.sharedTarget / pairCount * decayFor(round, latestRound);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          bump(matrix, list[i], list[j], perPairBonus);
        }
      }
    });
    return matrix;
  }

  // src/relations/clustering.ts
  function detectTeams(players, matrix) {
    let clusters = players.map((p) => [p]);
    function interClusterAffinity(a, b) {
      let sum = 0;
      let count = 0;
      a.forEach((x) => {
        b.forEach((y) => {
          sum += affinityBetween(matrix, x, y);
          count += 1;
        });
      });
      return count === 0 ? 0 : sum / count;
    }
    for (; ; ) {
      let bestPair = null;
      let bestScore = 0;
      for (let i2 = 0; i2 < clusters.length; i2++) {
        for (let j2 = i2 + 1; j2 < clusters.length; j2++) {
          const score = interClusterAffinity(clusters[i2], clusters[j2]);
          if (score > bestScore) {
            bestScore = score;
            bestPair = [i2, j2];
          }
        }
      }
      if (!bestPair) break;
      const [i, j] = bestPair;
      const merged = [...clusters[i], ...clusters[j]];
      clusters = clusters.filter((_, index) => index !== i && index !== j);
      clusters.push(merged);
    }
    return clusters.map((cluster) => [...cluster].sort()).sort((a, b) => b.length !== a.length ? b.length - a.length : a[0].localeCompare(b[0]));
  }

  // src/relations/confirmedFacts.ts
  function deriveConfirmedTeams(events, myPlayerNumber, myRole, registry) {
    const result = {};
    if (myRole === null) return result;
    events.forEach((event) => {
      if (event.type !== "investigationReport") return;
      if (event.actor !== myPlayerNumber) return;
      if (!hasMechanic(registry, myRole, event.mechanic)) return;
      if (event.mechanic === "checkIsMafia") {
        result[event.target] = event.result ? "mafia" : "town";
      } else if (event.mechanic === "checkIsCommissioner" && event.result) {
        result[event.target] = "town";
      }
    });
    return result;
  }

  // src/app/types.ts
  var APP_SCHEMA_VERSION = 2;
  var CURRENT_ENGINE_VERSION = "2.0.0";
  function defaultRoleCountsForPlayerCount(playerCount) {
    return {
      don: 1,
      commissioner: 1,
      doctor: 1,
      mafia: playerCount >= 9 ? 2 : 1,
      citizen: playerCount - (1 + 1 + 1 + (playerCount >= 9 ? 2 : 1))
    };
  }
  function buildGameConfig(playerCount, counts) {
    const roles = [
      ...Array(counts.don).fill("don"),
      ...Array(counts.mafia).fill("mafia"),
      ...Array(counts.commissioner).fill("commissioner"),
      ...Array(counts.doctor).fill("doctor"),
      ...Array(counts.citizen).fill("citizen")
    ];
    const players = Array.from({ length: playerCount }, (_, i) => String(i + 1));
    return { players, roles };
  }
  function getAppScreen(state) {
    return state.currentGame ? "GAME" : "MENU";
  }

  // src/app/storage.ts
  var APP_STATE_STORAGE_KEY = "mafiaPredictor.appState";
  var CURRENT_APP_VERSION = "2.0.0";
  function emptyAppState() {
    return { schemaVersion: APP_SCHEMA_VERSION, appVersion: CURRENT_APP_VERSION, currentGame: null, history: [] };
  }
  var MIGRATIONS = {
    // no migrations needed yet - schemaVersion 1 is the first shape.
  };
  function loadAppState(storage2) {
    const raw = storage2.getItem(APP_STATE_STORAGE_KEY);
    if (raw === null) return emptyAppState();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyAppState();
    }
    if (typeof parsed !== "object" || parsed === null || typeof parsed.schemaVersion !== "number") {
      return emptyAppState();
    }
    let state = parsed;
    while (state.schemaVersion < APP_SCHEMA_VERSION) {
      const migrate = MIGRATIONS[state.schemaVersion];
      if (!migrate) {
        return emptyAppState();
      }
      state = migrate(state);
    }
    return state;
  }
  function saveAppState(storage2, state) {
    storage2.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
  }

  // src/app/gameFacade.ts
  var GameFacadeError = class extends Error {
  };
  function eventInvolvesPlayer(event, player) {
    switch (event.type) {
      case "selfRoleClaim":
        return event.actor === player;
      case "roleAssertion":
      case "investigationReport":
      case "suspect":
      case "defend":
      case "nominate":
        return event.actor === player || event.target === player;
      case "candidateVote":
        return event.candidates.includes(player) || Object.values(event.handsRaised).some((voters) => (voters ?? []).includes(player));
      case "keepOrEliminateVote":
        return event.candidates.includes(player) || event.eliminateHands.includes(player);
      case "nightResult":
        return event.died.includes(player);
      case "dayElimination":
        return event.eliminated.includes(player);
    }
  }
  var MafiaPredictorFacade = class {
    constructor(storage2) {
      this.storage = storage2;
      this.state = loadAppState(storage2);
    }
    // ============================================================
    // Internal helpers
    // ============================================================
    persist() {
      saveAppState(this.storage, this.state);
    }
    requireGame() {
      if (!this.state.currentGame) throw new GameFacadeError("no game in progress");
      return this.state.currentGame;
    }
    updateSession(session) {
      this.state = { ...this.state, currentGame: { ...session, updatedAt: (/* @__PURE__ */ new Date()).toISOString() } };
      this.persist();
    }
    requireDayRound(session) {
      if (session.uiPhase.kind !== "day") {
        throw new GameFacadeError(`this action requires the "day" phase, current phase is "${session.uiPhase.kind}"`);
      }
      return session.uiPhase.round;
    }
    /** The current day's round number, valid from any of this day's decision-making sub-phases ("day" itself, an in-progress candidateVote, or an in-progress keepOrEliminateVote). */
    requireDayRound2(session) {
      if (session.uiPhase.kind === "day" || session.uiPhase.kind === "voting" || session.uiPhase.kind === "keepOrEliminateVoting") {
        return session.uiPhase.round;
      }
      throw new GameFacadeError(`this action requires the "day", "voting", or "keepOrEliminateVoting" phase, current phase is "${session.uiPhase.kind}"`);
    }
    /** Alive state after EVERY recorded event so far. Throws if the log is somehow inconsistent (a player dying twice) - defensive; appendEvent already validates before anything is committed. */
    currentAliveState(session) {
      let alive = initAliveState(session.config);
      session.eventLog.forEach(({ event }) => {
        if (event.type === "nightResult") {
          event.died.forEach((p) => {
            if (alive[p] === false) throw new GameFacadeError(`player "${p}" died but was already dead`);
            alive = markDead(alive, p);
          });
        }
        if (event.type === "dayElimination") {
          event.eliminated.forEach((p) => {
            if (alive[p] === false) throw new GameFacadeError(`player "${p}" was eliminated but was already dead`);
            alive = markDead(alive, p);
          });
        }
      });
      return alive;
    }
    /**
     * Appends `event`, validating it BEFORE committing - throws (and leaves
     * `session` untouched) on an invalid event. Replaces the old Bayesian
     * facade's "dry-run computeSteps()" validation with direct, deterministic
     * checks: the actor (for a single-actor Observation) must be alive right
     * now, a dayElimination must match its round's actual vote chain
     * (validateDayElimination), and any death must not double-kill someone
     * (currentAliveState's own guard).
     */
    appendEvent(session, event) {
      if (event.type !== "candidateVote" && event.type !== "keepOrEliminateVote" && event.type !== "nightResult" && event.type !== "dayElimination") {
        const alive = this.currentAliveState(session);
        if (alive[event.actor] !== true) {
          throw new GameFacadeError(`"${event.actor}" is dead and cannot produce a new action`);
        }
      }
      const entry = { event, uiPhaseBefore: session.uiPhase };
      const candidate = { ...session, eventLog: [...session.eventLog, entry] };
      if (event.type === "dayElimination") {
        const votesThisRound = candidate.eventLog.map((e) => e.event).filter((e) => e.type === "candidateVote" || e.type === "keepOrEliminateVote");
        validateDayElimination(event, votesThisRound, this.currentAliveState(session));
      }
      this.currentAliveState(candidate);
      return candidate;
    }
    requireVotingDraft(session, kind) {
      if (!session.votingDraft || session.votingDraft.kind !== kind) {
        throw new GameFacadeError(`no in-progress ${kind} draft`);
      }
      return session.votingDraft;
    }
    // ============================================================
    // Menu / lifecycle
    // ============================================================
    getAppScreen() {
      return getAppScreen(this.state);
    }
    /** Everything about the current session a UI needs to render config/phase/history summaries, EXCLUDING `myRole`'s actual value (only whether it's been set). */
    getPublicSessionView() {
      const s = this.requireGame();
      return {
        config: s.config,
        myPlayerNumber: s.myPlayerNumber,
        hasMyRole: s.myRole !== null,
        uiPhase: s.uiPhase,
        votingDraft: s.votingDraft,
        finalRoles: s.finalRoles,
        confirmedOutcome: s.confirmedOutcome,
        eventCount: s.eventLog.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        engineVersion: s.engineVersion
      };
    }
    /** Every distinct role in this game's configuration - for a role picker. */
    getRoleOptions() {
      const s = this.requireGame();
      return Array.from(new Set(s.config.roles));
    }
    createGame(setup) {
      const config = buildGameConfig(setup.playerCount, setup.roleCounts);
      validateGameConfig(config, defaultRoleRegistry);
      if (config.players.length !== config.roles.length) {
        throw new GameFacadeError(
          `role counts must add up to exactly the player count (got ${config.roles.length} roles for ${config.players.length} players)`
        );
      }
      if (!config.players.includes(setup.myPlayerNumber)) {
        throw new GameFacadeError(`myPlayerNumber "${setup.myPlayerNumber}" is not one of this game's players`);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const session = {
        schemaVersion: APP_SCHEMA_VERSION,
        engineVersion: CURRENT_ENGINE_VERSION,
        createdAt: now,
        updatedAt: now,
        config,
        myPlayerNumber: setup.myPlayerNumber,
        myRole: null,
        eventLog: [],
        uiPhase: { kind: "day", round: 0 },
        votingDraft: null,
        phaseBeforeFinish: null,
        finalRoles: null,
        confirmedOutcome: null
      };
      this.state = { ...this.state, currentGame: session };
      this.persist();
    }
    setPlayerRole(role) {
      const session = this.requireGame();
      if (!session.config.roles.includes(role)) throw new GameFacadeError(`role "${role}" is not part of this game's configuration`);
      this.updateSession({ ...session, myRole: role });
    }
    discardGame() {
      this.state = { ...this.state, currentGame: null };
      this.persist();
    }
    saveGameToHistory() {
      const session = this.requireGame();
      const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, savedAt: (/* @__PURE__ */ new Date()).toISOString(), session };
      this.state = { ...this.state, currentGame: null, history: [...this.state.history, entry] };
      this.persist();
    }
    // ============================================================
    // Day / night
    // ============================================================
    getCurrentPhase() {
      return this.requireGame().uiPhase;
    }
    /**
     * True while the current phase was entered by a pure phase transition
     * (startNight/startVoting/startKeepOrEliminateVote) that never appended
     * an event - i.e. there is nothing for undoLastEvent() to undo, but the
     * phase itself can still be backed out of accident-free via
     * cancelCurrentSubPhase(). False for "day" (there is nothing to cancel
     * back to) and "finished" (use resumeGame() instead).
     */
    canCancelCurrentPhase() {
      return this.requireGame().uiPhase.kind !== "day" && this.requireGame().uiPhase.kind !== "finished";
    }
    /**
     * Backs out of an accidentally-started night/vote/keep-or-eliminate vote,
     * discarding any in-progress draft, WITHOUT recording anything - safe
     * specifically because startNight()/startVoting()/startKeepOrEliminateVote()
     * only ever change `uiPhase`, they never append an event (see each of
     * their own docs), so there is nothing in the event log to undo. Reverts
     * to exactly the phase that started this one:
     *  - "night" -> the day it was started from
     *  - "voting" (initial) -> that same day
     *  - "voting" (revote) -> the tied initial vote (its event is still in
     *    the log, so the UI's existing "noDraft"/getVoteRecoveryState()
     *    handling picks it back up as "tied", offering the same next steps)
     *  - "keepOrEliminateVoting" -> the tied revote, the same way
     */
    cancelCurrentSubPhase() {
      const session = this.requireGame();
      const phase = session.uiPhase;
      let target;
      if (phase.kind === "night") {
        target = { kind: "day", round: phase.round - 1 };
      } else if (phase.kind === "voting" && phase.stage === "initial") {
        target = { kind: "day", round: phase.round };
      } else if (phase.kind === "voting" && phase.stage === "revote") {
        target = { kind: "voting", round: phase.round, stage: "initial", candidates: phase.candidates };
      } else if (phase.kind === "keepOrEliminateVoting") {
        target = { kind: "voting", round: phase.round, stage: "revote", candidates: phase.candidates };
      } else {
        throw new GameFacadeError(`cancelCurrentSubPhase() has nothing to cancel from the "${phase.kind}" phase`);
      }
      this.updateSession({ ...session, uiPhase: target, votingDraft: null });
    }
    startNight() {
      const session = this.requireGame();
      const round = this.requireDayRound(session);
      this.updateSession({ ...session, uiPhase: { kind: "night", round: round + 1 } });
    }
    /** Records this night's deaths (may be empty) and advances to the following day. */
    confirmNightDeaths(deadPlayers) {
      const session = this.requireGame();
      if (session.uiPhase.kind !== "night") throw new GameFacadeError(`confirmNightDeaths() requires the "night" phase, current phase is "${session.uiPhase.kind}"`);
      const round = session.uiPhase.round;
      const withEvent = this.appendEvent(session, { type: "nightResult", round, died: [...deadPlayers] });
      this.updateSession({ ...withEvent, uiPhase: { kind: "day", round } });
    }
    // ============================================================
    // Day actions (suspect/defend/nominate) and claims
    // ============================================================
    /** `intensity` (1-5 stars, defaults to 3) is how confidently the actor means this - see ActionIntensity's own doc and relations/affinity.ts's use of it. */
    recordAction(actor, type, target, intensity) {
      const session = this.requireGame();
      const round = this.requireDayRound(session);
      this.updateSession(this.appendEvent(session, { type, round, actor, target, intensity }));
    }
    recordSelfRoleClaim(actor, claim) {
      const session = this.requireGame();
      const round = this.requireDayRound(session);
      this.updateSession(this.appendEvent(session, { type: "selfRoleClaim", round, actor, claim }));
    }
    recordRoleAssertion(actor, target, claim) {
      const session = this.requireGame();
      const round = this.requireDayRound(session);
      this.updateSession(this.appendEvent(session, { type: "roleAssertion", round, actor, target, claim }));
    }
    recordInvestigationReport(actor, target, mechanic, result, night) {
      const session = this.requireGame();
      const round = this.requireDayRound(session);
      this.updateSession(this.appendEvent(session, { type: "investigationReport", round, actor, target, mechanic, result, night }));
    }
    // ============================================================
    // Voting
    // ============================================================
    startVoting(stage, candidates) {
      const session = this.requireGame();
      const round = this.requireDayRound2(session);
      this.updateSession({
        ...session,
        uiPhase: { kind: "voting", round, stage, candidates: [...candidates] },
        votingDraft: { kind: "candidateVote", candidates: [...candidates], handsRaised: {} }
      });
    }
    recordHandsForCandidate(candidate, voters) {
      const session = this.requireGame();
      const draft = this.requireVotingDraft(session, "candidateVote");
      this.updateSession({ ...session, votingDraft: { ...draft, handsRaised: { ...draft.handsRaised, [candidate]: [...voters] } } });
    }
    confirmVote() {
      const session = this.requireGame();
      if (session.uiPhase.kind !== "voting") throw new GameFacadeError('confirmVote() requires the "voting" phase');
      const draft = this.requireVotingDraft(session, "candidateVote");
      const event = { type: "candidateVote", round: session.uiPhase.round, stage: session.uiPhase.stage, candidates: draft.candidates, handsRaised: draft.handsRaised };
      const withEvent = this.appendEvent(session, event);
      this.updateSession({ ...withEvent, votingDraft: null });
      const alive = this.currentAliveState(withEvent);
      return resolveCandidateVote(event, alive);
    }
    /** Vote tally so far (including inferred abstention-to-last-candidate) for the in-progress draft. */
    getVoteTallySoFar() {
      const session = this.requireGame();
      if (session.uiPhase.kind !== "voting") throw new GameFacadeError('getVoteTallySoFar() requires the "voting" phase');
      const draft = this.requireVotingDraft(session, "candidateVote");
      const alive = this.currentAliveState(session);
      const provisional = { type: "candidateVote", round: session.uiPhase.round, stage: session.uiPhase.stage, candidates: draft.candidates, handsRaised: draft.handsRaised };
      return tallyCandidateVote(provisional, alive).candidates;
    }
    startKeepOrEliminateVote(candidates) {
      const session = this.requireGame();
      const round = this.requireDayRound2(session);
      this.updateSession({
        ...session,
        uiPhase: { kind: "keepOrEliminateVoting", round, candidates: [...candidates] },
        votingDraft: { kind: "keepOrEliminateVote", candidates: [...candidates], eliminateHands: [] }
      });
    }
    recordEliminateHands(voters) {
      const session = this.requireGame();
      const draft = this.requireVotingDraft(session, "keepOrEliminateVote");
      this.updateSession({ ...session, votingDraft: { ...draft, eliminateHands: [...voters] } });
    }
    confirmKeepOrEliminateVote() {
      const session = this.requireGame();
      if (session.uiPhase.kind !== "keepOrEliminateVoting") throw new GameFacadeError('confirmKeepOrEliminateVote() requires the "keepOrEliminateVoting" phase');
      const draft = this.requireVotingDraft(session, "keepOrEliminateVote");
      const event = { type: "keepOrEliminateVote", round: session.uiPhase.round, candidates: draft.candidates, eliminateHands: draft.eliminateHands };
      const withEvent = this.appendEvent(session, event);
      this.updateSession({ ...withEvent, votingDraft: null });
      const alive = this.currentAliveState(withEvent);
      return resolveKeepOrEliminateVote(event, alive);
    }
    /**
     * When the "voting"/"keepOrEliminateVoting" phase has no in-progress
     * draft (votingDraft === null) - either because the vote was just
     * confirmed, or because Undo removed some later event - tells the UI
     * what's safe to do next:
     *  - "noRecordedVote": no vote event for this exact round+stage/kind
     *    exists yet (a fresh phase, or Undo removed the vote event itself) -
     *    starting a brand new vote here is safe.
     *  - "tied": the last recorded vote for this round+stage already exists
     *    and tied - the existing "move to revote/keep-or-eliminate" UI
     *    applies, nothing to record yet.
     *  - "decisive": the last recorded vote for this round already exists
     *    and resolved decisively (a winner, or eliminateAll/keepAll) -
     *    `eliminated` is what recordDayElimination() should be called with.
     *    Starting a NEW vote here instead would append a second vote event
     *    for the same round+stage, which dayEliminationValidation.ts then
     *    correctly rejects as an illegal chain - this is how the UI avoids
     *    ever offering that trap.
     */
    getVoteRecoveryState() {
      const session = this.requireGame();
      const last = session.eventLog[session.eventLog.length - 1]?.event;
      const alive = this.currentAliveState(session);
      if (session.uiPhase.kind === "voting" && last?.type === "candidateVote" && last.round === session.uiPhase.round && last.stage === session.uiPhase.stage) {
        const outcome = resolveCandidateVote(last, alive);
        return outcome.kind === "tie" ? { kind: "tied" } : { kind: "decisive", eliminated: [outcome.candidate] };
      }
      if (session.uiPhase.kind === "keepOrEliminateVoting" && last?.type === "keepOrEliminateVote" && last.round === session.uiPhase.round) {
        const outcome = resolveKeepOrEliminateVote(last, alive);
        return { kind: "decisive", eliminated: outcome.kind === "eliminateAll" ? [...outcome.candidates] : [] };
      }
      return { kind: "noRecordedVote" };
    }
    /** Finalizes the day's elimination (possibly empty) and returns to the "day" phase for the SAME round. */
    recordDayElimination(eliminated) {
      const session = this.requireGame();
      const round = this.requireDayRound2(session);
      const withEvent = this.appendEvent(session, { type: "dayElimination", round, eliminated: [...eliminated] });
      this.updateSession({ ...withEvent, uiPhase: { kind: "day", round } });
    }
    // ============================================================
    // Finish game - fully manual, always resumable (see this redesign's own
    // notes: there is no more world-tracking to auto-suggest a winner from,
    // and the old auto-suggestion was itself a source of real bugs).
    // ============================================================
    finishGame(confirmedOutcome) {
      const session = this.requireGame();
      const phaseBeforeFinish = session.uiPhase.kind === "finished" ? session.phaseBeforeFinish : session.uiPhase;
      const finalRoles = session.finalRoles ?? Object.fromEntries(session.config.players.map((p) => [p, p === session.myPlayerNumber && session.myRole ? session.myRole : "citizen"]));
      this.updateSession({ ...session, uiPhase: { kind: "finished" }, phaseBeforeFinish, confirmedOutcome, finalRoles });
    }
    /** Returns to the live game exactly where Finish Game was called from - Finish Game must never be a dead end. */
    resumeGame() {
      const session = this.requireGame();
      if (session.uiPhase.kind !== "finished") throw new GameFacadeError('resumeGame() requires the "finished" phase');
      if (!session.phaseBeforeFinish) throw new GameFacadeError("no phase to resume to");
      this.updateSession({ ...session, uiPhase: session.phaseBeforeFinish, phaseBeforeFinish: null });
    }
    setFinalRole(player, role) {
      const session = this.requireGame();
      if (!session.config.players.includes(player)) throw new GameFacadeError(`"${player}" is not one of this game's players`);
      this.updateSession({ ...session, finalRoles: { ...session.finalRoles ?? {}, [player]: role } });
    }
    // ============================================================
    // Undo
    // ============================================================
    /**
     * Undoes the most recently CONFIRMED event: drops it from eventLog and
     * restores uiPhase to exactly what it was immediately before that event.
     * Safe by construction: undo only ever removes the LAST event, and
     * nothing later in the log can depend on it. Does NOT touch myRole/
     * finalRoles/confirmedOutcome/votingDraft - those are simple idempotent
     * setters a caller corrects by calling them again.
     */
    undoLastEvent() {
      const session = this.requireGame();
      if (session.eventLog.length === 0) throw new GameFacadeError("no events to undo");
      const last = session.eventLog[session.eventLog.length - 1];
      const candidate = { ...session, eventLog: session.eventLog.slice(0, -1), uiPhase: last.uiPhaseBefore, votingDraft: null };
      this.currentAliveState(candidate);
      this.updateSession(candidate);
    }
    canUndo() {
      const session = this.requireGame();
      return session.eventLog.length > 0;
    }
    // ============================================================
    // Read-only relationship views
    // ============================================================
    getEventLog() {
      return this.requireGame().eventLog.map(({ event }) => ({ event, description: describeGameEvent(event) }));
    }
    affinityMatrix(session) {
      return computeAffinityMatrix(session.config.players, session.eventLog.map((e) => e.event));
    }
    /**
     * Arrows (one per individual suspect/nominate/defend action - see
     * RelationshipArrow's own doc), detected teams (dynamic clustering, see
     * relations/clustering.ts), and confirmed team facts (see relations/
     * confirmedFacts.ts) - the UI's single entry point for everything the
     * player circle and team panel need. EXCLUDES the viewer's own player
     * from `confirmedTeams`/team membership is not filtered here (the UI
     * decides how to render its own seat), but confirmedTeams never includes
     * information the viewer doesn't already know some other way (it is
     * derived only from the viewer's OWN recorded investigation reports).
     */
    getRelationshipView() {
      const session = this.requireGame();
      const events = session.eventLog.map((e) => e.event);
      const arrows = [];
      events.forEach((event, i) => {
        if (event.type === "suspect" || event.type === "nominate") {
          arrows.push({ id: `${i}`, type: "attack", eventType: event.type, actor: event.actor, target: event.target, round: event.round });
        } else if (event.type === "defend") {
          arrows.push({ id: `${i}`, type: "support", eventType: "defend", actor: event.actor, target: event.target, round: event.round });
        }
      });
      const matrix = this.affinityMatrix(session);
      const teams = detectTeams(session.config.players, matrix).map((members) => ({ members }));
      const confirmedTeams = deriveConfirmedTeams(events, session.myPlayerNumber, session.myRole, defaultRoleRegistry);
      return { arrows, teams, confirmedTeams };
    }
    /** Throws for myPlayerNumber - the caller must never route its own player through the shared "player info" screen. */
    getPlayerInfo(player) {
      const session = this.requireGame();
      if (player === session.myPlayerNumber) throw new GameFacadeError("cannot expose your own player info");
      const alive = this.currentAliveState(session);
      const events = session.eventLog.map((e) => e.event).filter((e) => eventInvolvesPlayer(e, player));
      const matrix = this.affinityMatrix(session);
      const confirmedTeams = deriveConfirmedTeams(session.eventLog.map((e) => e.event), session.myPlayerNumber, session.myRole, defaultRoleRegistry);
      const relationships = session.config.players.filter((p) => p !== player && p !== session.myPlayerNumber).map((other) => ({ other, score: affinityBetween(matrix, player, other) })).filter((r) => r.score !== 0).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
      return {
        player,
        alive: alive[player] === true,
        confirmedTeam: confirmedTeams[player],
        relationships,
        events: events.map((event) => ({ event, description: describeGameEvent(event) }))
      };
    }
    // ============================================================
    // History
    // ============================================================
    listHistory() {
      return this.state.history;
    }
    deleteHistoryEntry(id) {
      this.state = { ...this.state, history: this.state.history.filter((h) => h.id !== id) };
      this.persist();
    }
    clearHistory() {
      this.state = { ...this.state, history: [] };
      this.persist();
    }
    exportHistoryJson() {
      return JSON.stringify(this.state.history, null, 2);
    }
    /** Wipes ALL persisted application state (menu + any in-progress game + history). Reloading the page after this is the caller's (UI's) responsibility. */
    clearAllData() {
      this.state = { schemaVersion: APP_SCHEMA_VERSION, appVersion: this.state.appVersion, currentGame: null, history: [] };
      this.persist();
    }
  };

  // src/web/viewModel.ts
  function phaseLabel(phase) {
    switch (phase.kind) {
      case "day":
        return `Day ${phase.round + 1}`;
      case "night":
        return `Night ${phase.round}`;
      case "voting":
        return phase.stage === "initial" ? `Day ${phase.round + 1} - Voting` : `Day ${phase.round + 1} - Revote`;
      case "keepOrEliminateVoting":
        return `Day ${phase.round + 1} - Keep or Eliminate`;
      case "finished":
        return "Game Finished";
    }
  }
  function buildGameScreenViewModel(facade2) {
    const session = facade2.getPublicSessionView();
    const relationships = facade2.getRelationshipView();
    const allDead = /* @__PURE__ */ new Set();
    facade2.getEventLog().forEach(({ event }) => {
      if (event.type === "nightResult") event.died.forEach((d) => allDead.add(d));
      if (event.type === "dayElimination") event.eliminated.forEach((d) => allDead.add(d));
    });
    const players = session.config.players.map((player) => ({
      player,
      isMe: player === session.myPlayerNumber,
      alive: !allDead.has(player),
      confirmedTeam: relationships.confirmedTeams[player]
    }));
    return {
      phaseLabel: phaseLabel(session.uiPhase),
      phase: session.uiPhase,
      players,
      canUndo: facade2.canUndo(),
      arrows: relationships.arrows,
      teams: relationships.teams
    };
  }
  function buildRoleEntryViewModel(facade2) {
    const session = facade2.getPublicSessionView();
    return { needsRole: !session.hasMyRole, roleOptions: facade2.getRoleOptions() };
  }
  function buildHistoryListViewModel(facade2) {
    return facade2.listHistory().map((entry) => ({
      id: entry.id,
      savedAt: entry.savedAt,
      playerCount: entry.session.config.players.length,
      result: entry.session.confirmedOutcome ?? "unknown"
    }));
  }

  // src/web/votingDraftHelpers.ts
  function dedupeHandsRaised(candidates, handsRaised) {
    const seen = /* @__PURE__ */ new Set();
    const result = {};
    candidates.forEach((candidate) => {
      result[candidate] = (handsRaised[candidate] ?? []).filter((voter) => {
        if (seen.has(voter)) return false;
        seen.add(voter);
        return true;
      });
    });
    return result;
  }
  function handsRaisedHasDuplicateVoter(candidates, handsRaised) {
    const deduped = dedupeHandsRaised(candidates, handsRaised);
    return candidates.some((c) => (handsRaised[c]?.length ?? 0) !== (deduped[c]?.length ?? 0));
  }
  function voterAssignments(candidates, handsRaised) {
    const map = /* @__PURE__ */ new Map();
    candidates.forEach((candidate) => {
      (handsRaised[candidate] ?? []).forEach((voter) => map.set(voter, candidate));
    });
    return map;
  }
  function assignVoterHands(candidates, handsRaised, voter, candidate) {
    const result = {};
    candidates.forEach((c) => {
      const withoutVoter = (handsRaised[c] ?? []).filter((v) => v !== voter);
      result[c] = c === candidate ? [...withoutVoter, voter] : withoutVoter;
    });
    return result;
  }

  // web/src/app.ts
  var storage = new LocalStorageAdapter();
  var facade = new MafiaPredictorFacade(storage);
  var root = document.getElementById("app");
  var menuScreen = "MENU";
  var setupDraft = { playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) };
  var infoPlayer = null;
  var openHistoryId = null;
  var errorMessage = null;
  var selectedTeamIndex = null;
  var atMenuOverGame = false;
  function resetGameUiState() {
    infoPlayer = null;
    selectedTeamIndex = null;
  }
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== void 0) e.textContent = text;
    return e;
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag) {
    return document.createElementNS(SVG_NS, tag);
  }
  function button(label, onClick, className = "btn") {
    const b = el("button", className, label);
    b.onclick = () => safely(onClick);
    return b;
  }
  function toggleButton(label, onToggle, className = "btn player-select-btn") {
    const b = el("button", className, label);
    b.onclick = () => onToggle(b);
    return b;
  }
  function overlayButton(label, onOpen, className = "btn") {
    const b = el("button", className, label);
    b.onclick = onOpen;
    return b;
  }
  function safely(fn) {
    try {
      fn();
      errorMessage = null;
    } catch (e) {
      errorMessage = e instanceof GameFacadeError ? e.message : e instanceof Error ? e.message : String(e);
    }
    render();
  }
  function goToMenu() {
    if (facade.getAppScreen() === "GAME") {
      if (!window.confirm("Leave this game? Your current game will remain saved and can be continued.")) return;
    }
    atMenuOverGame = true;
    menuScreen = "MENU";
    resetGameUiState();
  }
  function backToMenuButton() {
    return button("Back to Menu", goToMenu, "btn btn-back-menu");
  }
  function selectEl(options, selected) {
    const s = el("select", "select");
    options.forEach((o) => {
      const opt = el("option", void 0, o.label);
      opt.value = o.value;
      if (o.value === selected) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }
  function render() {
    root.innerHTML = "";
    if (errorMessage) {
      const banner = el("div", "error-banner", errorMessage);
      root.appendChild(banner);
    }
    try {
      renderCurrentScreen();
    } catch (e) {
      renderCrashScreen(e);
    }
  }
  function renderCurrentScreen() {
    const hasActiveGame = facade.getAppScreen() === "GAME";
    if (!hasActiveGame || atMenuOverGame) {
      if (menuScreen === "MENU") renderMainMenu();
      else if (menuScreen === "HISTORY") renderHistory();
      else renderSetup();
      return;
    }
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
  function renderCrashScreen(e) {
    root.innerHTML = "";
    const c = el("div", "screen");
    c.appendChild(el("h2", "title", "Something went wrong"));
    c.appendChild(el("p", "error-banner", e instanceof Error ? e.message : String(e)));
    c.appendChild(el("p", "hint", "Nothing has been lost - your saved data is unchanged. Go back to the menu, or discard just this game if it's the one causing the problem."));
    const actions = el("div", "actions-row");
    actions.appendChild(button("Back to Menu", () => {
      atMenuOverGame = true;
      menuScreen = "MENU";
    }, "btn btn-huge"));
    if (facade.getAppScreen() === "GAME") {
      actions.appendChild(button("Discard This Game", () => {
        facade.discardGame();
        atMenuOverGame = false;
        menuScreen = "MENU";
        resetGameUiState();
      }, "btn btn-danger btn-huge"));
    }
    c.appendChild(actions);
    root.appendChild(c);
  }
  function renderMainMenu() {
    const c = el("div", "screen menu-screen");
    c.appendChild(el("h1", "title", "Mafia Predictor"));
    const hasActiveGame = facade.getAppScreen() === "GAME";
    if (hasActiveGame) {
      c.appendChild(button("Continue Game", () => {
        atMenuOverGame = false;
      }, "btn btn-primary btn-huge"));
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
    c.appendChild(button("Game History", () => {
      menuScreen = "HISTORY";
    }, "btn btn-huge"));
    c.appendChild(button("Clear All Data", onClearAllData, "btn btn-danger btn-huge"));
    root.appendChild(c);
  }
  function onClearAllData() {
    if (!window.confirm("This permanently deletes every saved game and any game in progress. Continue?")) return;
    facade.clearAllData();
    window.location.reload();
  }
  function renderSetup() {
    const c = el("div", "screen setup-screen");
    c.appendChild(el("h2", "title", "New Game Setup"));
    const playerCountRow = el("div", "field-row");
    playerCountRow.appendChild(el("label", "field-label", "Number of players"));
    const playerCountInput = el("input", "number-input");
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
    myPlayerSelect.onchange = () => {
      setupDraft.myPlayerNumber = myPlayerSelect.value;
    };
    myPlayerRow.appendChild(myPlayerSelect);
    c.appendChild(myPlayerRow);
    c.appendChild(el("h3", "subtitle", "Role configuration"));
    ["don", "mafia", "commissioner", "doctor", "citizen"].forEach((role) => {
      const row = el("div", "field-row");
      row.appendChild(el("label", "field-label", role));
      const input = el("input", "number-input");
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
        countsMatch ? `Total roles: ${roleTotal} / ${setupDraft.playerCount} players` : `Total roles (${roleTotal}) must equal the player count (${setupDraft.playerCount}) - adjust the counts above before starting.`
      )
    );
    const actions = el("div", "actions-row");
    actions.appendChild(button("Back", () => {
      menuScreen = "MENU";
      render();
    }));
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
  function renderRoleEntry() {
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
  function circlePosition(index, count) {
    const radiusPct = 42;
    const angle = 2 * Math.PI * index / count - Math.PI / 2;
    return { left: 50 + radiusPct * Math.cos(angle), top: 50 + radiusPct * Math.sin(angle) };
  }
  function arrowEndpoints(a, b) {
    const t0 = 0.14;
    const t1 = 0.86;
    return {
      x1: a.left + (b.left - a.left) * t0,
      y1: a.top + (b.top - a.top) * t0,
      x2: a.left + (b.left - a.left) * t1,
      y2: a.top + (b.top - a.top) * t1
    };
  }
  function buildArrowsSvg(vm, positions) {
    const svg = svgEl("svg");
    svg.setAttribute("class", "arrows-svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const defs = svgEl("defs");
    ["attack", "support"].forEach((kind) => {
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
  function buildTeamPanel(vm) {
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
            () => {
              selectedTeamIndex = selected ? null : i;
            },
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
  function attachDragHandlers(node, actor, isMe, circle) {
    node.addEventListener("pointerdown", (downEvent) => {
      downEvent.preventDefault();
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      let dragging = false;
      let ghost = null;
      let centerTarget = null;
      let hovered = null;
      function beginDrag() {
        dragging = true;
        ghost = el("div", "drag-ghost", "\u{1F464}");
        document.body.appendChild(ghost);
        centerTarget = el("div", "player-node center-drop-target");
        centerTarget.dataset.dropTarget = "self";
        centerTarget.appendChild(el("div", "player-icon", "\u{1F464}"));
        centerTarget.appendChild(el("div", "player-number", actor));
        circle.appendChild(centerTarget);
      }
      function findDropTarget(x, y) {
        const under = document.elementFromPoint(x, y);
        return under?.closest("[data-player],[data-drop-target]") ?? null;
      }
      function onMove(moveEvent) {
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
      function onUp(upEvent) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const target = dragging ? findDropTarget(upEvent.clientX, upEvent.clientY) : null;
        if (hovered) hovered.classList.remove("drop-hover");
        if (ghost) ghost.remove();
        if (centerTarget) centerTarget.remove();
        if (!dragging) {
          if (!isMe) {
            infoPlayer = actor;
            render();
          }
          return;
        }
        if (!target) return;
        if (target.dataset.dropTarget === "self") {
          showSelfClaimPopup(actor);
        } else if (target.dataset.player && target.dataset.player !== actor) {
          showActionTypePopup(actor, target.dataset.player);
        }
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }
  function renderMainGameScreen() {
    const vm = buildGameScreenViewModel(facade);
    const c = el("div", "screen game-screen");
    const header = el("div", "game-header");
    header.appendChild(backToMenuButton());
    header.appendChild(el("div", "phase-label", vm.phaseLabel));
    if (vm.canUndo) header.appendChild(button("Undo", () => facade.undoLastEvent(), "btn btn-undo"));
    c.appendChild(header);
    const circle = el("div", "player-circle");
    const positions = /* @__PURE__ */ new Map();
    vm.players.forEach((p, i) => positions.set(p.player, circlePosition(i, vm.players.length)));
    circle.appendChild(buildArrowsSvg(vm, positions));
    vm.players.forEach((p) => {
      const pos = positions.get(p.player);
      const node = el(
        "div",
        "player-node" + (p.isMe ? " player-node-me" : "") + (p.alive ? "" : " player-node-dead") + (p.confirmedTeam === "mafia" ? " player-node-confirmed-mafia" : "") + (p.confirmedTeam === "town" ? " player-node-confirmed-town" : "")
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
        node.onclick = () => {
          infoPlayer = p.player;
          render();
        };
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
  function renderPlayerInfoModal(player) {
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
    actions.appendChild(button("Close", () => {
      infoPlayer = null;
      render();
    }, "btn btn-huge"));
    actions.appendChild(backToMenuButton());
    box.appendChild(actions);
    overlay.appendChild(box);
    root.appendChild(overlay);
  }
  function renderActionHistoryModal() {
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
  function roleClaimSelect(session) {
    const roleOptions = Array.from(new Set(session.config.roles)).map((r) => ({ value: `role:${r}`, label: r }));
    const groupOptions = [
      { value: "group:mafia", label: "Mafia (group)" },
      { value: "group:town", label: "Town (group)" },
      { value: "group:activeTown", label: "Active Town - Doctor/Commissioner (group)" }
    ];
    return selectEl([...roleOptions, ...groupOptions]);
  }
  function parseClaim(value) {
    const [kind, name] = value.split(":");
    return kind === "role" ? { kind: "role", role: name } : { kind: "group", group: name };
  }
  function buildStarPicker(current, onChange) {
    const row = el("div", "star-picker");
    for (let n = 1; n <= 5; n++) {
      const star = overlayButton(n <= current ? "\u2605" : "\u2606", () => onChange(n), "btn star-btn" + (n <= current ? " star-btn-filled" : ""));
      row.appendChild(star);
    }
    return row;
  }
  function showActionTypePopup(actor, target) {
    const session = facade.getPublicSessionView();
    let step = "menu";
    let intensity = 3;
    const overlay = el("div", "modal-overlay");
    const box = el("div", "modal-box");
    function redraw() {
      box.innerHTML = "";
      box.appendChild(el("h3", "title", `Player ${actor} \u2192 Player ${target}`));
      if (step === "menu") {
        box.appendChild(el("p", "hint", "Confidence (used by Suspect/Defend/Nominate only):"));
        box.appendChild(buildStarPicker(intensity, (n) => {
          intensity = n;
          redraw();
        }));
        const typeGrid = el("div", "actions-row actions-wrap");
        ["suspect", "defend", "nominate"].forEach((type) => {
          const label = type[0].toUpperCase() + type.slice(1);
          typeGrid.appendChild(button(label, () => facade.recordAction(actor, type, target, intensity), "btn btn-huge"));
        });
        box.appendChild(typeGrid);
        const claimsRow = el("div", "actions-row actions-wrap");
        claimsRow.appendChild(overlayButton("Claim Role...", () => {
          step = "roleAssertion";
          redraw();
        }, "btn"));
        claimsRow.appendChild(overlayButton("Investigation Report...", () => {
          step = "investigationReport";
          redraw();
        }, "btn"));
        box.appendChild(claimsRow);
        box.appendChild(button("Cancel", () => render()));
      } else if (step === "roleAssertion") {
        box.appendChild(el("p", "hint", `Player ${actor} claims Player ${target} is...`));
        const claimSelect = roleClaimSelect(session);
        box.appendChild(claimSelect);
        const actions = el("div", "actions-row");
        actions.appendChild(overlayButton("Back", () => {
          step = "menu";
          redraw();
        }));
        actions.appendChild(button("Confirm", () => facade.recordRoleAssertion(actor, target, parseClaim(claimSelect.value)), "btn btn-primary btn-huge"));
        box.appendChild(actions);
      } else {
        box.appendChild(el("p", "hint", `Player ${actor} claims to have investigated Player ${target}...`));
        const mechSelect = selectEl([
          { value: "checkIsCommissioner", label: "Check Is Commissioner (Don)" },
          { value: "checkIsMafia", label: "Check Is Mafia (Commissioner)" }
        ]);
        box.appendChild(mechSelect);
        const resultSelect = selectEl([{ value: "true", label: "Yes" }, { value: "false", label: "No" }]);
        box.appendChild(resultSelect);
        const actions = el("div", "actions-row");
        actions.appendChild(overlayButton("Back", () => {
          step = "menu";
          redraw();
        }));
        actions.appendChild(
          button(
            "Confirm",
            () => facade.recordInvestigationReport(actor, target, mechSelect.value, resultSelect.value === "true"),
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
  function showSelfClaimPopup(actor) {
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
  function renderFinishGameOutcomePopup() {
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
  var deathSelection = /* @__PURE__ */ new Set();
  function renderDeathEntry() {
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
  function renderStartVotingOverlay() {
    const vm = buildGameScreenViewModel(facade);
    const alive = vm.players.filter((p) => p.alive).map((p) => p.player);
    const selection = /* @__PURE__ */ new Set();
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
  function renderCandidateVoting() {
    const session = facade.getPublicSessionView();
    const phase = session.uiPhase;
    const vm = buildGameScreenViewModel(facade);
    const alive = vm.players.filter((p) => p.alive).map((p) => p.player);
    const c = el("div", "screen voting-screen");
    c.appendChild(backToMenuButton());
    c.appendChild(el("h2", "title", phase.stage === "initial" ? "Voting" : "Revote"));
    const noDraft = session.votingDraft === null;
    if (noDraft) {
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
    const draft = session.votingDraft;
    if (handsRaisedHasDuplicateVoter(phase.candidates, draft.handsRaised)) {
      const repaired = dedupeHandsRaised(phase.candidates, draft.handsRaised);
      phase.candidates.forEach((candidate) => facade.recordHandsForCandidate(candidate, repaired[candidate] ?? []));
    }
    const hands = dedupeHandsRaised(phase.candidates, draft.handsRaised);
    const voterToCandidate = voterAssignments(phase.candidates, hands);
    function setVote(voter, candidate) {
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
  function renderTieFollowupOverlay(next) {
    const vm = buildGameScreenViewModel(facade);
    const alive = vm.players.filter((p) => p.alive).map((p) => p.player);
    const selection = /* @__PURE__ */ new Set();
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
  function renderKeepOrEliminateVoting() {
    const session = facade.getPublicSessionView();
    const phase = session.uiPhase;
    const vm = buildGameScreenViewModel(facade);
    const alive = vm.players.filter((p) => p.alive).map((p) => p.player);
    const draft = session.votingDraft && session.votingDraft.kind === "keepOrEliminateVote" ? session.votingDraft : null;
    const c = el("div", "screen voting-screen");
    c.appendChild(backToMenuButton());
    c.appendChild(el("h2", "title", `Keep or Eliminate: ${phase.candidates.join(", ")}`));
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
    const selected = new Set(draft?.eliminateHands ?? []);
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
  var OUTCOME_OPTIONS = [
    { value: "townWon", label: "Town Won" },
    { value: "mafiaWon", label: "Mafia Won" },
    { value: "unknown", label: "Unknown / not specified" }
  ];
  function renderFinishGame() {
    const session = facade.getPublicSessionView();
    const c = el("div", "screen finish-screen");
    c.appendChild(backToMenuButton());
    c.appendChild(el("h2", "title", "Game Finished"));
    c.appendChild(el("p", "hint", "Finish Game is never a dead end - resume the game if it isn't actually over."));
    c.appendChild(button("Resume Game", () => facade.resumeGame(), "btn btn-huge"));
    const outcomeRow = el("div", "field-row");
    outcomeRow.appendChild(el("label", "field-label", "Result"));
    const outcomeSelect = selectEl(OUTCOME_OPTIONS, session.confirmedOutcome ?? "unknown");
    outcomeSelect.onchange = () => safely(() => facade.finishGame(outcomeSelect.value));
    outcomeRow.appendChild(outcomeSelect);
    c.appendChild(outcomeRow);
    c.appendChild(el("p", "hint", "Pick the actual result - there is no automatic suggestion anymore."));
    c.appendChild(el("h3", "subtitle", "Enter each player's actual final role"));
    session.config.players.forEach((player) => {
      const row = el("div", "field-row");
      row.appendChild(el("label", "field-label", `Player ${player}`));
      const roleSelect = selectEl(facade.getRoleOptions().map((r) => ({ value: r, label: r })), session.finalRoles?.[player]);
      roleSelect.onchange = () => safely(() => facade.setFinalRole(player, roleSelect.value));
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
  function renderHistory() {
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
        c.appendChild(button("Back to list", () => {
          openHistoryId = null;
          render();
        }));
        root.appendChild(c);
        return;
      }
    }
    if (list.length === 0) c.appendChild(el("p", "hint", "No saved games yet."));
    list.forEach((entry) => {
      const row = el("div", "history-row");
      row.appendChild(el("div", "info-row", `${new Date(entry.savedAt).toLocaleString()} - ${entry.playerCount} players - ${entry.result}`));
      row.appendChild(button("Open", () => {
        openHistoryId = entry.id;
        render();
      }));
      c.appendChild(row);
    });
    const actions = el("div", "actions-row");
    actions.appendChild(overlayButton("Export All (JSON)", () => showExportModal(), "btn"));
    actions.appendChild(button("Delete All History", () => {
      if (!window.confirm("Delete ALL saved game history permanently?")) return;
      facade.clearHistory();
    }, "btn btn-danger"));
    actions.appendChild(button("Back", () => {
      menuScreen = "MENU";
      render();
    }));
    c.appendChild(actions);
    root.appendChild(c);
  }
  function showExportModal() {
    const json = facade.exportHistoryJson();
    const overlay = el("div", "modal-overlay");
    const box = el("div", "modal-box");
    box.appendChild(el("h3", "title", "Export History"));
    const textarea = el("textarea", "export-textarea");
    textarea.value = json;
    textarea.readOnly = true;
    box.appendChild(textarea);
    const actions = el("div", "actions-row");
    actions.appendChild(
      button("Copy to Clipboard", () => {
        navigator.clipboard?.writeText(json).catch(() => {
        });
      })
    );
    const nav = navigator;
    if (nav.share) {
      actions.appendChild(button("Share", () => nav.share({ title: "Mafia Predictor History", text: json }).catch(() => {
      })));
    }
    actions.appendChild(button("Close", () => render(), "btn btn-huge"));
    box.appendChild(actions);
    overlay.appendChild(box);
    root.appendChild(overlay);
  }
  render();
})();
