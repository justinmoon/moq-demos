import type * as Moq from "@kixelated/moq";
import type { Player } from "./types";
import { randomColor } from "./utils";

export function ensurePlayer(
  players: Map<string, Player>,
  path: Moq.Path.Valid,
  npub: string | undefined,
  color: string | undefined,
  fallback: Player,
): Player {
  let player = players.get(path);
  if (!player) {
    player = {
      key: path,
      npub,
      x: fallback.x,
      y: fallback.y,
      color: color ?? randomColor(),
      lastSeen: performance.now(),
      isLocal: false,
    };
    players.set(path, player);
  } else {
    if (!player.npub && npub) {
      player.npub = npub;
    }
    if (color && !player.profile) {
      player.color = color;
    }
  }
  return player;
}

export function pruneStale(
  players: Map<string, Player>,
  remoteSubscriptions: Map<string, () => void>,
  now: number,
  staleTimeout: number,
): void {
  for (const [key, player] of players) {
    if (player.isLocal) continue;
    if (now - player.lastSeen > staleTimeout) {
      players.delete(key);
      remoteSubscriptions.get(key)?.();
    }
  }
}

export function playerLabel(player: Player, shorten: (npub: string) => string): string {
  if (player.isLocal) return "You";

  const metadata = player.profile;
  if (metadata) {
    return metadata.displayName ?? metadata.name ?? shorten(metadata.npub);
  }

  if (player.npub) {
    return shorten(player.npub);
  }

  return player.key.slice(-4);
}
