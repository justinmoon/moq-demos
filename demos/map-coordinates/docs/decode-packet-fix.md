# Fixing Misaligned Audio Payloads in `decodePacket`

When we first started attaching real WebTransport clients to the MoQ relay, every
subscriber would occasionally explode with:

```
RangeError: start offset of Float32Array should be a multiple of 4
```

The failure looked benign—positions still flowed—but the relay reset every audio
track that hit that exception, which meant remote players never stayed
subscribed long enough to render a continuous stream. In practice you would hear
short "morse-code" blips whenever the publisher started a tone or microphone,
and the connection logs were littered with `RESET_STREAM` warnings.

## Why it happens

Our audio packets are framed as a `Uint8Array`: a 16-byte header followed by raw
32-bit PCM samples. Inside the browser we reconstruct the channels with:

```ts
const data = new Float32Array(payload.buffer, payload.byteOffset + HEADER_BYTES, …);
```

That works **only if** `payload.byteOffset + HEADER_BYTES` is divisible by 4.
Most typed arrays you slice or subarray from JavaScript libraries are aligned,
but WebTransport delivers frames in buffers whose offsets can start on any byte
boundary. Every time we got an odd offset—`byteOffset % 4 === 1`, for example—
the above constructor threw the `RangeError`.

## The fix

Before constructing the `Float32Array`, detect whether the data pointer is
aligned. If it isn’t, duplicate the sample portion to a fresh buffer whose start
is guaranteed to sit on a 4-byte boundary:

```ts
const dataOffset = payload.byteOffset + HEADER_BYTES;
const needsCopy = dataOffset % 4 !== 0;
const source = needsCopy ? payload.slice(HEADER_BYTES) : payload;
const offset = needsCopy ? source.byteOffset : source.byteOffset + HEADER_BYTES;
const data = new Float32Array(source.buffer, offset, channelCount * frameCount);
```

This adds a copy only in the misaligned case, so the fast path remains zero-copy
when the transport hands us aligned buffers.

## Symptoms to watch for

If you still see the issue elsewhere, look for:

- Browser console warnings such as `audio subscription failed … RangeError …`
- Relay logs emitting `RESET_STREAM` right after an audio subscription starts.
- Audio that plays as short bursts instead of a continuous stream, even though
  positions feel flawless.

Applying the alignment guard eliminates the crash and keeps the WebTransport
stream alive, which in turn allows downstream buffering logic to work as
expected.
