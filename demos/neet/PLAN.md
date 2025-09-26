# NEET MoQ CLI – Iterative Plan (V2)

## Guiding Principle
Deliver working audio over MoQ in small, verifiable steps. Start with a minimal CLI that two users can operate manually (shared session id + relay URL). Layer Nostr signalling, key storage, and nicer UX only after the transport and audio path are proven.

## Stage 0 – Workspace & Plumbing
- Scaffold the `neet-cli` crate (done) and copy the legacy audio/codec modules needed for capture, playback, and Opus encode/decode (in progress).
- Declare workspace/path dependencies on:
  - `moq-lite` + `moq-native` (from `../../moq/rs`)
  - `hang` if we re-use helpers from there
  - `nostr-sdk` (not used until later stages but keep note)
  - audio stack crates (`cpal`, `fixed-resample`, `opus`, etc.)
- Set up feature flags so we can compile without WebRTC audio processing if platform support is flaky.

## Stage 1 – Minimal MoQ Audio Call (no Nostr)
Goal: two users run `neet listen --session <id>` and `neet call --session <id>` with a shared session identifier and default relay `https://moq.justinmoon.com/anon`.

1. **CLI Skeleton**
   - Commands: `listen`, `call`, `loopback`.
   - Global flags: `--session <string>`, `--relay <url>`, `--tone`, `--file`, `--input-device`, `--output-device`, `--disable-processing`.
   - Separate module for argument parsing + logging setup.

2. **MoQ Session Layer** (`src/moq.rs`)
   - Wrap `moq-native::Client` connection to a relay path `/<anon-root>/<session>/<role>`.
   - Define broadcasts:
     * Listener publishes `audio/<listener_id>` and subscribes to caller track.
     * Caller publishes `audio/<caller_id>` and subscribes to listener track.
   - Manage `moq-lite::BroadcastProducer/Consumer` lifetimes and spawn background tasks to push/pull audio frames.
   - Provide an in-process loopback variant that bypasses the relay for local testing.

3. **Audio Integration** (`src/audio/mod.rs` facade)
   - Expose `AudioContext` builder that returns capture + playback handles.
   - Support microphone source (default), `--tone`, and `--file` inputs.
   - Wire Opus encoder/decoder to ringbuffers that the MoQ layer reads/writes.

4. **Session Orchestration** (`src/call.rs`)
   - Listen flow: build audio context → start MoQ session as receiver → pump PCM to speakers.
   - Call flow: build audio context → start MoQ session as caller → pump mic/tone/file into session.
   - Graceful shutdown on Ctrl+C or remote disconnect.

5. **Loopback Command**
   - `neet loopback [--tone|--file]` spins both publisher/subscriber locally so we can evaluate the audio pipeline without network.

6. **Validation**
   - Manual testing recipe documented in README (`loopback`, then two terminals sharing `--session demo1`).
   - Add integration test that exercises loopback + tone to confirm encode/decode path (no network).

## Stage 2 – Quality & UX Enhancements
(Work on after Stage 1 is stable.)
- Device enumeration command (`list-devices`).
- Optional VU meter / logging improvements.
- Handle jitter/backpressure (adjust ring buffer sizes, CPU priority hints).
- Add logging + metrics for frame skip/loss.

## Stage 3 – Nostr Signalling & Identity
- Re-introduce `init`, `publish`, `listen`, `call <npub>` commands using `nostr-sdk`.
- Key storage and password handling (reuse legacy `key_storage.rs`).
- DM-based offer/answer exchange with JSON schema and timeouts.
- Metadata publishing of MoQ relay + session hints.
- Auto-generate session IDs per call.

## Stage 4 – End-to-End Tests Against `moq.justinmoon.com`
- Build ignored integration test requiring:
  - `NEET_CALLER_NSEC`, `NEET_LISTENER_NSEC`, `NEET_RELAY_URL` env vars
  - Live Nostr relays + production MoQ relay.
- Test flow: start listener (auto-accept) → caller sends tone for a few seconds → ensure PCM received.

## Current Focus
- Finish Stage 0 copying/trimming audio/codec modules so the project compiles.
- Implement Stage 1 MoQ session + CLI.
- Verify loopback and basic relay call manually before expanding scope.

## Risks / Watchlist
- Audio stack portability: keep `--disable-processing` defaulted off until tested.
- MoQ path conventions: ensure both roles derive identical topic names from the shared `--session` string.
- Timeboxing: if Stage 1 MoQ integration stalls, fall back to loopback-only MVP before layering network.

## Next Actions
1. Finalize Cargo dependencies + module layout so the old audio code compiles in the new crate.
2. Implement the MoQ session wrapper with hard-coded publish/subscribe paths derived from `--session`.
3. Wire CLI commands to the session layer and audio context.
4. Add loopback command + integration test.
5. Smoke test with tone → speakers via relay.
