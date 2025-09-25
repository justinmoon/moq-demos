import type { DecodedPacket } from "./packets";

const LEAD_SECONDS = 0.35;

export interface PlaybackStats {
  framesDecoded: number;
  bufferedAhead: number;
  underruns: number;
}

interface RemoteState {
  gain: GainNode;
  nextTime: number;
  stats: PlaybackStats;
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
    if (remote.nextTime < context.currentTime) {
      remote.stats.underruns += 1;
      remote.nextTime = context.currentTime;
    }

    const startAt = Math.max(remote.nextTime, context.currentTime + LEAD_SECONDS);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(remote.gain);
    source.start(startAt);

    remote.nextTime = startAt + buffer.duration;
    remote.stats.framesDecoded += frameCount;
    remote.stats.bufferedAhead = Math.max(0, remote.nextTime - context.currentTime);
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

    const state: RemoteState = {
      gain,
      nextTime: this.#context.currentTime + LEAD_SECONDS,
      stats: {
        framesDecoded: 0,
        bufferedAhead: 0,
        underruns: 0,
      },
    };
    this.#remotes.set(path, state);
    return state;
  }
}
