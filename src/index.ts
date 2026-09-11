import { GameConfig } from "./types";
import { generateWorlds } from "./generateWorlds";
import { getProbability } from "./probability";

const game: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7", "8"],
  roles: [
    "mafia",
    "mafia",
    "doctor",
    "detective",
    "citizen",
    "citizen",
    "citizen",
    "citizen",
  ],
};

const worlds = generateWorlds(game);

console.log(worlds.length);

console.log(getProbability(worlds, "1", "mafia"));
