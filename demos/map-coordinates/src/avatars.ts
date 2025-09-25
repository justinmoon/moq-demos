import type { Player } from "./types";

const avatarCache = new Map<string, Promise<HTMLImageElement | undefined>>();

export function queueAvatarLoad(player: Player, url?: string) {
  if (!url || url === player.imageUrl) return;
  player.imageUrl = url;

  let pending = avatarCache.get(url);
  if (!pending) {
    pending = loadAvatar(url);
    avatarCache.set(url, pending);
  }

  pending
    .then((image) => {
      if (player.imageUrl !== url) return;
      player.image = image;
    })
    .catch(() => {
      if (player.imageUrl === url) {
        player.image = undefined;
      }
    });
}

function loadAvatar(url: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = url;
  });
}
