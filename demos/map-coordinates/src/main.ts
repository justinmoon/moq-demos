import * as Moq from "@kixelated/moq";
import { queueAvatarLoad } from "./avatars";
import { AudioCapture } from "./audio/capture";
import { AudioPlayback } from "./audio/playback";
import { decodePacket, encodePacket } from "./audio/packets";
import { setupLogin } from "./login";
import { drawGrid, drawPlayer, drawZones } from "./render";
import { parsePosition, parseProfile, parseSpeaking, parseZones } from "./parsers";
import { ensurePlayer, pruneStale } from "./players";
import type { Player, PositionMessage, ProfilePayload } from "./types";
import { clamp, randomColor, round, shortId } from "./utils";
import { ZONES, zonesForPoint } from "./zones";

interface DebugPlayerSnapshot {
  key: string;
  isLocal: boolean;
  npub?: string;
  x: number;
  y: number;
  zones: string[];
}

interface DebugConnectionState {
  connected: boolean;
  url: string;
  localBroadcasts: number;
  remoteSubscriptions: number;
}

interface MapDemoDebugApi {
  getRelayUrl(): string;
  getConnectionState(): DebugConnectionState;
  getPlayers(): DebugPlayerSnapshot[];
  setLocalPosition(x: number, y: number): DebugPlayerSnapshot;
  getVolumes(): Record<string, number>;
  getStatus(): string;
}

type DebugWindow = Window & { __mapDemo?: MapDemoDebugApi };

declare global {
  interface Window {
    __mapDemo?: MapDemoDebugApi;
  }
}

const ARENA_WIDTH = 640;
const ARENA_HEIGHT = 480;
const POSITION_TRACK = "position.json";
const PROFILE_TRACK = "profile.json";
const AUDIO_TRACK = "audio.pcm";
const SPEAKING_TRACK = "speaking.json";
const ZONES_TRACK = "zones.json";
const SPEED = 180; // pixels per second
const SNAPSHOT_INTERVAL = 120; // ms between movement updates
const HEARTBEAT_INTERVAL = 2000; // ms between idle keep-alives
const STALE_TIMEOUT = 5000; // ms before removing remote avatars
const SPEAKING_INTERVAL_MS = 150;

const canvas = document.getElementById("arena") as HTMLCanvasElement | null;
const statusEl = document.getElementById("status");
const loginButton = document.getElementById("login") as HTMLButtonElement | null;
const nostrWarning = document.getElementById("nostr-warning") as HTMLParagraphElement | null;
const audioControls = document.getElementById("audio-controls") as HTMLFieldsetElement | null;
const micToggle = document.getElementById("mic-toggle") as HTMLButtonElement | null;
const toneToggle = document.getElementById("tone-toggle") as HTMLButtonElement | null;
const monitorCheckbox = document.getElementById("monitor-audio") as HTMLInputElement | null;

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
const audioSubscribers = new Set<Moq.Track>();
const speakingSubscribers = new Set<Moq.Track>();
const zonesSubscribers = new Set<Moq.Track>();
const selfBroadcastPaths = new Set<Moq.Path.Valid>();
const keys = new Set<string>();

let audioCapture: AudioCapture | undefined;
const audioPlayback = new AudioPlayback();
let captureMode: "mic" | "tone" | undefined;
let currentSpeakingLevel = 0;
let lastSpeakingSent = 0;
let currentZones: string[] = [];

installDebugApi();

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
  zones: [],
};
let lastSnapshotAt = 0;
let lastSentX = localPlayer.x;
let lastSentY = localPlayer.y;
let lastFrameTime = performance.now();

setupAudioUi();

function setupAudioUi() {
  updateCaptureButtons();

  micToggle?.addEventListener("click", () => {
    void toggleCapture("mic");
  });
  toneToggle?.addEventListener("click", () => {
    void toggleCapture("tone");
  });
  monitorCheckbox?.addEventListener("change", () => {
    if (!captureMode) return;
    void startCapture(captureMode);
  });
}

function enableAudioControls() {
  if (!audioControls) return;
  audioControls.disabled = false;
  micToggle?.removeAttribute("disabled");
  toneToggle?.removeAttribute("disabled");
  audioPlayback.resume().catch(() => {});
}

async function toggleCapture(mode: "mic" | "tone") {
  if (captureMode === mode) {
    await stopCapture();
  } else {
    await startCapture(mode);
  }
}

async function startCapture(mode: "mic" | "tone") {
  if (audioCapture) {
    await audioCapture.stop();
  }
  captureMode = mode;
  audioCapture = new AudioCapture(
    {
      onSamples: (channels, sampleRate) => handleCapturedSamples(channels, sampleRate),
      onLevel: (level) => handleCapturedLevel(level),
    },
    {
      syntheticTone: mode === "tone",
      monitor: monitorCheckbox?.checked ?? false,
    },
  );

  try {
    await audioPlayback.resume();
    await audioCapture.start();
  } catch (error) {
    captureMode = undefined;
    audioCapture = undefined;
    console.error("audio capture failed", error);
    updateStatus(`Audio capture failed: ${(error as Error).message}`);
  }

  updateCaptureButtons();
}

async function stopCapture() {
  if (audioCapture) {
    await audioCapture.stop();
  }
  audioCapture = undefined;
  captureMode = undefined;
  updateCaptureButtons();
  updateSpeakingLevel(0, true);
}

function updateCaptureButtons() {
  if (micToggle) {
    micToggle.classList.toggle("active", captureMode === "mic");
    micToggle.textContent = captureMode === "mic" ? "Disable Microphone" : "Enable Microphone";
  }
  if (toneToggle) {
    toneToggle.classList.toggle("active", captureMode === "tone");
    toneToggle.textContent = captureMode === "tone" ? "Stop Test Tone" : "Play Test Tone";
  }
}

function handleCapturedSamples(channels: Float32Array[], sampleRate: number) {
  if (audioSubscribers.size === 0) return;
  const packet = encodePacket(channels, sampleRate);
  if (!packet) return;
  for (const track of [...audioSubscribers]) {
    try {
      track.writeFrame(packet.buffer);
    } catch (error) {
      console.warn("failed to write audio frame", error);
      audioSubscribers.delete(track);
    }
  }
}

function handleCapturedLevel(level: number) {
  updateSpeakingLevel(level);
}

function updateSpeakingLevel(level: number, force = false) {
  currentSpeakingLevel = level;
  localPlayer.speakingLevel = level;
  const now = performance.now();
  if (!force && now - lastSpeakingSent < SPEAKING_INTERVAL_MS) return;
  broadcastSpeakingLevel();
  lastSpeakingSent = now;
}

function broadcastSpeakingLevel() {
  for (const track of [...speakingSubscribers]) {
    try {
      track.writeJson({ level: currentSpeakingLevel, ts: Date.now() });
    } catch (error) {
      console.warn("failed to write speaking level", error);
      speakingSubscribers.delete(track);
    }
  }
}

function sendZones(track: Moq.Track) {
  try {
    track.writeJson({ zones: currentZones, ts: Date.now() });
  } catch (error) {
    console.warn("failed to write zones", error);
    zonesSubscribers.delete(track);
  }
}

function broadcastZonesUpdate() {
  for (const track of [...zonesSubscribers]) {
    sendZones(track);
  }
}

function updateAudioMix() {
  const localZones = localPlayer.zones ?? [];
  for (const [path, player] of players) {
    if (player.isLocal) continue;
    const remoteZones = player.zones ?? [];
    const audible = intersects(localZones, remoteZones);
    audioPlayback.setVolume(path, audible ? 1 : 0);
  }
}

window.addEventListener("beforeunload", () => {
  audioCapture?.stop().catch(() => {});
  audioPlayback.shutdown();
});

(async () => {
  updateStatus(`Connecting to ${relayUrl}…`);
  try {
    connection = await Moq.Connection.connect(new URL(relayUrl), {
      websocket: { enabled: false },
    });
    updateStatus("Connected. Login with Nostr to join.");
    startAnnouncementLoop(connection);
    setupLogin({
      button: loginButton,
      warning: nostrWarning,
      getConnection: () => connection,
      onStatus: (message) => updateStatus(message),
      onSuccess: async (profile) => {
        currentProfile = profile;
        enableAudioControls();
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
  updateLocalZones(true);

  players.set(broadcastPath, localPlayer);
  selfBroadcastPaths.add(broadcastPath);

  active.publish(broadcastPath, broadcast);
  runPublishLoop(broadcast, broadcastPath);
  publishState(true);
  broadcastZonesUpdate();

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
        } else if (track.name === ZONES_TRACK) {
          zonesSubscribers.add(track);
          track.closed
            .catch(() => undefined)
            .finally(() => {
              zonesSubscribers.delete(track);
            });
          sendZones(track);
        } else if (track.name === AUDIO_TRACK) {
          audioSubscribers.add(track);
          track.closed
            .catch(() => undefined)
            .finally(() => {
              audioSubscribers.delete(track);
            });
        } else if (track.name === SPEAKING_TRACK) {
          speakingSubscribers.add(track);
          track.closed
            .catch(() => undefined)
            .finally(() => {
              speakingSubscribers.delete(track);
            });
          broadcastSpeakingLevel();
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

  let audioTrack: Moq.Track | undefined;
  try {
    audioTrack = broadcast.subscribe(AUDIO_TRACK, 0);
  } catch (error) {
    console.warn(`audio track unavailable for ${path}`, error);
  }

  let speakingTrack: Moq.Track | undefined;
  try {
    speakingTrack = broadcast.subscribe(SPEAKING_TRACK, 0);
  } catch (error) {
    console.warn(`speaking track unavailable for ${path}`, error);
  }

  let zonesTrack: Moq.Track | undefined;
  try {
    zonesTrack = broadcast.subscribe(ZONES_TRACK, 0);
  } catch (error) {
    console.warn(`zones track unavailable for ${path}`, error);
  }

  let positionActive = true;
  let profileActive = !!profileTrack;
  let audioActive = !!audioTrack;
  let speakingActive = !!speakingTrack;
  let zonesActive = !!zonesTrack;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    remoteSubscriptions.delete(path);
    positionTrack.close();
    profileTrack?.close();
    audioTrack?.close();
    speakingTrack?.close();
    zonesTrack?.close();
    audioPlayback.close(path);
    const existing = players.get(path);
    if (existing && !existing.isLocal) {
      existing.speakingLevel = 0;
      existing.zones = [];
      players.delete(path);
    }
    updateAudioMix();
  };

  remoteSubscriptions.set(path, finish);
  audioPlayback.setVolume(path, 0);
  updateAudioMix();

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

  if (audioTrack) {
    (async () => {
      await audioPlayback.resume();
      for (;;) {
        const payload = await audioTrack.readFrame();
        if (!payload) break;
        const packet = decodePacket(payload);
        if (!packet) continue;
        audioPlayback.enqueue(path, packet);
      }
    })()
      .catch((error) => {
        console.warn(`audio subscription failed for ${path}`, error);
      })
      .finally(() => {
        audioActive = false;
      maybeFinish();
    });
  }

  if (zonesTrack) {
    (async () => {
      for (;;) {
        const payload = await zonesTrack.readJson();
        if (!payload) break;
        const zones = parseZones(payload);
        if (!zones) continue;
        const player = ensurePlayer(players, path, undefined, undefined, localPlayer);
        player.zones = zones;
        updateAudioMix();
      }
    })()
      .catch((error) => {
        console.warn(`zones subscription failed for ${path}`, error);
      })
      .finally(() => {
        zonesActive = false;
        const player = players.get(path);
        if (player) player.zones = [];
        updateAudioMix();
        maybeFinish();
      });
  }

  if (speakingTrack) {
    (async () => {
      for (;;) {
        const payload = await speakingTrack.readJson();
        if (!payload) break;
        const level = parseSpeaking(payload);
        if (level === undefined) continue;
        const player = ensurePlayer(players, path, undefined, undefined, localPlayer);
        player.speakingLevel = level;
      }
    })()
      .catch((error) => {
        console.warn(`speaking subscription failed for ${path}`, error);
      })
      .finally(() => {
        speakingActive = false;
        const player = players.get(path);
        if (player) player.speakingLevel = 0;
        maybeFinish();
      });
  }

  function maybeFinish() {
    if (!positionActive && !profileActive && !audioActive && !speakingActive && !zonesActive) {
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
    updateLocalZones();
    return;
  }

  const length = Math.hypot(dx, dy) || 1;
  localPlayer.x = clamp(localPlayer.x + (dx / length) * SPEED * dt, 0, ARENA_WIDTH);
  localPlayer.y = clamp(localPlayer.y + (dy / length) * SPEED * dt, 0, ARENA_HEIGHT);
  localPlayer.lastSeen = performance.now();

  publishState();
  updateLocalZones();
}

function updateLocalZones(force = false) {
  const next = zonesForPoint(localPlayer.x, localPlayer.y);
  if (!force && arraysEqual(next, currentZones)) return;
  currentZones = next;
  localPlayer.zones = next;
  broadcastZonesUpdate();
  updateAudioMix();
}

function render() {
  ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  drawZones(ctx, localPlayer.zones ?? []);
  drawGrid(ctx, ARENA_WIDTH, ARENA_HEIGHT);
  for (const player of players.values()) {
    drawPlayer(ctx, player);
  }

  const zoneLabel = (localPlayer.zones ?? [])
    .map((id) => ZONES.find((zone) => zone.id === id)?.name ?? id)
    .join(", ") || "None";

  const label = connection
    ? currentProfile
      ? `Connected · players: ${players.size} · zone: ${zoneLabel}`
      : `Spectating · players: ${players.size} · zone: ${zoneLabel}`
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

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function installDebugApi() {
  const win = window as DebugWindow;
  win.__mapDemo = {
    getRelayUrl: () => relayUrl,
    getConnectionState: (): DebugConnectionState => ({
      connected: !!connection,
      url: (connection?.url ?? new URL(relayUrl)).toString(),
      localBroadcasts: selfBroadcastPaths.size,
      remoteSubscriptions: remoteSubscriptions.size,
    }),
    getPlayers: (): DebugPlayerSnapshot[] =>
      Array.from(players.entries()).map(([key, player]) => ({
        key,
        isLocal: !!player.isLocal,
        npub: player.npub,
        x: player.x,
        y: player.y,
        zones: [...(player.zones ?? [])],
      })),
    setLocalPosition: (x: number, y: number): DebugPlayerSnapshot => {
      if (!currentProfile) {
        throw new Error("local player not initialized");
      }
      localPlayer.x = clamp(x, 0, ARENA_WIDTH);
      localPlayer.y = clamp(y, 0, ARENA_HEIGHT);
      localPlayer.lastSeen = performance.now();
      publishState(true);
      updateLocalZones(true);
      return {
        key: localPlayer.key,
        isLocal: true,
        npub: localPlayer.npub,
        x: localPlayer.x,
        y: localPlayer.y,
        zones: [...(localPlayer.zones ?? [])],
      };
    },
    getVolumes: () => audioPlayback.getVolumes(),
    getStatus: () => statusNode.textContent ?? "",
  };
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false;
  return a.some((value) => b.includes(value));
}
