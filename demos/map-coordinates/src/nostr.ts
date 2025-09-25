import { nip19, SimplePool } from "nostr-tools";
import type { ProfilePayload } from "./types";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

export interface NostrRelayPolicy {
  read?: boolean;
  write?: boolean;
}

export interface NostrSigner {
  getPublicKey(): Promise<string>;
  getProfile?(pubkey: string): Promise<Record<string, unknown>>;
  getRelays?(): Promise<Record<string, NostrRelayPolicy>>;
}

declare global {
  interface Window {
    nostr?: NostrSigner;
  }
}

export function getNostrSigner(): NostrSigner | undefined {
  return window.nostr;
}

export function hasNostrSigner(): boolean {
  return typeof window !== "undefined" && !!window.nostr;
}

export async function gatherProfile(pubkey: string, signer: NostrSigner | undefined): Promise<ProfilePayload> {
  const npub = nip19.npubEncode(pubkey);
  const relays = await collectReadableRelays(signer);

  let metadata: Record<string, unknown> | undefined;
  if (signer?.getProfile) {
    try {
      const fromSigner = await signer.getProfile(pubkey);
      if (fromSigner && typeof fromSigner === "object") {
        metadata = fromSigner;
      }
    } catch (error) {
      console.warn("getProfile failed", error);
    }
  }

  let updatedAt: number | undefined;
  if (!metadata) {
    const pool = new SimplePool();
    try {
      const events = await pool.querySync(relays, { authors: [pubkey], kinds: [0] });
      if (events.length > 0) {
        events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
        const latest = events[0];
        updatedAt = latest.created_at ?? undefined;
        metadata = JSON.parse(latest.content ?? "{}") as Record<string, unknown>;
      }
    } catch (error) {
      console.warn("failed to fetch metadata from relays", error);
    } finally {
      try {
        pool.close(relays);
      } catch {
        // ignore
      }
    }
  }

  const displayName = metadata && typeof metadata.display_name === "string" ? metadata.display_name : undefined;
  const name = metadata && typeof metadata.name === "string" ? metadata.name : undefined;
  const picture = metadata && typeof metadata.picture === "string" ? metadata.picture : undefined;
  const about = metadata && typeof metadata.about === "string" ? metadata.about : undefined;

  return {
    npub,
    pubkey,
    displayName,
    name,
    picture,
    about,
    relays,
    updatedAt,
  };
}

export async function collectReadableRelays(signer: NostrSigner | undefined): Promise<string[]> {
  const relays = new Set(DEFAULT_RELAYS);
  if (!signer?.getRelays) {
    return Array.from(relays);
  }

  try {
    const relayPolicy = await signer.getRelays();
    for (const [url, policy] of Object.entries(relayPolicy)) {
      if (policy.read !== false) {
        relays.add(url);
      }
    }
  } catch (error) {
    console.warn("failed to read relays from signer", error);
  }

  return Array.from(relays);
}

export function shortenNpub(npub: string): string {
  return `${npub.slice(0, 8)}…${npub.slice(-4)}`;
}
