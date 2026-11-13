export type BjorkTone = "dark" | "light";

export interface BjorkColors {
  accent: string;
  accentSoft: string;
  text: string;
  muted: string;
  surface: string;
  border: string;
}

export const BJORK_PALETTE: Record<BjorkTone, BjorkColors> = {
  dark: {
    accent: "#ec5c13",
    accentSoft: "#ff8a3d",
    text: "#f2ede4",
    muted: "rgba(242,237,228,0.62)",
    surface: "#1d1a16",
    border: "rgba(255,245,230,0.12)",
  },
  light: {
    accent: "#d4500d",
    accentSoft: "#ec5c13",
    text: "#1d1a16",
    muted: "rgba(29,26,22,0.62)",
    surface: "#f6f1e8",
    border: "rgba(29,26,22,0.14)",
  },
};
