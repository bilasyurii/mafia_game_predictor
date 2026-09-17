import { AliveState, PlayerId, World } from "./types";
import { hasMechanic, RoleRegistry } from "./roles";
import { getInvestigationResult } from "./investigation";

/**
 * One night's private latent actions - a hypothesis, not yet known to be
 * true. Never persisted alongside a World; used only while computing
 * P(public night outcome | world) (see the future night-result likelihood
 * handler), which will marginalize over many such hypotheses.
 */
export interface HiddenNightActions {
  /** Every living player who currently holds the kill mechanic independently
   * picks a target - this is what "unanimous" is checked against. */
  mafiaTargetChoices: Record<PlayerId, PlayerId>;
  donCheckTarget?: PlayerId;
  commissionerCheckTarget?: PlayerId;
  doctorSaveTarget?: PlayerId;
}

/**
 * Context resolveNight needs beyond "this night's" actions - specifically
 * the doctor's no-consecutive-repeat constraint, which depends on the
 * immediately preceding night, not on anything in HiddenNightActions
 * itself.
 */
export interface NightHistoryContext {
  previousDoctorSaveTarget?: PlayerId;
}

/**
 * The full deterministic outcome of resolving one night. Only `died`
 * (identity only) is ever projected into PublicGameState - everything
 * else here is private, used only to feed the next night's
 * NightHistoryContext or for internal consistency checks.
 */
export interface NightResolution {
  mafiaKillSucceeded: boolean;
  mafiaKillTarget?: PlayerId;
  /** getInvestigationResult("checkIsCommissioner", target's role). */
  donCheckResult?: boolean;
  /** getInvestigationResult("checkIsMafia", target's role). */
  commissionerCheckResult?: boolean;
  commissionerCausedDeath?: PlayerId;
  doctorSavedTarget?: PlayerId;
  died: PlayerId[];
}

/** Inputs resolveDeaths needs: the already-resolved outcome of each night mechanic. */
export interface DeathResolutionInputs {
  mafiaKillSucceeded: boolean;
  mafiaKillTarget?: PlayerId;
  commissionerCheckTarget?: PlayerId;
  /** getInvestigationResult("checkIsMafia", commissionerCheckTarget's role). */
  commissionerCheckResult?: boolean;
  doctorSavedTarget?: PlayerId;
}

export interface DeathResolutionOutcome {
  commissionerCausedDeath?: PlayerId;
  died: PlayerId[];
}

/**
 * The pure "combine already-resolved mechanic outcomes into a death list"
 * step of resolveNight, extracted into its own function so resolveNight and
 * nightResultLikelihood.ts's optimized marginalization path both use the
 * identical rule - never two hand-maintained copies that could drift apart.
 * Takes no World/registry/hidden-actions: by the time this runs, every
 * mechanic's outcome (who the mafia unanimously killed, if anyone; who the
 * commissioner checked and whether that check was positive; who the doctor
 * saved) is already known.
 */
export function resolveDeaths(inputs: DeathResolutionInputs): DeathResolutionOutcome {
  const {
    mafiaKillSucceeded,
    mafiaKillTarget,
    commissionerCheckTarget,
    commissionerCheckResult,
    doctorSavedTarget,
  } = inputs;

  let commissionerCausedDeath: PlayerId | undefined;
  if (commissionerCheckResult && commissionerCheckTarget !== doctorSavedTarget) {
    commissionerCausedDeath = commissionerCheckTarget;
  }

  const died: PlayerId[] = [];
  if (mafiaKillSucceeded && mafiaKillTarget !== doctorSavedTarget) {
    died.push(mafiaKillTarget!);
  }
  if (
    commissionerCausedDeath !== undefined &&
    !died.includes(commissionerCausedDeath)
  ) {
    died.push(commissionerCausedDeath);
  }

  return { commissionerCausedDeath, died };
}

/**
 * Deterministic night-mechanics resolution: World + hidden actions +
 * history -> what happened. No probabilities, heuristics, or behavioral
 * assumptions - every branch here is a fixed consequence of the rules.
 *
 * Never hardcodes a role id: "is this the commissioner" is answered
 * structurally ("does this target's role have checkIsMafia"), not by
 * comparing a role name - the same pattern the evidence layer already
 * follows.
 */
export function resolveNight(
  world: World,
  actions: HiddenNightActions,
  alive: AliveState,
  history: NightHistoryContext,
  registry: RoleRegistry
): NightResolution {
  const players = Object.keys(world.roles);
  const isAlive = (p: PlayerId) => alive[p] === true;

  // --- Doctor protection (resolved first so later steps can reference it) ---
  const doctorAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "protect")
  );
  let doctorSavedTarget: PlayerId | undefined;
  if (doctorAlive && actions.doctorSaveTarget !== undefined) {
    if (history.previousDoctorSaveTarget === actions.doctorSaveTarget) {
      throw new Error(
        `Doctor cannot save "${actions.doctorSaveTarget}" on consecutive nights`
      );
    }
    doctorSavedTarget = actions.doctorSaveTarget;
  }

  // --- Mafia unanimous kill ---
  const killers = players.filter(
    (p) =>
      isAlive(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
  );
  let mafiaKillSucceeded = false;
  let mafiaKillTarget: PlayerId | undefined;
  if (killers.length > 0) {
    const choices = killers.map((p) => actions.mafiaTargetChoices[p]);
    const allChosen = choices.every((c) => c !== undefined);
    const allSame = allChosen && choices.every((c) => c === choices[0]);
    if (allSame) {
      mafiaKillSucceeded = true;
      mafiaKillTarget = choices[0];
    }
  }

  // --- Don check (checkIsCommissioner) ---
  const donAlive = players.some(
    (p) =>
      isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsCommissioner")
  );
  let donCheckResult: boolean | undefined;
  if (donAlive && actions.donCheckTarget !== undefined) {
    donCheckResult = getInvestigationResult(
      registry,
      "checkIsCommissioner",
      world.roles[actions.donCheckTarget]
    );
  }

  // --- Commissioner check (checkIsMafia) ---
  const commissionerAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
  );
  let commissionerCheckResult: boolean | undefined;
  if (commissionerAlive && actions.commissionerCheckTarget !== undefined) {
    commissionerCheckResult = getInvestigationResult(
      registry,
      "checkIsMafia",
      world.roles[actions.commissionerCheckTarget]
    );
  }

  // --- Combine into the final death list, respecting the doctor's single save ---
  const { commissionerCausedDeath, died } = resolveDeaths({
    mafiaKillSucceeded,
    mafiaKillTarget,
    commissionerCheckTarget: actions.commissionerCheckTarget,
    commissionerCheckResult,
    doctorSavedTarget,
  });

  return {
    mafiaKillSucceeded,
    mafiaKillTarget,
    donCheckResult,
    commissionerCheckResult,
    commissionerCausedDeath,
    doctorSavedTarget,
    died,
  };
}

/**
 * Every mechanically valid hidden-night-action combination for a candidate
 * world: each living kill-mechanic holder independently targets any living
 * player, and each of Don's check / Commissioner's check / Doctor's save is
 * included - ranging over any living player - only if its mechanic's
 * holder is alive in this world, exactly mirroring resolveNight's own
 * alive/mechanic checks. No behavioral logic: self-targeting is included
 * for every mechanic (nothing here says who would plausibly be chosen,
 * only who legally could be), and the doctor's cross-night "no repeat"
 * rule is deliberately NOT enforced here - the previous night's real save
 * target is itself a hidden, marginalized-out quantity by the time a
 * later night is being enumerated, so there is no single fact to enforce
 * it against at enumeration time. This is a permanent division of
 * responsibility, not a deferred feature: enumeration stays
 * history-independent by design, and the constraint is enforced
 * downstream instead, as a genuine belief-weighted probability - see
 * nightResultLikelihood.ts's nightResultLikelihoodAcrossNights (which
 * receives real, non-empty history) and actionModel.ts's docs.
 */
export function enumerateHiddenNightActions(
  world: World,
  alive: AliveState,
  registry: RoleRegistry
): HiddenNightActions[] {
  const players = Object.keys(world.roles);
  const isAlive = (p: PlayerId) => alive[p] === true;
  const livingPlayers = players.filter(isAlive);

  const killers = players.filter(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
  );
  const donAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsCommissioner")
  );
  const commissionerAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
  );
  const doctorAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "protect")
  );

  let hypotheses: HiddenNightActions[] = [{ mafiaTargetChoices: {} }];

  killers.forEach((killer) => {
    const next: HiddenNightActions[] = [];
    hypotheses.forEach((h) => {
      livingPlayers.forEach((target) => {
        next.push({
          ...h,
          mafiaTargetChoices: { ...h.mafiaTargetChoices, [killer]: target },
        });
      });
    });
    hypotheses = next;
  });

  function fanOutTarget(
    include: boolean,
    key: "donCheckTarget" | "commissionerCheckTarget" | "doctorSaveTarget"
  ): void {
    if (!include) return;
    const next: HiddenNightActions[] = [];
    hypotheses.forEach((h) => {
      livingPlayers.forEach((target) => {
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

/**
 * The only publicly known fact about a night: who died, by identity.
 * Cause and role are never included - see the Observation docs in
 * types.ts for why an attributed "attack" observation doesn't exist.
 */
export interface NightResultFact {
  type: "nightResult";
  round: number;
  died: PlayerId[];
}
