/**
 * Live audio levels, 0..1, written every animation frame by the voice client and read by
 * the 3D face and the composer beam. A plain mutable object on purpose: React state would
 * re-render 60 times a second.
 */
export const voiceLevels = {
  /** The user's microphone. */
  mic: 0,
  /** The twin's voice (remote audio track). */
  agent: 0,
  /** [low, mid, high] bands of the same signals, for richer visuals. */
  micBands: [0, 0, 0] as [number, number, number],
  agentBands: [0, 0, 0] as [number, number, number],
};
