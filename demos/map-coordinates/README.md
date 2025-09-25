# Map Coordinates · Shared Arena

A lightweight multiplayer sketch that uses the local MoQ relay to fan out player locations. Open multiple browser tabs to see avatars move across the same grid.

## Controls & Flow

- The page auto-connects to the local MoQ relay and then waits for a Nostr login.
- Use a NIP-07 signer (Alby, Damus, etc.) and click **Login with Nostr** to join the arena.
- Move with WASD or arrow keys once logged in.
- Adjust the relay endpoint by setting `VITE_RELAY_URL` (defaults to `http://localhost:4443/anon`). For the hosted relay use `https://moq.justinmoon.com/anon`.
- After login the **Voice** box unlocks—toggle *Enable Microphone* to stream live audio or *Play Test Tone* to publish a synthetic signal for solo testing. Use headphones if you enable local monitoring.
- Two voice “rooms” are marked on the floor. You can only hear players standing inside the same highlighted rectangle.

## Recipes

```bash
# Install dependencies
just -f demo/demos/map-coordinates/Justfile install

# Launch the dev server (same as `just -f demo/Justfile map-coordinates`)
just -f demo/demos/map-coordinates/Justfile demo

# Launch against the hosted relay
just -f demo/Justfile map-coordinates-prod

# Build a production bundle
just -f demo/demos/map-coordinates/Justfile build

# Run the end-to-end WebTransport test (installs browsers on first run)
npx playwright test --reporter=line
```

By default the dev server runs on http://localhost:5175 and will watch the neighboring `moq` source because Vite aliases those TypeScript files directly. Any changes in `moq/js/moq` or `moq/js/signals` will hot-reload into the demo, which keeps experiments close to the in-repo code.

### Solo audio testing tips

- Open the demo in two different browser profiles (or browsers) so you can hear the room mix without echo cancellation getting in the way.
- Alternatively, start the **Test Tone** publisher in one tab and listen from another profile/device; the tone keeps flowing even without a microphone.
- The green ring above avatars indicates the speaking level broadcast over MoQ. It should pulse both locally and remotely when audio frames are being published.
- Walk a player into a different room—audio should fade to silence once the zone labels no longer match.
