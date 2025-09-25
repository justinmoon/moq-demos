import type { Player } from "./types";
import { playerLabel } from "./players";
import { shortenNpub } from "./nostr";

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

  if ((player.speakingLevel ?? 0) > 0.05) {
    const intensity = Math.min(player.speakingLevel ?? 0, 1);
    const glowRadius = 14 + intensity * 6;
    ctx.save();
    ctx.strokeStyle = `rgba(52, 211, 153, ${0.3 + intensity * 0.5})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(player.x, player.y - radius - 12, glowRadius / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
