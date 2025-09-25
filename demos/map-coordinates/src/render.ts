import type { Player } from "./types";
import { playerLabel } from "./players";
import { shortenNpub } from "./nostr";
import { ZONES } from "./zones";

export const SPEAKING_VISIBLE_THRESHOLD = 0.02;

export function shouldShowSpeaking(level?: number): boolean {
  return (level ?? 0) > SPEAKING_VISIBLE_THRESHOLD;
}

export function drawZones(ctx: CanvasRenderingContext2D, activeZoneIds: ReadonlyArray<string>) {
  for (const zone of ZONES) {
    const isActive = activeZoneIds.includes(zone.id);
    ctx.save();
    ctx.fillStyle = isActive ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.12)";
    ctx.strokeStyle = isActive ? "rgba(56, 189, 248, 0.6)" : "rgba(148, 163, 184, 0.3)";
    ctx.lineWidth = isActive ? 3 : 1;
    ctx.beginPath();
    ctx.rect(zone.rect.x, zone.rect.y, zone.rect.width, zone.rect.height);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPlayer(ctx: CanvasRenderingContext2D, player: Player) {
  const radius = player.isLocal ? 12 : 10;

  if (player.image) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(player.image, player.x - radius, player.y - radius, radius * 2, radius * 2);
    ctx.restore();
  } else {
    ctx.save();
    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.fillText(playerLabel(player, shortenNpub), player.x, player.y - radius - 6);
  ctx.restore();

  if (shouldShowSpeaking(player.speakingLevel)) {
    const intensity = Math.min(player.speakingLevel ?? 0, 1);
    const ringRadius = radius + 8 + intensity * 6;
    ctx.save();
    ctx.strokeStyle = `rgba(52, 211, 153, ${0.25 + intensity * 0.45})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(player.x, player.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
