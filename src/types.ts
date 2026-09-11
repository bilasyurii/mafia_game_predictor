export type RoleId = "mafia" | "citizen" | "doctor" | "detective";

export type PlayerId = string;

export interface GameConfig {
  players: PlayerId[];
  roles: RoleId[];
}

export interface World {
  roles: Record<PlayerId, RoleId>;
  probability: number;
}
