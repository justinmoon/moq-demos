import * as Moq from "@kixelated/moq";
import { nip19, SimplePool } from "nostr-tools";

const ARENA_WIDTH = 640;
const ARENA_HEIGHT = 480;
const POSITION_TRACK = "position.json";
const PROFILE_TRACK = "profile.json";
const SPEED = 180; // pixels per second
const SNAPSHOT_INTERVAL = 120; // ms between movement updates
const HEARTBEAT_INTERVAL = 2000; // ms between idle keep-alives
const STALE_TIMEOUT = 5000; // ms before removing remote avatars
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

const canvas = document.getElementById("arena") as HTMLCanvasElement | null;
const statusEl = document.getElementById("status");
const loginButton = document.getElementById("login") as HTMLButtonElement | null;
const nostrWarning = document.getElementById("nostr-warning") as HTMLParagraphElement | null;

if (!canvas) {
  throw new Error("missing arena canvas");
}
const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("failed to acquire 2d context");
}
const statusNode = statusEl ?? document.body;

interface NostrRelayPolicy {
  read?: boolean;
  write?: boolean;
}

interface NostrSigner {
  getPublicKey(): Promise<string>;
  getProfile?(pubkey: string): Promise<Record<string, unknown>>;
  getRelays?(): Promise<Record<string, NostrRelayPolicy>>;
}

declare global {
  interface Window {
    nostr?: NostrSigner;
  }
}

interface ProfilePayload {
  npub: string;
  pubkey: string;
  displayName?: string;
  name?: string;
  picture?: string;
  about?: string;
  relays?: string[];
  updatedAt?: number;
}

interface PositionMessage {
  npub: string;
  tab: string;
  x: number;
  y: number;
  color?: string;
}

interface Player {
  key: string;
  npub?: string;
  x: number;
  y: number;
  color: string;
  lastSeen: number;
  isLocal: boolean;
  profile?: ProfilePayload;
  image?: HTMLImageElement;
  imageUrl?: string;
}

const relayUrl = (() => {
  const raw = (import.meta as Record<string, unknown>).env?.VITE_RELAY_URL;
  if (typeof raw === "string" && raw.length > 0) return raw;
  const fromQuery = new URL(window.location.href).searchParams.get("relay");
  return fromQuery ?? "http://localhost:4443/anon";
})();

const prefix = Moq.Path.from("demo", "map-coordinates", "players");
const tabSuffix = shortId();

const players = new Map<string, Player>();
const remoteSubscriptions = new Map<string, () => void>();
const positionSubscribers = new Set<Moq.Track>();
const profileSubscribers = new Set<Moq.Track>();
const selfBroadcastPaths = new Set<Moq.Path.Valid>();
const avatarCache = new Map<string, Promise<HTMLImageElement | undefined>>();

const keys = new Set<string>();
window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  keys.add(event.code);
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

let connection: Moq.Connection.Established | undefined;
let broadcast: Moq.Broadcast | undefined;
let currentProfile: ProfilePayload | undefined;
let announcementStarted = false;
let statusFrozen = false;

const localPlayer: Player = {
  key: "local",
  x: Math.random() * (ARENA_WIDTH - 60) + 30,
  y: Math.random() * (ARENA_HEIGHT - 60) + 30,
  color: randomColor(),
  lastSeen: performance.now(),
  isLocal: true,
};

let lastSnapshotAt = 0;
let lastSentX = localPlayer.x;
let lastSentY = localPlayer.y;
let lastFrameTime = performance.now();

(async () => {
  updateStatus(`Connecting to ${relayUrl}…`);
  try {
    connection = await Moq.Connection.connect(new URL(relayUrl));
    updateStatus("Connected. Login with Nostr to join.");
    startAnnouncementLoop(connection);
    setupLogin();
    requestAnimationFrame(tick);
  } catch (error) {
    console.error(error);
    updateStatus(`Connection failed: ${(error as Error).message}`, true);
  }
})();

function setupLogin() {
  if (!loginButton) return;

  const signer = window.nostr;
  if (!signer) {
    loginButton.disabled = true;
    loginButton.textContent = "Nostr signer required";
    if (nostrWarning) nostrWarning.hidden = false;
    return;
  }

  loginButton.disabled = false;
  loginButton.addEventListener("click", async () => {
    if (!connection) return;
    loginButton.disabled = true;
    loginButton.textContent = "Signing…";
    try {
      const pubkey = await signer.getPublicKey();
      const profile = await gatherProfile(pubkey);
      currentProfile = profile;
      loginButton.textContent = "Logged in";
      loginButton.classList.add("success");
      updateStatus(`Logged in as ${profile.displayName ?? profile.name ?? shortenNpub(profile.npub)}.`);
      await startSession(connection, profile);
      broadcastProfileUpdate();
    } catch (error) {
      console.error("nostr login failed", error);
      loginButton.disabled = false;
      loginButton.textContent = "Login with Nostr";
      updateStatus(`Login failed: ${(error as Error).message}`);
    }
  });
}

async function startSession(active: Moq.Connection.Established, profile: ProfilePayload) {
  broadcast?.close();

  broadcast = new Moq.Broadcast();
  const pathSuffix = Moq.Path.from(`${profile.npub}#${tabSuffix}`);
  const broadcastPath = Moq.Path.join(prefix, pathSuffix);

  localPlayer.key = broadcastPath;
  localPlayer.npub = profile.npub;
  localPlayer.profile = profile;
  queueAvatarLoad(localPlayer, profile.picture);

  players.set(broadcastPath, localPlayer);
  selfBroadcastPaths.add(broadcastPath);

  active.publish(broadcastPath, broadcast);
  runPublishLoop(broadcast, broadcastPath);
  publishState(true);

  window.addEventListener("beforeunload", () => {
    broadcast?.close();
    active.close();
  });
}

function runPublishLoop(active: Moq.Broadcast, selfPath: Moq.Path.Valid) {
  (async () => {
    for (;;) {
      try {
        const request = await active.requested();
        if (!request) break;

        const { track } = request;
        if (track.name === POSITION_TRACK) {
          positionSubscribers.add(track);
          track.closed
            .catch(() => undefined)
            .finally(() => {
              positionSubscribers.delete(track);
            });
          track.writeJson(serializeLocal());
        } else if (track.name === PROFILE_TRACK) {
          profileSubscribers.add(track);
          track.closed
            .catch(() => undefined)
            .finally(() => {
              profileSubscribers.delete(track);
            });
          sendProfile(track);
        } else {
          track.close(new Error(`unsupported track ${track.name}`));
        }
      } catch (error) {
        console.warn("publish request failed", error);
      }
    }
  })().catch((error) => {
    console.error("publish loop ended", error);
    players.delete(selfPath);
    selfBroadcastPaths.delete(selfPath);
  });
}

function startAnnouncementLoop(active: Moq.Connection.Established) {
  if (announcementStarted) return;
  announcementStarted = true;

  const announced = active.announced(prefix);
  (async () => {
    for (;;) {
      const entry = await announced.next();
      if (!entry) break;
      if (selfBroadcastPaths.has(entry.path)) continue;
      if (entry.active) {
        subscribeTo(entry.path);
      } else {
        unsubscribeFrom(entry.path);
      }
    }
  })().catch((error) => console.error("announcement loop failed", error));
}

function subscribeTo(path: Moq.Path.Valid) {
  if (!connection) return;
  if (remoteSubscriptions.has(path)) return;
  if (selfBroadcastPaths.has(path)) return;

  const broadcast = connection.consume(path);

  let positionTrack: Moq.Track;
  try {
    positionTrack = broadcast.subscribe(POSITION_TRACK, 0);
  } catch (error) {
    console.warn(`failed to subscribe to ${POSITION_TRACK} for ${path}`, error);
    return;
  }

  let profileTrack: Moq.Track | undefined;
  try {
    profileTrack = broadcast.subscribe(PROFILE_TRACK, 0);
  } catch (error) {
    console.warn(`profile track unavailable for ${path}`, error);
  }

  let positionActive = true;
  let profileActive = !!profileTrack;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    remoteSubscriptions.delete(path);
    positionTrack.close();
    profileTrack?.close();
    const existing = players.get(path);
    if (existing && !existing.isLocal) {
      players.delete(path);
    }
  };

  remoteSubscriptions.set(path, finish);

  (async () => {
    for (;;) {
      const payload = await positionTrack.readJson();
      if (!payload) break;
      const msg = parsePosition(payload);
      if (!msg) continue;
      const player = ensurePlayer(path, msg.npub, msg.color);
      player.x = clamp(msg.x, 0, ARENA_WIDTH);
      player.y = clamp(msg.y, 0, ARENA_HEIGHT);
      player.lastSeen = performance.now();
    }
  })()
    .catch((error) => {
      console.warn(`position subscription failed for ${path}`, error);
    })
    .finally(() => {
      positionActive = false;
      maybeFinish();
    });

  if (profileTrack) {
    (async () => {
      for (;;) {
        const payload = await profileTrack.readJson();
        if (!payload) break;
        const profile = parseProfile(payload);
        if (!profile) continue;
        const player = ensurePlayer(path, profile.npub, undefined);
        player.profile = profile;
        player.npub = profile.npub;
        queueAvatarLoad(player, profile.picture);
      }
    })()
      .catch((error) => {
        console.warn(`profile subscription failed for ${path}`, error);
      })
      .finally(() => {
        profileActive = false;
        maybeFinish();
      });
  }

  function maybeFinish() {
    if (!positionActive && !profileActive) {
      finish();
    }
  }
}

function unsubscribeFrom(path: Moq.Path.Valid) {
  const dispose = remoteSubscriptions.get(path);
  if (!dispose) return;
  dispose();
}

function publishState(force = false) {
  if (!broadcast || positionSubscribers.size === 0 || !currentProfile) return;

  const now = performance.now();
  const diffX = Math.abs(localPlayer.x - lastSentX);
  const diffY = Math.abs(localPlayer.y - lastSentY);
  const idle = diffX < 1 && diffY < 1;

  if (!force) {
    const interval = idle ? HEARTBEAT_INTERVAL : SNAPSHOT_INTERVAL;
    if (now - lastSnapshotAt < interval) {
      return;
    }
  }

  lastSnapshotAt = now;
  lastSentX = localPlayer.x;
  lastSentY = localPlayer.y;

  const payload = serializeLocal();
  for (const track of [...positionSubscribers]) {
    try {
      track.writeJson(payload);
    } catch (error) {
      console.warn("failed to write position", error);
      positionSubscribers.delete(track);
    }
  }
}

function serializeLocal(): PositionMessage {
  if (!currentProfile) {
    throw new Error("serializeLocal called before profile initialized");
  }
  return {
    npub: currentProfile.npub,
    tab: tabSuffix,
    x: round(localPlayer.x),
    y: round(localPlayer.y),
    color: localPlayer.color,
  };
}

function sendProfile(track: Moq.Track) {
  if (!currentProfile) return;
  try {
    track.writeJson(currentProfile);
  } catch (error) {
    console.warn("failed to write profile", error);
  }
}

function broadcastProfileUpdate() {
  if (!currentProfile) return;
  for (const track of [...profileSubscribers]) {
    try {
      track.writeJson(currentProfile);
    } catch (error) {
      console.warn("failed to broadcast profile", error);
      profileSubscribers.delete(track);
    }
  }
}

function tick(now: number) {
  const dt = Math.min(32, now - lastFrameTime);
  updateLocalPosition(dt / 1000);
  pruneStale(now);
  render();
  lastFrameTime = now;
  requestAnimationFrame(tick);
}

function updateLocalPosition(dt: number) {
  if (!players.has(localPlayer.key)) return;

  const up = keys.has("ArrowUp") || keys.has("KeyW");
  const down = keys.has("ArrowDown") || keys.has("KeyS");
  const left = keys.has("ArrowLeft") || keys.has("KeyA");
  const right = keys.has("ArrowRight") || keys.has("KeyD");

  let dx = 0;
  let dy = 0;
  if (up) dy -= 1;
  if (down) dy += 1;
  if (left) dx -= 1;
  if (right) dx += 1;

  if (dx === 0 && dy === 0) {
    publishState();
    return;
  }

  const length = Math.hypot(dx, dy) || 1;
  localPlayer.x = clamp(localPlayer.x + (dx / length) * SPEED * dt, 0, ARENA_WIDTH);
  localPlayer.y = clamp(localPlayer.y + (dy / length) * SPEED * dt, 0, ARENA_HEIGHT);
  localPlayer.lastSeen = performance.now();

  publishState();
}

function pruneStale(now: number) {
  for (const [key, player] of players) {
    if (player.isLocal) continue;
    if (now - player.lastSeen > STALE_TIMEOUT) {
      players.delete(key);
      remoteSubscriptions.get(key)?.();
    }
  }
}

function render() {
  ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  drawGrid();
  for (const player of players.values()) {
    drawPlayer(player);
  }

  const label = connection
    ? currentProfile
      ? `Connected · players: ${players.size}`
      : `Spectating · players: ${players.size}`
    : `Connecting to ${relayUrl}…`;
  updateStatusIfNotFrozen(label);
}

function drawGrid() {
  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= ARENA_WIDTH; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA_HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= ARENA_HEIGHT; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA_WIDTH, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(player: Player) {
  const radius = player.isLocal ? 12 : 10;

  if (player.image) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(player.image, player.x - radius, player.y - radius, radius * 2, radius * 2);
    ctx.restore();
  } else {
    ctx.save();
    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.fillText(playerLabel(player), player.x, player.y - radius - 6);
  ctx.restore();
}

function playerLabel(player: Player): string {
  if (player.isLocal) return "You";
  const metadata = player.profile;
  if (metadata) {
    return metadata.displayName ?? metadata.name ?? shortenNpub(metadata.npub);
  }
  if (player.npub) {
    return shortenNpub(player.npub);
  }
  return player.key.slice(-4);
}

function ensurePlayer(path: Moq.Path.Valid, npub?: string, color?: string): Player {
  let player = players.get(path);
  if (!player) {
    player = {
      key: path,
      npub,
      x: localPlayer.x,
      y: localPlayer.y,
      color: color ?? randomColor(),
      lastSeen: performance.now(),
      isLocal: false,
    };
    players.set(path, player);
  } else if (!player.npub && npub) {
    player.npub = npub;
  }
  if (color && !player.profile) {
    player.color = color;
  }
  return player;
}

function parsePosition(value: unknown): PositionMessage | undefined {
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

function parseProfile(value: unknown): ProfilePayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const pubkey = typeof record.pubkey === "string" ? record.pubkey : undefined;
  const npub = typeof record.npub === "string" ? record.npub : pubkey ? nip19.npubEncode(pubkey) : undefined;
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

async function gatherProfile(pubkey: string): Promise<ProfilePayload> {
  const npub = nip19.npubEncode(pubkey);
  const signer = window.nostr;
  const relays = new Set(DEFAULT_RELAYS);
  if (signer?.getRelays) {
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
  }

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
      const relayList = Array.from(relays);
      const events = await pool.querySync(relayList, { authors: [pubkey], kinds: [0] });
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
        pool.close(Array.from(relays));
      } catch {
        // ignore close errors
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
    relays: Array.from(relays),
    updatedAt,
  };
}

function queueAvatarLoad(player: Player, url?: string) {
  if (!url || url === player.imageUrl) return;
  player.imageUrl = url;

  let pending = avatarCache.get(url);
  if (!pending) {
    pending = loadAvatar(url);
    avatarCache.set(url, pending);
  }

  pending
    .then((image) => {
      if (player.imageUrl !== url) return;
      player.image = image;
    })
    .catch(() => {
      if (player.imageUrl === url) {
        player.image = undefined;
      }
    });
}

function loadAvatar(url: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = url;
  });
}

function updateStatus(message: string, freeze = false) {
  statusFrozen = freeze;
  statusNode.textContent = message;
}

function updateStatusIfNotFrozen(message: string) {
  if (statusFrozen) return;
  statusNode.textContent = message;
}

function randomColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}deg 85% 60%)`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

function shortenNpub(npub: string): string {
  return `${npub.slice(0, 8)}…${npub.slice(-4)}`;
}
