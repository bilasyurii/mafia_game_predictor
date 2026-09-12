import { AliveState, PlayerId, World } from "./types";
import { hasMechanic, RoleRegistry } from "./roles";

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
  /** true = the checked target's role has the checkIsMafia mechanic. */
  donCheckResult?: boolean;
  /** true = the checked target's role has the unanimousNightKill mechanic. */
  commissionerCheckResult?: boolean;
  commissionerCausedDeath?: PlayerId;
  doctorSavedTarget?: PlayerId;
  died: PlayerId[];
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

  // --- Don check: "is target the role that can check-is-mafia" ---
  const donAlive = players.some(
    (p) =>
      isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsCommissioner")
  );
  let donCheckResult: boolean | undefined;
  if (donAlive && actions.donCheckTarget !== undefined) {
    donCheckResult = hasMechanic(
      registry,
      world.roles[actions.donCheckTarget],
      "checkIsMafia"
    );
  }

  // --- Commissioner check: "is target on the unanimous-kill team" ---
  const commissionerAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
  );
  let commissionerCheckResult: boolean | undefined;
  let commissionerCausedDeath: PlayerId | undefined;
  if (commissionerAlive && actions.commissionerCheckTarget !== undefined) {
    const target = actions.commissionerCheckTarget;
    commissionerCheckResult = hasMechanic(
      registry,
      world.roles[target],
      "unanimousNightKill"
    );
    if (commissionerCheckResult && target !== doctorSavedTarget) {
      commissionerCausedDeath = target;
    }
  }

  // --- Combine into the final death list, respecting the doctor's single save ---
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
 * The only publicly known fact about a night: who died, by identity.
 * Cause and role are never included - see the Observation docs in
 * types.ts for why an attributed "attack" observation doesn't exist.
 */
export interface NightResultFact {
  type: "nightResult";
  round: number;
  died: PlayerId[];
}
