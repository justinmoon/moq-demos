export function randomColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}deg 85% 60%)`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}
