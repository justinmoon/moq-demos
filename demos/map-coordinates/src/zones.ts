export interface Zone {
  id: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
}

export const ZONES: Zone[] = [
  {
    id: "forge",
    name: "Forge",
    rect: { x: 32, y: 48, width: 256, height: 256 },
  },
  {
    id: "library",
    name: "Library",
    rect: { x: 352, y: 48, width: 256, height: 256 },
  },
];

export function zonesForPoint(x: number, y: number): string[] {
  return ZONES.filter((zone) => contains(zone.rect, x, y)).map((zone) => zone.id);
}

function contains(rect: Zone["rect"], x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
