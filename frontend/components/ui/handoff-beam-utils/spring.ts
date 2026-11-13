export interface SpringState {
  x: number;
  v: number;
}
export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

/** Semi-implicit Euler, sub-stepped so large dt values stay stable. Mutates and returns `state`. */
export function stepSpring(state: SpringState, target: number, cfg: SpringConfig, dt: number): SpringState {
  const total = Math.min(Math.max(dt, 0), 0.1);
  const steps = Math.max(1, Math.ceil(total / (1 / 120)));
  const h = total / steps;
  for (let i = 0; i < steps; i++) {
    const a = (-cfg.stiffness * (state.x - target) - cfg.damping * state.v) / cfg.mass;
    state.v += a * h;
    state.x += state.v * h;
  }
  return state;
}
