# MoQ Demo Gallery

This folder hosts runnable demos that pair with the sibling `moq` repository. Use the `demo/Justfile` to spin up the relay and launch individual experiences.

## Quick start

```bash
# Terminal 1: run the relay
just -f demo/Justfile relay

# Terminal 2: start the map coordinates demo
just -f demo/Justfile map-coordinates
```

Run `just -f demo/Justfile gallery` to list every available demo or `just -f demo/Justfile demo <name>` to execute one directly. Each demo directory contains its own `README.md` with feature highlights and options.

## Adding more demos

Drop a new folder under `demo/demos/<your-demo>` with a `Justfile` that exposes at least `install` and `demo` recipes. The top-level helpers will detect it automatically, so `just -f demo/Justfile gallery` and `just -f demo/Justfile demo <your-demo>` begin working with no further wiring.
