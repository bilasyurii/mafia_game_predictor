import { GameConfig, RoleExpression } from "./types";
import { generateWorlds } from "./generateWorlds";
import { getExpressionProbability, getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState } from "./facts";
import { formatProbability } from "./format";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";

const game: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7", "8"],
  roles: [
    "don",
    "mafia",
    "doctor",
    "commissioner",
    "citizen",
    "citizen",
    "citizen",
    "citizen",
  ],
};

// generateWorlds validates game against defaultRoleRegistry internally.
const worlds = generateWorlds(game);

console.log("total worlds:", worlds.length);
console.log(
  "P(1 = mafia):",
  formatProbability(getProbability(worlds, "1", "mafia"))
);

const ctx: EvidenceContext = {
  config: game,
  roles: defaultRoleRegistry,
  groups: defaultGroupRegistry,
  alive: initAliveState(game),
  history: [],
};

// Placeholder parameters only - not derived from any real game data, just
// illustrative numbers to exercise the selfRoleClaim and roleAssertion
// handlers end to end. Every other observation type is still an
// uncalibrated stub.
const model = createLikelihoodModel(
  createHandlers({ truthful: 0.9, false: 0.1 }, { truthful: 0.8, false: 0.2 }),
  createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
);

console.log(
  "P(1 = commissioner) before claim:",
  formatProbability(getProbability(worlds, "1", "commissioner"))
);

const afterClaim = updateProbabilities(
  worlds,
  {
    type: "selfRoleClaim",
    round: 0,
    actor: "1",
    claim: { kind: "role", role: "commissioner" },
  },
  model,
  ctx
);

console.log(
  "P(1 = commissioner) after '1' claims commissioner:",
  formatProbability(getProbability(afterClaim, "1", "commissioner"))
);

const mafiaGroup: RoleExpression = { kind: "group", group: "mafia" };

console.log(
  "P(5 is Mafia) before assertion:",
  formatProbability(
    getExpressionProbability(afterClaim, "5", mafiaGroup, ctx.groups)
  )
);

const afterAssertion = updateProbabilities(
  afterClaim,
  { type: "roleAssertion", round: 0, actor: "1", target: "5", claim: mafiaGroup },
  model,
  ctx
);

console.log(
  "P(5 is Mafia) after '1' asserts '5 is Mafia':",
  formatProbability(
    getExpressionProbability(afterAssertion, "5", mafiaGroup, ctx.groups)
  )
);
