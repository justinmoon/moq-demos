#!/usr/bin/env just --justfile

set quiet

demo_dir := 'demos'

# Show all available commands
default:
	just --list

# Run the MoQ relay from the sibling moq repo.
relay:
	cd ../moq && just relay

# Print the demos that have their own Justfile.
gallery:
	@printf "available demos:\n"
	@for demo in $(ls {{demo_dir}} 2>/dev/null); do \
		if [ -f "{{demo_dir}}/$demo/Justfile" ]; then \
			printf " - %s\n" "$demo"; \
		fi; \
	done

# Forward to a specific demo's Justfile.
demo name:
    just --justfile {{demo_dir}}/{{name}}/Justfile demo

# Install dependencies for a specific demo (defaults to map-coordinates).
install name='map-coordinates':
    just --justfile {{demo_dir}}/{{name}}/Justfile install

# Convenience alias for the map coordinates demo.
map-coordinates:
    just demo map-coordinates

# Install everything defined under demos/*/Justfile.
install-all:
	@set -euo pipefail; \
	for demo in $(ls {{demo_dir}} 2>/dev/null); do \
		if [ -f "{{demo_dir}}/$demo/Justfile" ]; then \
			just install "$demo"; \
		fi; \
	done
