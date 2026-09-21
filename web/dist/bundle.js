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
  function sameTeam(registry, a, b) {
    return registry[a].team === registry[b].team;
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

  // src/roleGroups.ts
  function satisfiedBy(expr, actualRole, groups) {
    if (expr.kind === "role") {
      return actualRole === expr.role;
    }
    if (!groups) {
      throw new Error(
        `Cannot evaluate group expression "${expr.group}" without a GroupRegistry`
      );
    }
    return groups[expr.group].includes(actualRole);
  }
  function buildGroupRegistry(roles, customGroups) {
    const byTeam = {};
    Object.keys(roles).forEach((roleId) => {
      const team = roles[roleId].team;
      byTeam[team] = [...byTeam[team] ?? [], roleId];
    });
    return {
      mafia: byTeam.mafia ?? [],
      town: byTeam.town ?? [],
      ...customGroups
    };
  }
  var defaultGroupRegistry = buildGroupRegistry(
    defaultRoleRegistry,
    { activeTown: ["doctor", "commissioner"] }
  );

  // src/generateWorlds.ts
  function generateWorlds(config, registry = defaultRoleRegistry) {
    validateGameConfig(config, registry);
    const { players, roles } = config;
    if (players.length !== roles.length) {
      throw new Error(
        `players.length (${players.length}) must equal roles.length (${roles.length})`
      );
    }
    const roleAssignments = distinctPermutations(roles);
    const probability = 1 / roleAssignments.length;
    return roleAssignments.map((assignment) => {
      const worldRoles = {};
      players.forEach((player, i) => {
        worldRoles[player] = assignment[i];
      });
      return { roles: worldRoles, probability };
    });
  }
  function distinctPermutations(items) {
    const sorted = [...items].sort();
    const results = [];
    const used = new Array(sorted.length).fill(false);
    const current = [];
    function backtrack() {
      if (current.length === sorted.length) {
        results.push([...current]);
        return;
      }
      for (let i = 0; i < sorted.length; i++) {
        if (used[i]) continue;
        if (i > 0 && sorted[i] === sorted[i - 1] && !used[i - 1]) continue;
        used[i] = true;
        current.push(sorted[i]);
        backtrack();
        current.pop();
        used[i] = false;
      }
    }
    backtrack();
    return results;
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
  function isAlive(state, player) {
    return state[player];
  }
  function assertAlive(state, player) {
    if (!isAlive(state, player)) {
      throw new Error(`${player} is dead and cannot produce new observations`);
    }
  }
  function phaseIndex({ phase, round }) {
    return phase === "night" ? 2 * round - 1 : 2 * round;
  }
  function assertValidPhase({ phase, round }) {
    if (!Number.isInteger(round) || round < (phase === "night" ? 1 : 0)) {
      throw new Error(`invalid ${phase} round ${round}`);
    }
  }
  function getPhaseOf(evidence) {
    const phase = evidence.type === "nightResult" ? { phase: "night", round: evidence.round } : { phase: "day", round: evidence.round };
    assertValidPhase(phase);
    if (evidence.type === "investigationReport" && evidence.night !== void 0) {
      const { night, round } = evidence;
      if (!Number.isInteger(night) || night < 1 || night > round) {
        throw new Error(
          `invalid investigationReport night ${night} for a report on day ${round}`
        );
      }
    }
    return phase;
  }
  function getAliveStateAt(config, history, at) {
    assertValidPhase(at);
    const target = phaseIndex(at);
    const deathsByPhase = /* @__PURE__ */ new Map();
    history.forEach((event) => {
      if (event.type !== "nightResult" && event.type !== "dayElimination") {
        return;
      }
      const index = phaseIndex(getPhaseOf(event));
      if (deathsByPhase.has(index)) {
        throw new Error(`more than one ${event.type} fact for round ${event.round}`);
      }
      deathsByPhase.set(
        index,
        event.type === "nightResult" ? event.died : event.eliminated
      );
    });
    let alive = initAliveState(config);
    [...deathsByPhase.keys()].filter((index) => index < target).sort((a, b) => a - b).forEach((index) => {
      deathsByPhase.get(index).forEach((player) => {
        if (alive[player] === void 0) {
          throw new Error(`unknown player "${player}" in a death fact`);
        }
        if (!alive[player]) {
          throw new Error(`player "${player}" died but was already dead`);
        }
        alive = markDead(alive, player);
      });
    });
    return alive;
  }
  function getAliveStateForEvidence(config, history, evidence) {
    return getAliveStateAt(config, history, getPhaseOf(evidence));
  }
  function getHistoryBefore(history, index) {
    if (!Number.isInteger(index) || index < 0 || index >= history.length) {
      throw new Error(`history index ${index} is out of range`);
    }
    const current = getPhaseOf(history[index]);
    const before = history.slice(0, index);
    before.forEach((event, i) => {
      const phase = getPhaseOf(event);
      if (phaseIndex(phase) > phaseIndex(current)) {
        throw new Error(
          `history[${i}] (${event.type}, ${phase.phase} ${phase.round}) is recorded before history[${index}] (${history[index].type}, ${current.phase} ${current.round}) but belongs to a later phase`
        );
      }
    });
    return before;
  }

  // src/updateProbabilities.ts
  function updateProbabilities(worlds, evidence, model, ctx) {
    const weighted = worlds.map((world) => ({
      ...world,
      probability: world.probability * model.likelihood(evidence, world, ctx)
    }));
    const total = weighted.reduce((sum, world) => sum + world.probability, 0);
    if (total === 0) {
      throw new Error(
        "Observation is inconsistent with every remaining world (total likelihood is 0)"
      );
    }
    return weighted.map((world) => ({
      ...world,
      probability: world.probability / total
    }));
  }

  // src/processEvidence.ts
  function processEvidence(worlds, history, model, setting) {
    const steps = [];
    let prior = worlds;
    history.forEach((evidence, index) => {
      const before = getHistoryBefore(history, index);
      const context = {
        ...setting,
        alive: getAliveStateForEvidence(setting.config, before, evidence),
        history: before
      };
      const posterior = updateProbabilities(prior, evidence, model, context);
      steps.push({ index, evidence, context, prior, posterior });
      prior = posterior;
    });
    return steps;
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

  // src/dayEliminationLikelihood.ts
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
        throw new Error(
          `${subject} must be the first vote of its round, but a vote event already precedes it in round ${vote.round}`
        );
      }
      return;
    }
    if (precedingSameRoundVote === void 0 || precedingSameRoundVote.type !== "candidateVote" || precedingSameRoundVote.stage !== requiredKind) {
      throw new Error(
        `${subject} must immediately follow a ${requiredKind} candidateVote of the same round`
      );
    }
    const outcome = resolveCandidateVote(precedingSameRoundVote, alive);
    if (outcome.kind !== "tie") {
      throw new Error(
        `${subject} must follow a tie, but its preceding ${requiredKind} vote had a unique winner ("${outcome.candidate}")`
      );
    }
    if (!sameEliminatedSet(outcome.candidates, vote.candidates)) {
      throw new Error(
        `${subject}'s candidates [${vote.candidates.join(", ")}] do not match the preceding tie [${outcome.candidates.join(", ")}]`
      );
    }
  }
  function expectedElimination(vote, alive) {
    if (vote.type === "candidateVote") {
      const outcome2 = resolveCandidateVote(vote, alive);
      if (outcome2.kind === "tie") {
        throw new Error(
          `round ${vote.round}'s last recorded vote (stage=${vote.stage}) ended in a tie among [${outcome2.candidates.join(
            ", "
          )}] with no revote or keep-or-eliminate vote recorded to resolve it`
        );
      }
      return [outcome2.candidate];
    }
    const outcome = resolveKeepOrEliminateVote(vote, alive);
    return outcome.kind === "eliminateAll" ? [...outcome.candidates] : [];
  }
  function resolveDayElimination(fact, _world, ctx) {
    const dayVotes = ctx.history.filter(
      (event) => (event.type === "candidateVote" || event.type === "keepOrEliminateVote") && event.round === fact.round
    );
    if (dayVotes.length === 0) {
      throw new Error(
        `dayElimination for round ${fact.round} has no preceding candidateVote or keepOrEliminateVote to validate against`
      );
    }
    dayVotes.forEach((vote, i) => {
      validateVoteChainStep(vote, dayVotes[i - 1], ctx.alive);
    });
    const decisive = dayVotes[dayVotes.length - 1];
    const expected = expectedElimination(decisive, ctx.alive);
    if (!sameEliminatedSet(expected, fact.eliminated)) {
      throw new Error(
        `dayElimination for round ${fact.round} (eliminated=[${fact.eliminated.join(
          ", "
        )}]) is inconsistent with its resolved vote (expected=[${expected.join(", ")}])`
      );
    }
    return 1;
  }

  // src/evidence.ts
  function createLikelihoodModel(handlers, nightResultHandler = () => {
    throw new Error(
      "nightResult likelihood not implemented yet - requires a calibrated ActionModel"
    );
  }, behavioralEvidenceWeight = 1) {
    return {
      likelihood(evidence, world, ctx) {
        if (evidence.type === "nightResult") {
          return nightResultHandler(evidence, world, ctx);
        }
        if (evidence.type === "dayElimination") {
          return resolveDayElimination(evidence, world, ctx);
        }
        if (evidence.type !== "candidateVote" && evidence.type !== "keepOrEliminateVote") {
          assertAlive(ctx.alive, evidence.actor);
        }
        const handler = handlers[evidence.type];
        const raw = handler(evidence, world, ctx);
        return behavioralEvidenceWeight === 1 ? raw : raw ** behavioralEvidenceWeight;
      }
    };
  }

  // src/investigation.ts
  var DETECTED_MECHANIC = {
    checkIsCommissioner: "checkIsMafia",
    checkIsMafia: "unanimousNightKill"
  };
  function getInvestigationResult(registry, mechanic, targetRole) {
    return hasMechanic(registry, targetRole, DETECTED_MECHANIC[mechanic]);
  }

  // src/selfRoleClaimLikelihood.ts
  function resolve(value, observation, world, ctx) {
    return typeof value === "function" ? value(observation, world, ctx) : value;
  }
  function createSelfRoleClaimHandler(params) {
    return (observation, world, ctx) => satisfiedBy(observation.claim, world.roles[observation.actor], ctx.groups) ? resolve(params.truthful, observation, world, ctx) : resolve(params.false, observation, world, ctx);
  }

  // src/roleAssertionLikelihood.ts
  function resolve2(value, observation, world, ctx) {
    return typeof value === "function" ? value(observation, world, ctx) : value;
  }
  function createRoleAssertionHandler(params) {
    return (observation, world, ctx) => satisfiedBy(observation.claim, world.roles[observation.target], ctx.groups) ? resolve2(params.truthful, observation, world, ctx) : resolve2(params.false, observation, world, ctx);
  }

  // src/investigationReportLikelihood.ts
  function resolve3(value, observation, world, ctx) {
    return typeof value === "function" ? value(observation, world, ctx) : value;
  }
  function createInvestigationReportHandler(params) {
    return (observation, world, ctx) => {
      const canPerform = hasMechanic(
        ctx.roles,
        world.roles[observation.actor],
        observation.mechanic
      );
      if (!canPerform) {
        return resolve3(params.bluff, observation, world, ctx);
      }
      const matchesActual = getInvestigationResult(
        ctx.roles,
        observation.mechanic,
        world.roles[observation.target]
      ) === observation.result;
      return matchesActual ? resolve3(params.truthful, observation, world, ctx) : resolve3(params.falseResult, observation, world, ctx);
    };
  }

  // src/teamAlignmentLikelihood.ts
  function resolve4(value, observation, world, ctx) {
    return typeof value === "function" ? value(observation, world, ctx) : value;
  }
  function createTeamAlignmentHandler(params) {
    return (observation, world, ctx) => sameTeam(
      ctx.roles,
      world.roles[observation.actor],
      world.roles[observation.target]
    ) ? resolve4(params.sameTeam, observation, world, ctx) : resolve4(params.differentTeam, observation, world, ctx);
  }

  // src/candidateVoteLikelihood.ts
  function resolve5(value, observation, world, ctx, voter) {
    return typeof value === "function" ? value(observation, world, ctx, voter) : value;
  }
  function createCandidateVoteHandler(params) {
    return (observation, world, ctx) => {
      const tally = tallyCandidateVote(observation, ctx.alive);
      let likelihood = 1;
      tally.candidates.forEach((candidateTally) => {
        candidateTally.raisedHands.forEach((voter) => {
          const factor = sameTeam(
            ctx.roles,
            world.roles[voter],
            world.roles[candidateTally.candidate]
          ) ? params.sameTeamVote : params.differentTeamVote;
          likelihood *= resolve5(factor, observation, world, ctx, voter);
        });
      });
      tally.abstainers.forEach((voter) => {
        likelihood *= resolve5(params.abstain, observation, world, ctx, voter);
      });
      return likelihood;
    };
  }

  // src/keepOrEliminateVoteLikelihood.ts
  function resolve6(value, observation, world, ctx, voter) {
    return typeof value === "function" ? value(observation, world, ctx, voter) : value;
  }
  function createKeepOrEliminateVoteHandler(params) {
    return (observation, world, ctx) => {
      const tally = tallyKeepOrEliminateVote(observation, ctx.alive);
      const sharesTeamWithAnyCandidate = (voter) => observation.candidates.some(
        (candidate) => sameTeam(ctx.roles, world.roles[voter], world.roles[candidate])
      );
      let likelihood = 1;
      tally.eliminate.forEach((voter) => {
        const factor = sharesTeamWithAnyCandidate(voter) ? params.eliminateSharedTeam : params.eliminateNoSharedTeam;
        likelihood *= resolve6(factor, observation, world, ctx, voter);
      });
      tally.keep.forEach((voter) => {
        const factor = sharesTeamWithAnyCandidate(voter) ? params.keepSharedTeam : params.keepNoSharedTeam;
        likelihood *= resolve6(factor, observation, world, ctx, voter);
      });
      return likelihood;
    };
  }

  // src/likelihoodHandlers.ts
  var uncalibratedHandlers = {
    /**
     * selfRoleClaim: "A: I am <role or group>".
     *
     * Checks whether world.roles[actor] satisfies the claimed expression -
     * a "truthful" branch (it does, whether the claim was an exact role or
     * a group) vs a "lie" branch (it doesn't). This alone is what makes a
     * citizen claiming commissioner, a mafia claiming commissioner, and a
     * real commissioner claiming commissioner behave differently - not
     * because the handler special-cases any of those roles, but because
     * each is scored against a *different* candidate world. Whether lying
     * is uniform across roles/claim-specificity or team-dependent (e.g.
     * mafia bluff more) is a future refinement - it would key off
     * ctx.roles[...].team or the claim's kind generically, never off a
     * literal role/team name in a conditional.
     */
    selfRoleClaim(observation, world, ctx) {
      const isTruthful = satisfiedBy(
        observation.claim,
        world.roles[observation.actor],
        ctx.groups
      );
      throw new Error(
        `selfRoleClaim likelihood not calibrated yet (truthful=${isTruthful})`
      );
    },
    /**
     * roleAssertion: "A: B is <role or group>".
     *
     * Depends on world.roles[actor] AND world.roles[target] AND whether
     * world.roles[target] satisfies the claimed expression - a mafia player
     * accusing a fellow mafia member is a structurally different situation
     * from a citizen making the same accusation, even though both are "an
     * assertion about someone else". The eventual model keys off the
     * (actorRole, targetRole, correctness) tuple, not off any specific role
     * name.
     */
    roleAssertion(observation, world, ctx) {
      const actorRole = world.roles[observation.actor];
      const isCorrect = satisfiedBy(
        observation.claim,
        world.roles[observation.target],
        ctx.groups
      );
      throw new Error(
        `roleAssertion likelihood not calibrated yet (actorRole=${actorRole}, isCorrect=${isCorrect})`
      );
    },
    /**
     * investigationReport: "A: I used <mechanic> on B, result YES/NO".
     *
     * Two deterministic facts are available per candidate world, neither of
     * which names a role:
     *  - canPerform: does world.roles[actor] hold observation.mechanic?
     *  - matchesActual: does observation.result equal what the check would
     *    really return against world.roles[target] (getInvestigationResult,
     *    the same rule resolveNight uses)?
     * Neither is a hard constraint on its own. Anyone may publicly claim a
     * check, so a world where actor can't perform it is not impossible - the
     * report is simply not a genuine result there. How likely a bluff, a lie
     * about a real result, or a truthful report is remains behavioral and
     * uncalibrated, so no likelihood (including 0) is returned yet.
     */
    investigationReport(observation, world, ctx) {
      const canPerform = hasMechanic(
        ctx.roles,
        world.roles[observation.actor],
        observation.mechanic
      );
      const matchesActual = getInvestigationResult(
        ctx.roles,
        observation.mechanic,
        world.roles[observation.target]
      ) === observation.result;
      throw new Error(
        `investigationReport likelihood not calibrated yet (canPerform=${canPerform}, matchesActual=${matchesActual})`
      );
    },
    /**
     * candidateVote / keepOrEliminateVote: one whole public voting round.
     *
     * Scored as a single event, since every living player's choice is part of
     * the same observation (including abstentions, which only exist relative
     * to everyone else's hands). A future model may factor it per voter
     * against the candidate world's roles, but how any role tends to vote is
     * behavioral and uncalibrated. The deterministic rules - validation,
     * abstention, counting, outcome - live in voting.ts; they need the alive
     * state at the time of the vote, which ctx.alive is not guaranteed to be.
     */
    candidateVote(observation) {
      throw new Error(
        `candidateVote likelihood not calibrated yet (round=${observation.round}, stage=${observation.stage})`
      );
    },
    keepOrEliminateVote(observation) {
      throw new Error(
        `keepOrEliminateVote likelihood not calibrated yet (round=${observation.round})`
      );
    },
    /**
     * suspect: a public behavioral signal - a lightweight, non-mechanical act
     * available to anyone. A future model would consult whether actor and
     * target are on the same team *in this world*
     * (ctx.roles[world.roles[actor]].team vs ...target...team) as a proxy for
     * "would this role want to suspect this target", plus ctx.history for
     * pattern-based signals (e.g. repeated suspicion of the same target
     * carrying diminishing marginal evidence). Still no literal role-name
     * branching - only team/mechanic lookups through the registry.
     */
    suspect(observation, world, ctx) {
      const actorTeam = ctx.roles[world.roles[observation.actor]].team;
      const targetTeam = ctx.roles[world.roles[observation.target]].team;
      throw new Error(
        `suspect likelihood not calibrated yet (actorTeam=${actorTeam}, targetTeam=${targetTeam})`
      );
    },
    /**
     * defend: "A publicly defended B".
     *
     * Same observation shape regardless of whether actor is a doctor or a
     * citizen (see the layering discussion - defend is not gated by any
     * mechanic). Its likelihood should still depend on the candidate roles
     * of BOTH actor and target in this world (team alignment), and can later
     * draw on ctx.history/ctx.alive for contextual corroboration (e.g. did
     * the target survive a night where they were plausibly attacked, which
     * might weakly correlate with a real doctor's private protect action -
     * itself never directly observed).
     */
    defend(observation, world, ctx) {
      const actorTeam = ctx.roles[world.roles[observation.actor]].team;
      const targetTeam = ctx.roles[world.roles[observation.target]].team;
      throw new Error(
        `defend likelihood not calibrated yet (actorTeam=${actorTeam}, targetTeam=${targetTeam})`
      );
    },
    /**
     * nominate: "A nominated B for the elimination vote".
     *
     * Same shape/reasoning as suspect - a lightweight public act,
     * available to anyone, whose eventual likelihood would consult team
     * alignment in this world plus context (e.g. ctx.history for whether
     * this nomination follows a suspicious pattern).
     */
    nominate(observation, world, ctx) {
      const actorTeam = ctx.roles[world.roles[observation.actor]].team;
      const targetTeam = ctx.roles[world.roles[observation.target]].team;
      throw new Error(
        `nominate likelihood not calibrated yet (actorTeam=${actorTeam}, targetTeam=${targetTeam})`
      );
    }
  };
  function createHandlers(selfRoleClaimParams, roleAssertionParams, investigationReportParams, suspectParams, defendParams, nominateParams, candidateVoteParams, keepOrEliminateVoteParams) {
    return {
      ...uncalibratedHandlers,
      selfRoleClaim: createSelfRoleClaimHandler(selfRoleClaimParams),
      ...roleAssertionParams && {
        roleAssertion: createRoleAssertionHandler(roleAssertionParams)
      },
      ...investigationReportParams && {
        investigationReport: createInvestigationReportHandler(
          investigationReportParams
        )
      },
      ...suspectParams && {
        suspect: createTeamAlignmentHandler(suspectParams)
      },
      ...defendParams && {
        defend: createTeamAlignmentHandler(defendParams)
      },
      ...nominateParams && {
        nominate: createTeamAlignmentHandler(nominateParams)
      },
      ...candidateVoteParams && {
        candidateVote: createCandidateVoteHandler(candidateVoteParams)
      },
      ...keepOrEliminateVoteParams && {
        keepOrEliminateVote: createKeepOrEliminateVoteHandler(
          keepOrEliminateVoteParams
        )
      }
    };
  }

  // src/night.ts
  function resolveDeaths(inputs) {
    const {
      mafiaKillSucceeded,
      mafiaKillTarget,
      commissionerCheckTarget,
      commissionerCheckResult,
      doctorSavedTarget
    } = inputs;
    let commissionerCausedDeath;
    if (commissionerCheckResult && commissionerCheckTarget !== doctorSavedTarget) {
      commissionerCausedDeath = commissionerCheckTarget;
    }
    const died = [];
    if (mafiaKillSucceeded && mafiaKillTarget !== doctorSavedTarget) {
      died.push(mafiaKillTarget);
    }
    if (commissionerCausedDeath !== void 0 && !died.includes(commissionerCausedDeath)) {
      died.push(commissionerCausedDeath);
    }
    return { commissionerCausedDeath, died };
  }
  function resolveNight(world, actions, alive, history, registry) {
    const players = Object.keys(world.roles);
    const isAlive2 = (p) => alive[p] === true;
    const doctorAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "protect")
    );
    let doctorSavedTarget;
    if (doctorAlive && actions.doctorSaveTarget !== void 0) {
      if (history.previousDoctorSaveTarget === actions.doctorSaveTarget) {
        throw new Error(
          `Doctor cannot save "${actions.doctorSaveTarget}" on consecutive nights`
        );
      }
      doctorSavedTarget = actions.doctorSaveTarget;
    }
    const killers = players.filter(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
    );
    let mafiaKillSucceeded = false;
    let mafiaKillTarget;
    if (killers.length > 0) {
      const choices = killers.map((p) => actions.mafiaTargetChoices[p]);
      const allChosen = choices.every((c) => c !== void 0);
      const allSame = allChosen && choices.every((c) => c === choices[0]);
      if (allSame) {
        mafiaKillSucceeded = true;
        mafiaKillTarget = choices[0];
      }
    }
    const donAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "checkIsCommissioner")
    );
    let donCheckResult;
    if (donAlive && actions.donCheckTarget !== void 0) {
      donCheckResult = getInvestigationResult(
        registry,
        "checkIsCommissioner",
        world.roles[actions.donCheckTarget]
      );
    }
    const commissionerAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
    );
    let commissionerCheckResult;
    if (commissionerAlive && actions.commissionerCheckTarget !== void 0) {
      commissionerCheckResult = getInvestigationResult(
        registry,
        "checkIsMafia",
        world.roles[actions.commissionerCheckTarget]
      );
    }
    const { commissionerCausedDeath, died } = resolveDeaths({
      mafiaKillSucceeded,
      mafiaKillTarget,
      commissionerCheckTarget: actions.commissionerCheckTarget,
      commissionerCheckResult,
      doctorSavedTarget
    });
    return {
      mafiaKillSucceeded,
      mafiaKillTarget,
      donCheckResult,
      commissionerCheckResult,
      commissionerCausedDeath,
      doctorSavedTarget,
      died
    };
  }
  function enumerateHiddenNightActions(world, alive, registry) {
    const players = Object.keys(world.roles);
    const isAlive2 = (p) => alive[p] === true;
    const livingPlayers2 = players.filter(isAlive2);
    const killers = players.filter(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
    );
    const donAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "checkIsCommissioner")
    );
    const commissionerAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
    );
    const doctorAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "protect")
    );
    let hypotheses = [{ mafiaTargetChoices: {} }];
    killers.forEach((killer) => {
      const next = [];
      hypotheses.forEach((h) => {
        livingPlayers2.forEach((target) => {
          next.push({
            ...h,
            mafiaTargetChoices: { ...h.mafiaTargetChoices, [killer]: target }
          });
        });
      });
      hypotheses = next;
    });
    function fanOutTarget(include, key) {
      if (!include) return;
      const next = [];
      hypotheses.forEach((h) => {
        livingPlayers2.forEach((target) => {
          next.push({ ...h, [key]: target });
        });
      });
      hypotheses = next;
    }
    fanOutTarget(donAlive, "donCheckTarget");
    fanOutTarget(commissionerAlive, "commissionerCheckTarget");
    fanOutTarget(doctorAlive, "doctorSaveTarget");
    return hypotheses;
  }

  // src/nightResultLikelihood.ts
  function sameDeathSet(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    if (setA.size !== setB.size) return false;
    for (const p of setA) {
      if (!setB.has(p)) return false;
    }
    return true;
  }
  function isFactoredActionModel(model) {
    const candidate = model;
    return typeof candidate.mafiaConsensusProbability === "function" && typeof candidate.donCheckTargetProbability === "function" && typeof candidate.commissionerCheckTargetProbability === "function" && typeof candidate.doctorSaveTargetProbability === "function";
  }
  function scoreGroupedBruteForce(fact, world, alive, registry, actionModel, excludedTarget) {
    const hypotheses = enumerateHiddenNightActions(world, alive, registry);
    const history = excludedTarget === void 0 ? {} : { previousDoctorSaveTarget: excludedTarget };
    const grouped = /* @__PURE__ */ new Map();
    hypotheses.forEach((hypothesis) => {
      const resolution = resolveNight(world, hypothesis, alive, {}, registry);
      if (!sameDeathSet(resolution.died, fact.died)) return;
      const weight = actionModel.probability(hypothesis, world, alive, history);
      if (weight === 0) return;
      const key = hypothesis.doctorSaveTarget;
      grouped.set(key, (grouped.get(key) ?? 0) + weight);
    });
    return grouped;
  }
  function mafiaOutcomes(killers, livingPlayers2, actionModel, world, alive) {
    if (killers.length === 0) {
      return [{ succeeded: false, target: void 0, probability: 1 }];
    }
    let consensusMass = 0;
    const outcomes = livingPlayers2.map((target) => {
      const probability = actionModel.mafiaConsensusProbability(target, world, alive, {});
      consensusMass += probability;
      return { succeeded: true, target, probability };
    });
    outcomes.push({
      succeeded: false,
      target: void 0,
      probability: Math.max(0, 1 - consensusMass)
    });
    return outcomes;
  }
  function scoreGroupedOptimized(fact, world, alive, registry, actionModel, excludedTarget) {
    const players = Object.keys(world.roles);
    const isAlive2 = (p) => alive[p] === true;
    const livingPlayers2 = players.filter(isAlive2);
    const killers = players.filter(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
    );
    const commissionerAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
    );
    const doctorAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "protect")
    );
    const outcomes = mafiaOutcomes(killers, livingPlayers2, actionModel, world, alive);
    const commissionerTargets = commissionerAlive ? livingPlayers2 : [void 0];
    const doctorTargets = doctorAlive ? livingPlayers2 : [void 0];
    const history = excludedTarget === void 0 ? {} : { previousDoctorSaveTarget: excludedTarget };
    const grouped = /* @__PURE__ */ new Map();
    for (const outcome of outcomes) {
      if (outcome.probability === 0) continue;
      for (const commissionerCheckTarget of commissionerTargets) {
        const commissionerCheckResult = commissionerCheckTarget === void 0 ? void 0 : getInvestigationResult(
          registry,
          "checkIsMafia",
          world.roles[commissionerCheckTarget]
        );
        const commissionerProbability = commissionerCheckTarget === void 0 ? 1 : actionModel.commissionerCheckTargetProbability(
          commissionerCheckTarget,
          world,
          alive,
          {}
        );
        for (const doctorSavedTarget of doctorTargets) {
          const doctorProbability = doctorSavedTarget === void 0 ? 1 : actionModel.doctorSaveTargetProbability(doctorSavedTarget, world, alive, history);
          if (doctorProbability === 0) continue;
          const { died } = resolveDeaths({
            mafiaKillSucceeded: outcome.succeeded,
            mafiaKillTarget: outcome.target,
            commissionerCheckTarget,
            commissionerCheckResult,
            doctorSavedTarget
          });
          if (!sameDeathSet(died, fact.died)) continue;
          const weight = outcome.probability * commissionerProbability * doctorProbability;
          grouped.set(doctorSavedTarget, (grouped.get(doctorSavedTarget) ?? 0) + weight);
        }
      }
    }
    return grouped;
  }
  var NO_CONSTRAINT = /* @__PURE__ */ new Map([[void 0, 1]]);
  function sumValues(map) {
    let total = 0;
    map.forEach((v) => {
      total += v;
    });
    return total;
  }
  function nightResultLikelihoodAcrossNights(fact, world, ctx, scoreGrouped) {
    const priorNights = ctx.history.filter(
      (event) => event.type === "nightResult" && event.round < fact.round
    );
    let belief = NO_CONSTRAINT;
    priorNights.forEach((priorFact) => {
      const aliveThen = getAliveStateAt(ctx.config, ctx.history, {
        phase: "night",
        round: priorFact.round
      });
      const combined = /* @__PURE__ */ new Map();
      belief.forEach((priorWeight, excluded) => {
        const grouped = scoreGrouped(priorFact, aliveThen, excluded);
        grouped.forEach((weight, target) => {
          combined.set(target, (combined.get(target) ?? 0) + priorWeight * weight);
        });
      });
      const total2 = sumValues(combined);
      belief = total2 === 0 ? NO_CONSTRAINT : new Map([...combined].map(([target, weight]) => [target, weight / total2]));
    });
    let total = 0;
    belief.forEach((priorWeight, excluded) => {
      total += priorWeight * sumValues(scoreGrouped(fact, ctx.alive, excluded));
    });
    return total;
  }
  function createBruteForceNightResultHandler(actionModel) {
    return (fact, world, ctx) => nightResultLikelihoodAcrossNights(
      fact,
      world,
      ctx,
      (f, alive, excluded) => scoreGroupedBruteForce(f, world, alive, ctx.roles, actionModel, excluded)
    );
  }
  function createOptimizedNightResultHandler(actionModel) {
    return (fact, world, ctx) => nightResultLikelihoodAcrossNights(
      fact,
      world,
      ctx,
      (f, alive, excluded) => scoreGroupedOptimized(f, world, alive, ctx.roles, actionModel, excluded)
    );
  }
  function createNightResultHandler(actionModel) {
    if (isFactoredActionModel(actionModel)) {
      return createOptimizedNightResultHandler(actionModel);
    }
    return createBruteForceNightResultHandler(actionModel);
  }

  // src/uniformActionModel.ts
  function createUniformActionModel(registry) {
    const hypothesisCountCache = /* @__PURE__ */ new WeakMap();
    const shapeCache = /* @__PURE__ */ new WeakMap();
    function hypothesisCount(world, alive) {
      let byAlive = hypothesisCountCache.get(world);
      if (!byAlive) {
        byAlive = /* @__PURE__ */ new WeakMap();
        hypothesisCountCache.set(world, byAlive);
      }
      let count = byAlive.get(alive);
      if (count === void 0) {
        count = enumerateHiddenNightActions(world, alive, registry).length;
        byAlive.set(alive, count);
      }
      return count;
    }
    function shapeFor(world, alive) {
      let byAlive = shapeCache.get(world);
      if (!byAlive) {
        byAlive = /* @__PURE__ */ new WeakMap();
        shapeCache.set(world, byAlive);
      }
      let shape = byAlive.get(alive);
      if (shape === void 0) {
        const players = Object.keys(world.roles);
        const isAlive2 = (p) => alive[p] === true;
        const livingCount = players.filter(isAlive2).length;
        const killerCount = players.filter(
          (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
        ).length;
        const doctorAlive = players.some(
          (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "protect")
        );
        shape = { livingCount, killerCount, doctorAlive };
        byAlive.set(alive, shape);
      }
      return shape;
    }
    function excludedTarget(world, alive, history) {
      const target = history.previousDoctorSaveTarget;
      if (target === void 0) return void 0;
      if (alive[target] !== true) return void 0;
      if (!shapeFor(world, alive).doctorAlive) return void 0;
      return target;
    }
    return {
      probability(actions, world, alive, history) {
        const excluded = excludedTarget(world, alive, history);
        const baseCount = hypothesisCount(world, alive);
        if (excluded === void 0) {
          return 1 / baseCount;
        }
        if (actions.doctorSaveTarget === excluded) {
          return 0;
        }
        const { livingCount } = shapeFor(world, alive);
        const adjustedCount = baseCount * (livingCount - 1) / livingCount;
        return adjustedCount === 0 ? 0 : 1 / adjustedCount;
      },
      mafiaConsensusProbability(_target, world, alive) {
        const { livingCount, killerCount } = shapeFor(world, alive);
        return 1 / Math.pow(livingCount, killerCount);
      },
      donCheckTargetProbability(_target, world, alive) {
        return 1 / shapeFor(world, alive).livingCount;
      },
      commissionerCheckTargetProbability(_target, world, alive) {
        return 1 / shapeFor(world, alive).livingCount;
      },
      doctorSaveTargetProbability(target, world, alive, history) {
        const { livingCount } = shapeFor(world, alive);
        const excluded = excludedTarget(world, alive, history);
        if (excluded === void 0) {
          return 1 / livingCount;
        }
        if (target === excluded) {
          return 0;
        }
        return livingCount - 1 === 0 ? 0 : 1 / (livingCount - 1);
      }
    };
  }

  // src/behavioralModel.ts
  function expressionTeam(expr, roles, groups) {
    if (expr.kind === "role") return roles[expr.role].team;
    if (!groups) return void 0;
    const members = groups[expr.group];
    if (members.length === 0) return void 0;
    const firstTeam = roles[members[0]].team;
    return members.every((r) => roles[r].team === firstTeam) ? firstTeam : void 0;
  }
  function roleClaimFalseFactor(params) {
    return (observation, world, ctx) => {
      const claimTeam = expressionTeam(observation.claim, ctx.roles, ctx.groups);
      const actorTeam = ctx.roles[world.roles[observation.actor]].team;
      return claimTeam !== void 0 && actorTeam === claimTeam ? params.falseSameTeam : params.falseDifferentTeam;
    };
  }
  function selfRoleClaimParamsFrom(params) {
    return { truthful: params.truthful, false: roleClaimFalseFactor(params) };
  }
  function roleAssertionParamsFrom(params) {
    return { truthful: params.truthful, false: roleClaimFalseFactor(params) };
  }
  var NEUTRAL_TEAM_ALIGNMENT = { ownTeam: 0.5, otherTeam: 0.5 };
  function lookupTeamAlignment(params, team) {
    return params[team] ?? NEUTRAL_TEAM_ALIGNMENT;
  }
  function repeatedPosition(observationType, actor, target, history) {
    return history.some(
      (event) => event.type === observationType && event.actor === actor && event.target === target
    );
  }
  function teamAlignmentParamsFrom(behavior, observationType, repeatFactor) {
    const factor = (own) => (observation, world, ctx) => {
      const actorTeam = ctx.roles[world.roles[observation.actor]].team;
      const { ownTeam, otherTeam } = lookupTeamAlignment(behavior, actorTeam);
      const base = own ? ownTeam : otherTeam;
      const repeated = repeatedPosition(observationType, observation.actor, observation.target, ctx.history);
      return repeated ? base * repeatFactor : base;
    };
    return { sameTeam: factor(true), differentTeam: factor(false) };
  }
  var DEFAULT_ABSTAIN_RATE = 0.2;
  function candidateVoteParamsFrom(params) {
    return {
      sameTeamVote: (_observation, world, ctx, voter) => lookupTeamAlignment(params.vote, ctx.roles[world.roles[voter]].team).ownTeam,
      differentTeamVote: (_observation, world, ctx, voter) => lookupTeamAlignment(params.vote, ctx.roles[world.roles[voter]].team).otherTeam,
      abstain: (_observation, world, ctx, voter) => params.abstain[ctx.roles[world.roles[voter]].team] ?? DEFAULT_ABSTAIN_RATE
    };
  }
  var NEUTRAL_KEEP_OR_ELIMINATE = {
    eliminateSharedTeam: 0.5,
    keepSharedTeam: 0.5,
    eliminateNoSharedTeam: 0.5,
    keepNoSharedTeam: 0.5
  };
  function keepOrEliminateParamsFrom(params) {
    const entryFor = (world, ctx, voter) => params[ctx.roles[world.roles[voter]].team] ?? NEUTRAL_KEEP_OR_ELIMINATE;
    return {
      eliminateSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).eliminateSharedTeam,
      keepSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).keepSharedTeam,
      eliminateNoSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).eliminateNoSharedTeam,
      keepNoSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).keepNoSharedTeam
    };
  }
  var NEUTRAL_ALIGNMENT_TABLE = {
    mafia: { ownTeam: 0.5, otherTeam: 0.5 },
    town: { ownTeam: 0.5, otherTeam: 0.5 }
  };
  var NEUTRAL_KEEP_OR_ELIMINATE_TABLE = {
    mafia: { ...NEUTRAL_KEEP_OR_ELIMINATE },
    town: { ...NEUTRAL_KEEP_OR_ELIMINATE }
  };
  var defaultBehavioralModelParams = {
    selfRoleClaim: { truthful: 0.7, falseSameTeam: 0.2, falseDifferentTeam: 0.2 },
    roleAssertion: { truthful: 0.6, falseSameTeam: 0.2, falseDifferentTeam: 0.2 },
    investigationReport: { truthful: 0.7, falseResult: 0.15, bluff: 0.25 },
    suspect: NEUTRAL_ALIGNMENT_TABLE,
    defend: NEUTRAL_ALIGNMENT_TABLE,
    nominate: NEUTRAL_ALIGNMENT_TABLE,
    repeatFactor: 1,
    candidateVote: {
      vote: NEUTRAL_ALIGNMENT_TABLE,
      abstain: { mafia: 0.2, town: 0.2 }
    },
    keepOrEliminateVote: NEUTRAL_KEEP_OR_ELIMINATE_TABLE
  };
  function createBehavioralHandlers(params) {
    return createHandlers(
      selfRoleClaimParamsFrom(params.selfRoleClaim),
      roleAssertionParamsFrom(params.roleAssertion),
      params.investigationReport,
      teamAlignmentParamsFrom(params.suspect, "suspect", params.repeatFactor),
      teamAlignmentParamsFrom(params.defend, "defend", params.repeatFactor),
      teamAlignmentParamsFrom(params.nominate, "nominate", params.repeatFactor),
      candidateVoteParamsFrom(params.candidateVote),
      keepOrEliminateParamsFrom(params.keepOrEliminateVote)
    );
  }
  function createBehavioralLikelihoodModel(params, actionModel = createUniformActionModel(defaultRoleRegistry), behavioralEvidenceWeight = 1) {
    return createLikelihoodModel(
      createBehavioralHandlers(params),
      createNightResultHandler(actionModel),
      behavioralEvidenceWeight
    );
  }

  // src/probability.ts
  function getProbability(worlds, player, role) {
    return getExpressionProbability(worlds, player, { kind: "role", role });
  }
  function getExpressionProbability(worlds, player, expr, groups) {
    return worlds.filter((world) => satisfiedBy(expr, world.roles[player], groups)).reduce((sum, world) => sum + world.probability, 0);
  }

  // src/gameEvaluation.ts
  function describeEvidence(evidence) {
    switch (evidence.type) {
      case "selfRoleClaim":
        return `${evidence.actor} claims ${describeExpression(evidence.claim)}`;
      case "roleAssertion":
        return `${evidence.actor} asserts ${evidence.target} is ${describeExpression(evidence.claim)}`;
      case "investigationReport":
        return `${evidence.actor} reports ${evidence.mechanic} on ${evidence.target} = ${evidence.result}`;
      case "suspect":
        return `${evidence.actor} suspects ${evidence.target}`;
      case "defend":
        return `${evidence.actor} defends ${evidence.target}`;
      case "nominate":
        return `${evidence.actor} nominates ${evidence.target}`;
      case "candidateVote":
        return `vote (${evidence.stage}): candidates=[${evidence.candidates.join(",")}]`;
      case "keepOrEliminateVote":
        return `keep/eliminate vote: candidates=[${evidence.candidates.join(",")}]`;
      case "nightResult":
        return `night ${evidence.round}: died=[${evidence.died.join(",")}]`;
      case "dayElimination":
        return `day ${evidence.round} elimination: [${evidence.eliminated.join(",")}]`;
    }
  }
  function describeExpression(expr) {
    return expr.kind === "role" ? expr.role : `<${expr.group}>`;
  }

  // src/gameOutcome.ts
  function extractTeamCounts(world, alive, registry) {
    const players = Object.keys(world.roles);
    const isAlive2 = (p) => alive[p] === true;
    const mafiaAlive = players.filter(
      (p) => isAlive2(p) && registry[world.roles[p]].team === "mafia"
    ).length;
    const townAlive = players.filter(
      (p) => isAlive2(p) && registry[world.roles[p]].team === "town"
    ).length;
    const doctorAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "protect")
    );
    const commissionerAlive = players.some(
      (p) => isAlive2(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
    );
    return { mafiaAlive, townAlive, doctorAlive, commissionerAlive };
  }
  function getGameOutcome(world, alive, registry) {
    const counts = extractTeamCounts(world, alive, registry);
    if (counts.mafiaAlive === 0) return "townWon";
    if (counts.townAlive === 0) return "mafiaWon";
    return "ongoing";
  }
  function getPossibleWorlds(worlds, alive, registry) {
    const result = { townWon: [], mafiaWon: [], ongoing: [] };
    worlds.filter((world) => world.probability > 0).forEach((world) => {
      result[getGameOutcome(world, alive, registry)].push(world);
    });
    return result;
  }

  // src/app/teamAlignment.ts
  function getTeammateProbabilities(worlds, player, otherPlayers, registry) {
    const result = {};
    otherPlayers.filter((p) => p !== player).forEach((other) => {
      result[other] = worlds.filter((w) => sameTeam(registry, w.roles[player], w.roles[other])).reduce((sum, w) => sum + w.probability, 0);
    });
    return result;
  }

  // src/app/types.ts
  var APP_SCHEMA_VERSION = 1;
  var CURRENT_PREDICTOR_VERSION = "default-flat-v1";
  var CURRENT_ENGINE_VERSION = "1.0.0";
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
  var CURRENT_APP_VERSION = "0.1.0";
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
    setting(config) {
      return { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
    }
    /** The ONE place a LikelihoodModel is constructed - swap the params object here to change the predictor's behavioral assumptions; never inline elsewhere. */
    model() {
      return createBehavioralLikelihoodModel(defaultBehavioralModelParams);
    }
    /**
     * Recomputes the full posterior from `session.eventLog` - the single
     * "replay" operation everything else in this class is built on. Throws
     * exactly when processEvidence/updateProbabilities would (a malformed or
     * mechanically-impossible event) - callers that are VALIDATING a
     * not-yet-committed event call this on a candidate session BEFORE
     * assigning it to `this.state`, so an invalid manual entry is rejected
     * without corrupting the persisted log (see appendEvent).
     */
    computeSteps(session) {
      const worlds = generateWorlds(session.config);
      const events = session.eventLog.map((e) => e.event);
      return processEvidence(worlds, events, this.model(), this.setting(session.config));
    }
    currentWorlds(session) {
      const steps = this.computeSteps(session);
      return steps.length > 0 ? steps[steps.length - 1].posterior : generateWorlds(session.config);
    }
    /** Alive state after EVERY recorded event so far - independent of uiPhase, always "as of right now". */
    currentAliveState(session) {
      let alive = initAliveState(session.config);
      session.eventLog.forEach(({ event }) => {
        if (event.type === "nightResult") event.died.forEach((p) => alive = markDead(alive, p));
        if (event.type === "dayElimination") event.eliminated.forEach((p) => alive = markDead(alive, p));
      });
      return alive;
    }
    /** Appends `event`, validating it via a dry-run computeSteps() BEFORE committing - throws (and leaves `session` untouched) on an invalid event. */
    appendEvent(session, event) {
      const entry = { event, uiPhaseBefore: session.uiPhase };
      const candidate = { ...session, eventLog: [...session.eventLog, entry] };
      this.computeSteps(candidate);
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
    /**
     * Everything about the current session a UI needs to render config/phase/
     * history summaries, EXCLUDING `myRole`'s actual value (only whether it's
     * been set) and any probability - the two things that must never reach
     * the normal game screen. Deliberately one small, safe read model rather
     * than exposing `GameSession` directly, so a future field added to
     * GameSession can't accidentally leak through this getter unreviewed.
     */
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
        engineVersion: s.engineVersion,
        predictorVersion: s.predictorVersion
      };
    }
    /** Every distinct role in this game's configuration - for a role picker (e.g. the secret-role-entry screen). Order matches roles.ts's own key order, not config.roles' (possibly duplicated) order. */
    getRoleOptions() {
      const s = this.requireGame();
      return Array.from(new Set(s.config.roles));
    }
    /**
     * P(mafia team) before any evidence, for this game's role configuration -
     * i.e. what every player's mafiaProbability equals at the very start.
     * Reuses generateWorlds()/getExpressionProbability() exactly as
     * getPublicPlayerProbabilities() does, just against a fresh no-evidence
     * world set instead of the current one - no new inference. Every player
     * is interchangeable before any evidence, so this is a single game-wide
     * number, not per-player.
     *
     * Exists so a UI can anchor a "neutral" visual (e.g. a probability bar's
     * center point) at the game's actual prior instead of a universal 0.5,
     * which is wrong whenever the mafia team isn't exactly half the players -
     * the normal case (e.g. 2 of 7 by this app's own default role policy).
     */
    getPriorMafiaProbability() {
      const s = this.requireGame();
      const worlds = generateWorlds(s.config);
      return getExpressionProbability(worlds, s.config.players[0], { kind: "group", group: "mafia" }, defaultGroupRegistry);
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
        predictorVersion: CURRENT_PREDICTOR_VERSION,
        createdAt: now,
        updatedAt: now,
        config,
        myPlayerNumber: setup.myPlayerNumber,
        myRole: null,
        eventLog: [],
        uiPhase: { kind: "day", round: 0 },
        votingDraft: null,
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
    startNight() {
      const session = this.requireGame();
      const round = this.requireDayRound(session);
      this.updateSession({ ...session, uiPhase: { kind: "night", round: round + 1 } });
    }
    /** Records this night's deaths (may be empty) and advances to the following day. Day 1 has no preceding night, so this is never called before it. */
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
    recordAction(actor, type, target) {
      const session = this.requireGame();
      const round = this.requireDayRound(session);
      this.updateSession(this.appendEvent(session, { type, round, actor, target }));
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
    /** `stage: "initial"` starts fresh from the "day" phase; `stage: "revote"` continues from the "voting" phase a just-confirmed tied vote left the session in. */
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
    /** Commits the in-progress candidateVote draft as a real event and returns the engine's own resolution (winner, or a tie needing a revote) - never invents a different voting model, reuses voting.ts's resolveCandidateVote unchanged. */
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
    /** Vote tally so far (including inferred abstention-to-last-candidate) for the in-progress draft - for a live "N votes" display before confirming. */
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
    /** The current day's round number, valid from any of this day's decision-making sub-phases ("day" itself, an in-progress candidateVote, or an in-progress keepOrEliminateVote) - never from "night" or "finished". */
    requireDayRound2(session) {
      if (session.uiPhase.kind === "day" || session.uiPhase.kind === "voting" || session.uiPhase.kind === "keepOrEliminateVoting") {
        return session.uiPhase.round;
      }
      throw new GameFacadeError(`this action requires the "day", "voting", or "keepOrEliminateVoting" phase, current phase is "${session.uiPhase.kind}"`);
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
    /** Finalizes the day's elimination (possibly empty - "leave everyone") and returns to the "day" phase for the SAME round. */
    recordDayElimination(eliminated) {
      const session = this.requireGame();
      const round = this.requireDayRound2(session);
      const withEvent = this.appendEvent(session, { type: "dayElimination", round, eliminated: [...eliminated] });
      this.updateSession({ ...withEvent, uiPhase: { kind: "day", round } });
    }
    // ============================================================
    // Finish game
    // ============================================================
    /** "unknown" unless the CURRENT posterior's nonzero worlds are unanimous - see gameOutcome.ts's getPossibleWorlds (unchanged): a live, incomplete-information game can only be called with certainty when every remaining possible world agrees. */
    getSuggestedOutcome() {
      const session = this.requireGame();
      const worlds = this.currentWorlds(session);
      const alive = this.currentAliveState(session);
      const possible = getPossibleWorlds(worlds, alive, defaultRoleRegistry);
      if (possible.ongoing.length > 0) return "unknown";
      if (possible.townWon.length > 0 && possible.mafiaWon.length === 0) return "townWon";
      if (possible.mafiaWon.length > 0 && possible.townWon.length === 0) return "mafiaWon";
      return "unknown";
    }
    finishGame(confirmedOutcome) {
      const session = this.requireGame();
      this.updateSession({ ...session, uiPhase: { kind: "finished" }, confirmedOutcome });
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
     * restores uiPhase to exactly what it was immediately before that event
     * (stored per-entry - see EventLogEntry). Safe by construction: undo only
     * ever removes the LAST event, and nothing later in the log can depend on
     * it (there is nothing later), so the remaining prefix is always a valid
     * history - re-validated via computeSteps() as a defensive check anyway.
     * Does NOT touch myRole/finalRoles/confirmedOutcome/votingDraft - those
     * are simple idempotent setters a caller corrects by calling them again,
     * not part of the sequential eventLog this method operates on.
     */
    undoLastEvent() {
      const session = this.requireGame();
      if (session.eventLog.length === 0) throw new GameFacadeError("no events to undo");
      const last = session.eventLog[session.eventLog.length - 1];
      const candidate = { ...session, eventLog: session.eventLog.slice(0, -1), uiPhase: last.uiPhaseBefore, votingDraft: null };
      this.computeSteps(candidate);
      this.updateSession(candidate);
    }
    canUndo() {
      const session = this.requireGame();
      return session.eventLog.length > 0;
    }
    // ============================================================
    // Read-only predictor views
    // ============================================================
    getEventLog() {
      return this.requireGame().eventLog.map(({ event }) => ({ event, description: describeEvidence(event) }));
    }
    /** Every living player's probabilities, EXCLUDING myPlayerNumber entirely - not merely "the UI shouldn't call this for self", but structurally omitted, per this milestone's "hard to accidentally expose" requirement. */
    getPublicPlayerProbabilities() {
      const session = this.requireGame();
      const worlds = this.currentWorlds(session);
      const alive = this.currentAliveState(session);
      const hasDon = session.config.roles.includes("don");
      return session.config.players.filter((p) => p !== session.myPlayerNumber).map((player) => ({
        player,
        alive: alive[player] === true,
        mafiaProbability: getExpressionProbability(worlds, player, { kind: "group", group: "mafia" }, defaultGroupRegistry),
        commissionerProbability: getProbability(worlds, player, "commissioner"),
        doctorProbability: getProbability(worlds, player, "doctor"),
        ...hasDon ? { donProbability: getProbability(worlds, player, "don") } : {}
      }));
    }
    /** Throws for myPlayerNumber - the caller must never route its own player through the shared "player info" screen (see this milestone's report). */
    getPlayerInfo(player) {
      const session = this.requireGame();
      if (player === session.myPlayerNumber) throw new GameFacadeError("cannot expose your own player info");
      const worlds = this.currentWorlds(session);
      const alive = this.currentAliveState(session);
      const hasDon = session.config.roles.includes("don");
      const events = session.eventLog.map((e) => e.event).filter((e) => eventInvolvesPlayer(e, player));
      return {
        player,
        alive: alive[player] === true,
        mafiaProbability: getExpressionProbability(worlds, player, { kind: "group", group: "mafia" }, defaultGroupRegistry),
        commissionerProbability: getProbability(worlds, player, "commissioner"),
        doctorProbability: getProbability(worlds, player, "doctor"),
        ...hasDon ? { donProbability: getProbability(worlds, player, "don") } : {},
        teammateProbabilities: getTeammateProbabilities(worlds, player, session.config.players, defaultRoleRegistry),
        events: events.map((event) => ({ event, description: describeEvidence(event) }))
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
    /** Wipes ALL persisted application state (menu + any in-progress game + history) - the "Clear All Data" menu action. Reloading the page after this is the caller's (UI's) responsibility. */
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
    const publicProbs = facade2.getPublicPlayerProbabilities();
    const byPlayer = new Map(publicProbs.map((p) => [p.player, p]));
    const neutral = facade2.getPriorMafiaProbability();
    const players = session.config.players.map((player) => {
      const isMe = player === session.myPlayerNumber;
      if (isMe) {
        return { player, isMe: true, alive: true };
      }
      const p = byPlayer.get(player);
      const alive = p?.alive ?? true;
      return {
        player,
        isMe: false,
        alive,
        mafiaProbability: p?.mafiaProbability,
        barStyle: alive && p ? computeProbabilityBarStyle(p.mafiaProbability, neutral) : void 0
      };
    });
    const meAliveEntry = players.find((p) => p.isMe);
    if (meAliveEntry) {
      const allDead = /* @__PURE__ */ new Set();
      facade2.getEventLog().forEach(({ event }) => {
        if (event.type === "nightResult") event.died.forEach((d) => allDead.add(d));
        if (event.type === "dayElimination") event.eliminated.forEach((d) => allDead.add(d));
      });
      meAliveEntry.alive = !allDead.has(session.myPlayerNumber);
    }
    return { phaseLabel: phaseLabel(session.uiPhase), phase: session.uiPhase, players, canUndo: facade2.canUndo() };
  }
  function buildRoleEntryViewModel(facade2) {
    const session = facade2.getPublicSessionView();
    return { needsRole: !session.hasMyRole, roleOptions: facade2.getRoleOptions() };
  }
  function computeProbabilityBarStyle(mafiaProbability, neutral = 0.5) {
    if (mafiaProbability > neutral) {
      const span2 = 1 - neutral;
      const heightPercent2 = span2 > 0 ? (mafiaProbability - neutral) / span2 * 50 : 50;
      return { direction: "down", color: "mafia", heightPercent: heightPercent2 };
    }
    const span = neutral;
    const heightPercent = span > 0 ? (neutral - mafiaProbability) / span * 50 : 0;
    return { direction: "up", color: "town", heightPercent };
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
  var atMenuOverGame = false;
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== void 0) e.textContent = text;
    return e;
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
    infoPlayer = null;
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
  function playerOptions(players) {
    return players.map((p) => ({ value: p, label: `Player ${p}` }));
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
  function renderMainGameScreen() {
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
      const angle = 2 * Math.PI * i / vm.players.length - Math.PI / 2;
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
        node.onclick = () => {
          infoPlayer = p.player;
          render();
        };
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
  function renderPlayerInfoModal(player) {
    const overlay = el("div", "modal-overlay");
    const box = el("div", "modal-box");
    try {
      const info = facade.getPlayerInfo(player);
      box.appendChild(el("h3", "title", `Player ${player}`));
      box.appendChild(el("div", "info-row", `Alive: ${info.alive ? "yes" : "no"}`));
      box.appendChild(el("div", "info-row", `P(Mafia): ${(info.mafiaProbability * 100).toFixed(1)}%`));
      box.appendChild(el("div", "info-row", `P(Commissioner): ${(info.commissionerProbability * 100).toFixed(1)}%`));
      box.appendChild(el("div", "info-row", `P(Doctor): ${(info.doctorProbability * 100).toFixed(1)}%`));
      if (info.donProbability !== void 0) box.appendChild(el("div", "info-row", `P(Don): ${(info.donProbability * 100).toFixed(1)}%`));
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
    actions.appendChild(button("Close", () => {
      infoPlayer = null;
      render();
    }, "btn btn-huge"));
    actions.appendChild(backToMenuButton());
    box.appendChild(actions);
    overlay.appendChild(box);
    root.appendChild(overlay);
  }
  function renderEventEntryOverlay() {
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
      { value: "investigationReport", label: "Claim: investigation result" }
    ]);
    typeRow.appendChild(typeSelect);
    box.appendChild(typeRow);
    const detailContainer = el("div", "detail-container");
    box.appendChild(detailContainer);
    function renderDetails() {
      detailContainer.innerHTML = "";
      const type = typeSelect.value;
      if (type === "suspect" || type === "defend" || type === "nominate") {
        const targetRow = el("div", "field-row");
        targetRow.appendChild(el("label", "field-label", "Target"));
        const targetSelect = selectEl(playerOptions(alivePlayers));
        targetRow.appendChild(targetSelect);
        detailContainer.appendChild(targetRow);
        detailContainer.dataset.getTarget = "1";
        detailContainer._targetSelect = targetSelect;
      } else if (type === "selfRoleClaim") {
        const claimSelect = roleClaimSelect(session);
        const row = el("div", "field-row");
        row.appendChild(el("label", "field-label", "Claims to be"));
        row.appendChild(claimSelect);
        detailContainer.appendChild(row);
        detailContainer._claimSelect = claimSelect;
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
        detailContainer._targetSelect = targetSelect;
        detailContainer._claimSelect = claimSelect;
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
          { value: "checkIsMafia", label: "Check Is Mafia (Commissioner)" }
        ]);
        mechRow.appendChild(mechSelect);
        detailContainer.appendChild(mechRow);
        const resultRow = el("div", "field-row");
        resultRow.appendChild(el("label", "field-label", "Result"));
        const resultSelect = selectEl([{ value: "true", label: "Yes" }, { value: "false", label: "No" }]);
        resultRow.appendChild(resultSelect);
        detailContainer.appendChild(resultRow);
        detailContainer._targetSelect = targetSelect;
        detailContainer._mechSelect = mechSelect;
        detailContainer._resultSelect = resultSelect;
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
          const d = detailContainer;
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
    const outcomeRow = el("div", "field-row");
    outcomeRow.appendChild(el("label", "field-label", "Result"));
    const outcomeSelect = selectEl(OUTCOME_OPTIONS, session.confirmedOutcome ?? "unknown");
    outcomeSelect.onchange = () => safely(() => facade.finishGame(outcomeSelect.value));
    outcomeRow.appendChild(outcomeSelect);
    c.appendChild(outcomeRow);
    c.appendChild(el("p", "hint", "The engine's own suggestion is pre-selected when it has one - confirm it or pick a different result."));
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
