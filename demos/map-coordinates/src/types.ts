export interface ProfilePayload {
  npub: string;
  pubkey: string;
  displayName?: string;
  name?: string;
  picture?: string;
  about?: string;
  relays?: string[];
  updatedAt?: number;
}

export interface PositionMessage {
  npub: string;
  tab: string;
  x: number;
  y: number;
  color?: string;
}

export interface Player {
  key: string;
  npub?: string;
  x: number;
  y: number;
  color: string;
  lastSeen: number;
  isLocal: boolean;
  profile?: ProfilePayload;
  image?: HTMLImageElement;
  imageUrl?: string;
  speakingLevel?: number;
}
