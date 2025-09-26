# neet-cli (MoQ prototype)

Experimental CLI that streams bidirectional Opus audio over [Media over QUIC](https://moq.dev).
The current MVP skips Nostr signalling — callers coordinate by sharing a session identifier and
connecting to the same relay URL.

## Build & Run

```bash
# build
cargo build

# listen for a caller (press Ctrl+C to hang up)
cargo run -- listen --session demo123

# place a call to the listener
cargo run -- call --session demo123
```

Both sides default to the hosted relay at `https://moq.justinmoon.com/anon`. Use `--relay <url>`
to point at a different deployment.

### Audio options

- `--input-device <name>` / `--output-device <name>` select specific CPAL devices.
- `--disable-processing` turns off WebRTC echo cancellation/noise suppression (use headphones).
- `list-devices` prints the available device names.

### Loopback check

Verify the capture/playback pipeline locally (no network):

```bash
cargo run -- loopback
```

You should hear your microphone fed straight to your speakers/headphones. Press Ctrl+C to exit.

## Manual End-to-End Checklist

1. **Loopback sanity**: run `cargo run -- loopback` and confirm audio feedback works.
2. **Listen/Call flow**:
   - Terminal A: `cargo run -- listen --session stage1-demo`
   - Terminal B: `cargo run -- call --session stage1-demo`
   - Speak into the mic on either terminal; the other side should hear audio with ~1–2s latency.
3. **Relay override (optional)**: use `--relay http://localhost:4443/anon` when testing against a
   local MoQ relay.

If audio is choppy, try `--disable-processing` on both sides or specify explicit `--input-device`
and `--output-device` values.

## Tests

- `cargo test moq::tests::forward_roundtrip_delivers_payload` ensures the MoQ bridging layer
  faithfully transports frames between the internal media channels and MoQ tracks.
- `cargo test` exercises lightweight helpers (URL/path handling and frame bridging). No hardware is
  required.

Future iterations will add automated end-to-end tests using real relays once signalling is wired
back in.
