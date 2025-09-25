import type { DecodedPacket } from "./packets";

interface RemoteState {
  gain: GainNode;
  nextTime: number;
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
    const startAt = Math.max(remote.nextTime, context.currentTime + 0.05);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(remote.gain);
    source.start(startAt);

    remote.nextTime = startAt + buffer.duration;
  }

  setVolume(path: string, value: number) {
    const remote = this.#remotes.get(path);
    if (!remote) return;
    remote.gain.gain.value = value;
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
      nextTime: this.#context.currentTime + 0.05,
    };
    this.#remotes.set(path, state);
    return state;
  }
}
