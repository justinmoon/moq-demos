import { clamp } from "../utils";

export interface CaptureCallbacks {
  onSamples(channels: Float32Array[], sampleRate: number): void;
  onLevel(level: number): void;
}

export interface CaptureConfig {
  syntheticTone?: boolean;
  monitor?: boolean;
}

const BUFFER_SIZE = 2048;

export class AudioCapture {
  #context?: AudioContext;
  #processor?: ScriptProcessorNode;
  #stream?: MediaStream;
  #tonePhase = 0;
  #callbacks: CaptureCallbacks;
  #config: CaptureConfig;

  constructor(callbacks: CaptureCallbacks, config?: CaptureConfig) {
    this.#callbacks = callbacks;
    this.#config = config ?? {};
  }

  async start(): Promise<void> {
    if (this.#context) return;

    this.#context = new AudioContext({ sampleRate: 48000 });
    await this.#context.resume();

    this.#processor = this.#context.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.#processor.onaudioprocess = (event) => {
      if (!this.#context) return;
      if (this.#config.syntheticTone) {
        const output = event.outputBuffer.getChannelData(0);
        const freq = 440;
        const step = (2 * Math.PI * freq) / this.#context.sampleRate;
        for (let i = 0; i < output.length; i += 1) {
          output[i] = Math.sin(this.#tonePhase);
          this.#tonePhase += step;
        }
        const copy = new Float32Array(output);
        this.#callbacks.onSamples([copy], this.#context.sampleRate);
        this.#callbacks.onLevel(computeRms([copy]));
      } else {
        const input = event.inputBuffer;
        if (input.numberOfChannels === 0) return;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < input.numberOfChannels; ch += 1) {
          const data = new Float32Array(input.length);
          data.set(input.getChannelData(ch));
          channels.push(data);
        }
        this.#callbacks.onSamples(channels, input.sampleRate);
        this.#callbacks.onLevel(computeRms(channels));
        if (!this.#config.monitor) {
          for (let ch = 0; ch < event.outputBuffer.numberOfChannels; ch += 1) {
            event.outputBuffer.getChannelData(ch).fill(0);
          }
        }
      }
    };

    if (this.#config.syntheticTone) {
      this.#processor.connect(this.#context.destination);
    } else {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const source = this.#context.createMediaStreamSource(this.#stream);
      source.connect(this.#processor);
      if (this.#config.monitor) {
        this.#processor.connect(this.#context.destination);
      } else {
        const gain = this.#context.createGain();
        gain.gain.value = 0.0001;
        this.#processor.connect(gain);
        gain.connect(this.#context.destination);
      }
    }
  }

  async stop(): Promise<void> {
    this.#processor?.disconnect();
    this.#processor = undefined;
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = undefined;
    if (this.#context) {
      await this.#context.close();
      this.#context = undefined;
    }
  }
}

function computeRms(channels: Float32Array[]): number {
  let total = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i];
      total += sample * sample;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = total / count;
  return clamp(Math.sqrt(mean), 0, 1);
}
