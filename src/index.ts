import { GameConfig } from "./types";
import { generateWorlds } from "./generateWorlds";
import { getProbability } from "./probability";

const game: GameConfig = {
  players: ["oleg", "anton", "yura", "katya"],
  roles: ["mafia", "mafia", "doctor", "commissioner"],
};

const worlds = generateWorlds(game);

console.log(worlds.length);
// 12

console.log(getProbability(worlds, "oleg", "mafia"));
// 0.5
