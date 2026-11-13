const hash = (n: number, seed: number) => {
  const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Smooth 1D value noise, output in 0..1. Deterministic per seed. */
export function valueNoise1D(seed: number): (x: number) => number {
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const t = f * f * (3 - 2 * f);
    const a = hash(i, seed);
    const b = hash(i + 1, seed);
    return a + (b - a) * t;
  };
}
