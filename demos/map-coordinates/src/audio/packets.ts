const VERSION = 1;
const HEADER_BYTES = 1 + 1 + 4 + 4;

export interface EncodedPacket {
  buffer: Uint8Array;
  frameCount: number;
}

export interface DecodedPacket {
  channels: Float32Array[];
  sampleRate: number;
  frameCount: number;
}

export function encodePacket(channels: Float32Array[], sampleRate: number): EncodedPacket | undefined {
  if (channels.length === 0) return undefined;
  const frameCount = channels[0].length;
  const channelCount = channels.length;
  const capacity = HEADER_BYTES + frameCount * channelCount * 4;
  const arrayBuffer = new ArrayBuffer(capacity);
  const view = new DataView(arrayBuffer);

  view.setUint8(0, VERSION);
  view.setUint8(1, channelCount);
  view.setUint32(2, sampleRate, true);
  view.setUint32(6, frameCount, true);

  const data = new Float32Array(arrayBuffer, HEADER_BYTES, frameCount * channelCount);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const source = channels[channel];
    if (source.length !== frameCount) return undefined;
    data.set(source, channel * frameCount);
  }

  return {
    buffer: new Uint8Array(arrayBuffer),
    frameCount,
  };
}

export function decodePacket(payload: Uint8Array): DecodedPacket | undefined {
  if (payload.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint8(0);
  if (version !== VERSION) return undefined;

  const channelCount = view.getUint8(1);
  const sampleRate = view.getUint32(2, true);
  const frameCount = view.getUint32(6, true);

  const expected = HEADER_BYTES + channelCount * frameCount * 4;
  if (payload.byteLength !== expected) return undefined;

  const data = new Float32Array(payload.buffer, payload.byteOffset + HEADER_BYTES, channelCount * frameCount);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    const start = channel * frameCount;
    const slice = data.slice(start, start + frameCount);
    channels.push(slice);
  }

  return { channels, sampleRate, frameCount };
}
