import * as Moq from "@kixelated/moq";

const ARENA_WIDTH = 640;
const ARENA_HEIGHT = 480;
const POSITION_TRACK = "position.json";
const SPEED = 180; // pixels per second
const SNAPSHOT_INTERVAL = 120; // ms between outbound updates
const HEARTBEAT_INTERVAL = 2000; // ms between idle keep-alives
const STALE_TIMEOUT = 5000; // ms before forgetting a remote player

const canvas = document.getElementById("arena") as HTMLCanvasElement | null;
const statusEl = document.getElementById("status");

if (!canvas) {
  throw new Error("missing arena canvas");
}
const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("failed to acquire 2d context");
}
const statusNode = statusEl ?? document.body;

interface Player {
  id: string;
  x: number;
  y: number;
  color: string;
  lastSeen: number;
  isLocal: boolean;
}

interface PositionMessage {
  id: string;
  color: string;
  x: number;
  y: number;
}

const relayUrl = (() => {
  const raw = (import.meta as Record<string, unknown>).env?.VITE_RELAY_URL;
  if (typeof raw === "string" && raw.length > 0) return raw;
  const fromHash = new URL(window.location.href).searchParams.get("relay");
  return fromHash ?? "http://localhost:4443/anon";
})();

const players = new Map<string, Player>();

const localPlayer: Player = {
  id: crypto.randomUUID(),
  x: Math.random() * (ARENA_WIDTH - 60) + 30,
  y: Math.random() * (ARENA_HEIGHT - 60) + 30,
  color: randomColor(),
  lastSeen: performance.now(),
  isLocal: true,
};
players.set(localPlayer.id, localPlayer);

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
const subscribers = new Set<Moq.Track>();
const remoteSubscriptions = new Map<string, () => void>();
let lastSnapshotAt = 0;
let lastSentX = localPlayer.x;
let lastSentY = localPlayer.y;

(async () => {
  updateStatus(`Connecting to ${relayUrl}…`);
  try {
    connection = await Moq.Connection.connect(new URL(relayUrl));
    updateStatus(`Connected to ${relayUrl}`);
    await startSession(connection);
  } catch (error) {
    console.error(error);
    updateStatus(`Connection failed: ${(error as Error).message}`);
  }
})();

async function startSession(active: Moq.Connection.Established) {
  broadcast = new Moq.Broadcast();
  const prefix = Moq.Path.from("demo", "map-coordinates", "players");
  const broadcastPath = Moq.Path.join(prefix, Moq.Path.from(localPlayer.id));
  active.publish(broadcastPath, broadcast);

  runPublishLoop(broadcast);
  runAnnouncementLoop(active, prefix, broadcastPath);

  lastFrameTime = performance.now();
  requestAnimationFrame(tick);
  publishState(true);

  window.addEventListener("beforeunload", () => {
    broadcast?.close();
    active.close();
  });
}

function runPublishLoop(active: Moq.Broadcast) {
  (async () => {
    for (;;) {
      try {
        const request = await active.requested();
        if (!request) break;
        const { track } = request;
        if (track.name !== POSITION_TRACK) {
          track.close(new Error(`unsupported track ${track.name}`));
          continue;
        }
        subscribers.add(track);
        track.closed
          .catch(() => undefined)
          .finally(() => {
            subscribers.delete(track);
          });
        track.writeJson(serializeLocal());
      } catch (error) {
        console.warn("broadcast request failed", error);
      }
    }
  })().catch((error) => console.error("publish loop ended", error));
}

function runAnnouncementLoop(
  active: Moq.Connection.Established,
  prefix: Moq.Path.Valid,
  ownPath: Moq.Path.Valid,
) {
  const announced = active.announced(prefix);
  (async () => {
    for (;;) {
      const entry = await announced.next();
      if (!entry) break;
      if (entry.path === ownPath) continue;
      if (entry.active) {
        subscribeTo(entry.path);
      } else {
        unsubscribeFrom(entry.path);
      }
    }
  })().catch((error) => console.error("announcement loop failed", error));
}

function subscribeTo(path: Moq.Path.Valid) {
  if (!connection || remoteSubscriptions.has(path)) return;

  const broadcast = connection.consume(path);
  const track = broadcast.subscribe(POSITION_TRACK, 0);
  const id = path.split("/").pop() ?? path;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    remoteSubscriptions.delete(path);
    if (!players.get(id)?.isLocal) {
      players.delete(id);
    }
    track.close();
  };

  remoteSubscriptions.set(path, finish);

  (async () => {
    for (;;) {
      const payload = await track.readJson();
      if (!payload) break;
      const msg = parsePosition(payload);
      if (!msg || msg.id === localPlayer.id) continue;
      const player = ensurePlayer(msg.id, msg.color);
      player.x = clamp(msg.x, 0, ARENA_WIDTH);
      player.y = clamp(msg.y, 0, ARENA_HEIGHT);
      player.lastSeen = performance.now();
    }
  })()
    .catch((error) => {
      console.warn(`subscription to ${path} failed`, error);
    })
    .finally(finish);
}

function unsubscribeFrom(path: Moq.Path.Valid) {
  const close = remoteSubscriptions.get(path);
  if (!close) return;
  close();
}

function ensurePlayer(id: string, color?: string): Player {
  const existing = players.get(id);
  if (existing) {
    if (color && !existing.isLocal) {
      existing.color = color;
    }
    return existing;
  }
  const created: Player = {
    id,
    x: localPlayer.x,
    y: localPlayer.y,
    color: color ?? randomColor(),
    lastSeen: performance.now(),
    isLocal: false,
  };
  players.set(id, created);
  return created;
}

function tick(now: number) {
  const dt = Math.min(32, now - lastFrameTime);
  updateLocalPosition(dt / 1000);
  pruneStale(now);
  render();
  lastFrameTime = now;
  requestAnimationFrame(tick);
}

let lastFrameTime = performance.now();

function updateLocalPosition(dt: number) {
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

function publishState(force = false) {
  if (!broadcast || subscribers.size === 0) return;
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
  for (const track of [...subscribers]) {
    try {
      track.writeJson(payload);
    } catch (error) {
      console.warn("failed to write to subscriber", error);
      subscribers.delete(track);
    }
  }
}

function serializeLocal(): PositionMessage {
  return {
    id: localPlayer.id,
    color: localPlayer.color,
    x: round(localPlayer.x),
    y: round(localPlayer.y),
  };
}

function parsePosition(value: unknown): PositionMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  const color = typeof record.color === "string" ? record.color : undefined;
  const x = typeof record.x === "number" ? record.x : undefined;
  const y = typeof record.y === "number" ? record.y : undefined;
  if (!id || color === undefined || x === undefined || y === undefined) return undefined;
  return { id, color, x, y };
}

function pruneStale(now: number) {
  for (const [id, player] of players) {
    if (player.isLocal) continue;
    if (now - player.lastSeen > STALE_TIMEOUT) {
      players.delete(id);
    }
  }
}

function render() {
  ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  drawGrid();
  for (const player of players.values()) {
    drawPlayer(player);
  }
  statusNode.textContent = connection
    ? `Connected · players: ${players.size}`
    : `Connecting to ${relayUrl}…`;
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
  ctx.save();
  ctx.fillStyle = player.color;
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.isLocal ? 12 : 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.fillText(player.isLocal ? "You" : player.id.slice(0, 4), player.x, player.y - 18);
  ctx.restore();
}

function updateStatus(text: string) {
  statusNode.textContent = text;
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
