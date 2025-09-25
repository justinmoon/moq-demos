import type { DecodedPacket } from "./packets";

const MIN_LEAD_SECONDS = 0.15;
const MAX_LEAD_SECONDS = 0.75;
const LEAD_STEP_UP = 0.08;
const LEAD_STEP_DOWN = 0.02;
const STABLE_SECONDS = 8;
const SHRINK_COOLDOWN_SECONDS = 4;

export interface PlaybackStats {
  framesDecoded: number;
  bufferedAhead: number;
  underruns: number;
  targetLead: number;
}

interface RemoteState {
  gain: GainNode;
  nextTime: number;
  stats: PlaybackStats;
  targetLead: number;
  lastUnderrunAt: number;
  lastAdjustmentAt: number;
}

export class AudioPlayback {
  #context?: AudioContext;
  #remotes = new Map<string, RemoteState>();

  async resume(): Promise<void> {
    if (!this.#context) {
      this.#context = new AudioContext({ sampleRate: 48000 });
    }
    if (this.#context.state === "suspended") {
      await this.#context.resume();
    }
  }

  enqueue(path: string, packet: DecodedPacket) {
    if (!this.#context) return;
    const context = this.#context;
    const { channels, sampleRate, frameCount } = packet;
    const buffer = context.createBuffer(channels.length, frameCount, sampleRate);

    for (let channel = 0; channel < channels.length; channel += 1) {
      buffer.copyToChannel(channels[channel], channel);
    }

    const remote = this.#remotes.get(path) ?? this.#createRemote(path);
    const now = context.currentTime;

    if (remote.nextTime < now) {
      remote.stats.underruns += 1;
      remote.lastUnderrunAt = now;
      remote.targetLead = Math.min(MAX_LEAD_SECONDS, remote.targetLead + LEAD_STEP_UP);
      remote.lastAdjustmentAt = now;
      remote.nextTime = now + remote.targetLead;
    }

    const startAt = Math.max(remote.nextTime, now + remote.targetLead);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(remote.gain);
    source.start(startAt);

    remote.nextTime = startAt + buffer.duration;
    remote.stats.framesDecoded += frameCount;
    remote.stats.bufferedAhead = Math.max(0, remote.nextTime - context.currentTime);
    remote.stats.targetLead = remote.targetLead;

    if (
      remote.targetLead > MIN_LEAD_SECONDS &&
      remote.stats.underruns > 0 &&
      now - remote.lastUnderrunAt > STABLE_SECONDS &&
      now - remote.lastAdjustmentAt > SHRINK_COOLDOWN_SECONDS &&
      remote.stats.bufferedAhead > remote.targetLead + 0.05
    ) {
      remote.targetLead = Math.max(MIN_LEAD_SECONDS, remote.targetLead - LEAD_STEP_DOWN);
      remote.lastAdjustmentAt = now;
      remote.stats.targetLead = remote.targetLead;
      if (remote.nextTime < now + remote.targetLead) {
        remote.nextTime = now + remote.targetLead;
      }
    }
  }

  setVolume(path: string, value: number) {
    const remote = this.#remotes.get(path);
    if (!remote) return;
    remote.gain.gain.value = value;
  }

  getVolume(path: string): number | undefined {
    return this.#remotes.get(path)?.gain.gain.value;
  }

  getVolumes(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const [key, remote] of this.#remotes) {
      snapshot[key] = remote.gain.gain.value;
    }
    return snapshot;
  }

  getStats(path: string): PlaybackStats | undefined {
    const remote = this.#remotes.get(path);
    if (!remote) return undefined;
    return { ...remote.stats };
  }

  getAllStats(): Record<string, PlaybackStats> {
    const snapshot: Record<string, PlaybackStats> = {};
    for (const [key, remote] of this.#remotes) {
      snapshot[key] = { ...remote.stats };
    }
    return snapshot;
  }

  close(path: string) {
    const remote = this.#remotes.get(path);
    if (!remote) return;
    remote.gain.disconnect();
    this.#remotes.delete(path);
  }

  shutdown() {
    for (const key of this.#remotes.keys()) {
      this.close(key);
    }
    this.#context?.close().catch(() => {});
    this.#context = undefined;
  }

  #createRemote(path: string): RemoteState {
    if (!this.#context) {
      throw new Error("audio context not initialized");
    }
    const gain = this.#context.createGain();
    gain.gain.value = 1;
    gain.connect(this.#context.destination);

    const now = this.#context.currentTime;
    const state: RemoteState = {
      gain,
      nextTime: now + MIN_LEAD_SECONDS,
      stats: {
        framesDecoded: 0,
        bufferedAhead: 0,
        underruns: 0,
        targetLead: MIN_LEAD_SECONDS,
      },
      targetLead: MIN_LEAD_SECONDS,
      lastUnderrunAt: -Infinity,
      lastAdjustmentAt: now,
    };
    this.#remotes.set(path, state);
    return state;
  }
}
