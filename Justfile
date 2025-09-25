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

# Forward to a specific demo's Justfile, optionally overriding the relay URL.
demo name url='http://localhost:4443/anon':
    just --justfile {{demo_dir}}/{{name}}/Justfile demo {{url}}

# Install dependencies for a specific demo (defaults to map-coordinates).
install name='map-coordinates':
    just --justfile {{demo_dir}}/{{name}}/Justfile install

# Convenience alias for the map coordinates demo.
map-coordinates url='http://localhost:4443/anon':
    just demo map-coordinates {{url}}

# Install everything defined under demos/*/Justfile.
install-all:
	@set -euo pipefail; \
	for demo in $(ls {{demo_dir}} 2>/dev/null); do \
		if [ -f "{{demo_dir}}/$demo/Justfile" ]; then \
			just install "$demo"; \
		fi; \
	done

prod_host := 'moq.justinmoon.com'
prod_ip := '135.181.179.143'

# Fetch the relay's TLS fingerprint via Caddy to verify the production instance is alive.
# Pass ip='dns' to rely on your local DNS instead of --resolve.
test-prod ip=prod_ip host=prod_host:
	set -euo pipefail; \
	fingerprint=$(if [ "{{ip}}" = "dns" ]; then \
		curl --silent --show-error --fail "https://{{host}}/certificate.sha256"; \
	else \
		curl --silent --show-error --fail --resolve "{{host}}:443:{{ip}}" "https://{{host}}/certificate.sha256"; \
	fi); \
	if [ -z "$fingerprint" ]; then \
		echo "relay responded but no fingerprint returned" >&2; \
		exit 1; \
	fi; \
	printf "certificate.sha256: %s\n" "$fingerprint"; \
	printf "✓ %s responded with certificate fingerprint\n" "{{host}}"
