import type * as Moq from "@kixelated/moq";
import type { ProfilePayload } from "./types";
import { gatherProfile, getNostrSigner, hasNostrSigner, shortenNpub } from "./nostr";

interface LoginOptions {
  button: HTMLButtonElement | null;
  warning: HTMLParagraphElement | null;
  getConnection: () => Moq.Connection.Established | undefined;
  onStatus: (message: string) => void;
  onSuccess: (profile: ProfilePayload) => Promise<void> | void;
}

export function setupLogin({ button, warning, getConnection, onStatus, onSuccess }: LoginOptions) {
  if (!button) return;

  if (!hasNostrSigner()) {
    button.disabled = true;
    button.textContent = "Nostr signer required";
    if (warning) warning.hidden = false;
    return;
  }

  button.disabled = false;
  button.addEventListener("click", async () => {
    const signer = getNostrSigner();
    if (!signer) {
      onStatus("Nostr signer unavailable.");
      return;
    }

    const connection = getConnection();
    if (!connection) return;

    button.disabled = true;
    button.textContent = "Signing…";

    try {
      const pubkey = await signer.getPublicKey();
      const profile = await gatherProfile(pubkey, signer);
      await onSuccess(profile);
      button.textContent = "Logged in";
      button.classList.add("success");
      onStatus(`Logged in as ${profile.displayName ?? profile.name ?? shortenNpub(profile.npub)}.`);
    } catch (error) {
      console.error("nostr login failed", error);
      button.disabled = false;
      button.textContent = "Login with Nostr";
      onStatus(`Login failed: ${(error as Error).message}`);
    }
  });
}
