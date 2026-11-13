import type { BjorkTone } from "./palette";

/** Resolve the colour tone: the prop wins, otherwise the dark tone. */
export function useBjorkTone(tone?: BjorkTone): BjorkTone {
  return tone ?? "dark";
}
