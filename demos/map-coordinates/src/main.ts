import * as Moq from "@kixelated/moq";
import { queueAvatarLoad } from "./avatars";
import { setupLogin } from "./login";
import { drawGrid, drawPlayer } from "./render";
import { parsePosition, parseProfile } from "./parsers";
import { ensurePlayer, pruneStale } from "./players";
import type { Player, PositionMessage, ProfilePayload } from "./types";
import { clamp, randomColor, round, shortId } from "./utils";

const ARENA_WIDTH = 640;
const ARENA_HEIGHT = 480;
const POSITION_TRACK = "position.json";
const PROFILE_TRACK = "profile.json";
const SPEED = 180; // pixels per second
const SNAPSHOT_INTERVAL = 120; // ms between movement updates
const HEARTBEAT_INTERVAL = 2000; // ms between idle keep-alives
const STALE_TIMEOUT = 5000; // ms before removing remote avatars

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
    setupLogin({
      button: loginButton,
      warning: nostrWarning,
      getConnection: () => connection,
      onStatus: (message) => updateStatus(message),
      onSuccess: async (profile) => {
        currentProfile = profile;
        await startSession(connection!, profile);
        broadcastProfileUpdate();
      },
    });
    requestAnimationFrame(tick);
  } catch (error) {
    console.error(error);
    updateStatus(`Connection failed: ${(error as Error).message}`, true);
  }
})();

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
      const player = ensurePlayer(players, path, msg.npub, msg.color, localPlayer);
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
        const player = ensurePlayer(players, path, profile.npub, undefined, localPlayer);
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
  pruneStale(players, remoteSubscriptions, now, STALE_TIMEOUT);
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

function render() {
  ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  drawGrid(ctx, ARENA_WIDTH, ARENA_HEIGHT);
  for (const player of players.values()) {
    drawPlayer(ctx, player);
  }

  const label = connection
    ? currentProfile
      ? `Connected · players: ${players.size}`
      : `Spectating · players: ${players.size}`
    : `Connecting to ${relayUrl}…`;
  updateStatusIfNotFrozen(label);
}
function updateStatus(message: string, freeze = false) {
  statusFrozen = freeze;
  statusNode.textContent = message;
}

function updateStatusIfNotFrozen(message: string) {
  if (statusFrozen) return;
  statusNode.textContent = message;
}
