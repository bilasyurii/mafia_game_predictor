import { GameConfig } from "./types";
import { generateWorlds } from "./generateWorlds";
import { getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState } from "./facts";
import { formatProbability } from "./format";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry, validateGameConfig } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";

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

validateGameConfig(game, defaultRoleRegistry);

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
// illustrative numbers to exercise the selfRoleClaim handler end to end.
// Every other observation type is still an uncalibrated stub.
const model = createLikelihoodModel(
  createHandlers({ truthful: 0.9, false: 0.1 })
);

console.log(
  "P(1 = commissioner) before claim:",
  formatProbability(getProbability(worlds, "1", "commissioner"))
);

const afterClaim = updateProbabilities(
  worlds,
  {
    type: "selfRoleClaim",
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
