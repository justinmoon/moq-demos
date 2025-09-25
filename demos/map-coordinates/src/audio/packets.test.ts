import { describe, expect, test } from "vitest";
import { decodePacket, encodePacket } from "./packets";

function generateSine(length: number, phase = 0): Float32Array {
  const data = new Float32Array(length);
  const step = (Math.PI * 2) / length;
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.sin(phase + step * i);
  }
  return data;
}

describe("audio packets", () => {
  test("encodes and decodes multi-channel PCM", () => {
    const left = generateSine(512);
    const right = generateSine(512, Math.PI / 2);
    const encoded = encodePacket([left, right], 48000);
    expect(encoded).toBeTruthy();
    const decoded = decodePacket(encoded!.buffer);
    expect(decoded).toBeTruthy();
    expect(decoded!.sampleRate).toBe(48000);
    expect(decoded!.channels).toHaveLength(2);
    expect(decoded!.frameCount).toBe(512);
    for (let i = 0; i < decoded!.channels.length; i += 1) {
      const original = i === 0 ? left : right;
      const roundTrip = decoded!.channels[i];
      expect(Array.from(roundTrip)).toStrictEqual(Array.from(original));
    }
  });

  test("returns undefined for malformed buffers", () => {
    expect(decodePacket(new Uint8Array())).toBeUndefined();
    const invalid = new Uint8Array(8);
    expect(decodePacket(invalid)).toBeUndefined();
  });
});
