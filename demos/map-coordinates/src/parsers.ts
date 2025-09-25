import type { PositionMessage, ProfilePayload } from "./types";

export function parsePosition(value: unknown): PositionMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const npub = typeof record.npub === "string" ? record.npub : undefined;
  const tab = typeof record.tab === "string" ? record.tab : undefined;
  const x = typeof record.x === "number" ? record.x : undefined;
  const y = typeof record.y === "number" ? record.y : undefined;
  const color = typeof record.color === "string" ? record.color : undefined;
  if (!npub || !tab || x === undefined || y === undefined) return undefined;
  return { npub, tab, x, y, color };
}

export function parseProfile(value: unknown): ProfilePayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const npub = typeof record.npub === "string" ? record.npub : undefined;
  const pubkey = typeof record.pubkey === "string" ? record.pubkey : undefined;
  if (!pubkey || !npub) return undefined;
  const displayName = typeof record.displayName === "string" ? record.displayName : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  const picture = typeof record.picture === "string" ? record.picture : undefined;
  const about = typeof record.about === "string" ? record.about : undefined;
  const relays = Array.isArray(record.relays)
    ? record.relays.filter((relay): relay is string => typeof relay === "string")
    : undefined;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : undefined;
  return { npub, pubkey, displayName, name, picture, about, relays, updatedAt };
}

export function parseSpeaking(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const level = (value as Record<string, unknown>).level;
  if (typeof level !== "number" || Number.isNaN(level)) return undefined;
  return Math.max(0, Math.min(1, level));
}
