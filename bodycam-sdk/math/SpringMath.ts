/**
 * Unconditionally stable closed-form analytical damped harmonic oscillator solver.
 *
 * Solves: x'' + 2 * zeta * omega * x' + omega^2 * (x - target) = 0
 *
 * Unlike explicit or semi-implicit Euler integration (which diverges exponentially
 * whenever 2 * zeta * omega * dt >= 2.0, causing violent alternating-sign oscillation
 * during frame drops), the exact continuous solution is mathematically stable for
 * ANY positive dt (whether 240 FPS or 5 FPS) and introduces zero artificial energy.
 */
export function stepAnalyticalDampedSpring(
  val: number,
  vel: number,
  target: number,
  omega: number,
  dampingRatio: number,
  dt: number,
): [number, number] {
  if (!Number.isFinite(val) || !Number.isFinite(vel) || !Number.isFinite(target)) {
    return [Number.isFinite(target) ? target : 0, 0];
  }
  if (dt <= 0 || omega <= 0) {
    return [val, vel];
  }

  const zeta = Math.max(0, dampingRatio);
  const y0 = val - target;
  const v0 = vel;

  if (Math.abs(y0) < 1e-9 && Math.abs(v0) < 1e-9) {
    return [target, 0];
  }

  let y1: number;
  let v1: number;

  if (Math.abs(zeta - 1.0) < 1e-4) {
    // Critically damped (zeta == 1)
    const exp = Math.exp(-omega * dt);
    const c2 = v0 + omega * y0;
    y1 = (y0 + c2 * dt) * exp;
    v1 = (v0 - c2 * omega * dt) * exp;
  } else if (zeta < 1.0) {
    // Underdamped (0 <= zeta < 1)
    const omegaZeta = omega * zeta;
    const omegaD = omega * Math.sqrt(Math.max(1e-8, 1.0 - zeta * zeta));
    const exp = Math.exp(-omegaZeta * dt);
    const angle = omegaD * dt;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const b = (v0 + omegaZeta * y0) / omegaD;
    y1 = exp * (y0 * cosA + b * sinA);
    v1 = exp * ((b * omegaD - y0 * omegaZeta) * cosA - (y0 * omegaD + b * omegaZeta) * sinA);
  } else {
    // Overdamped (zeta > 1)
    const root = omega * Math.sqrt(zeta * zeta - 1.0);
    const r1 = -omega * zeta + root;
    const r2 = -omega * zeta - root;
    const invDiff = 1.0 / Math.max(1e-8, r1 - r2);
    const c1 = (v0 - r2 * y0) * invDiff;
    const c2 = y0 - c1;
    const e1 = Math.exp(r1 * dt);
    const e2 = Math.exp(r2 * dt);
    y1 = c1 * e1 + c2 * e2;
    v1 = c1 * r1 * e1 + c2 * r2 * e2;
  }

  if (!Number.isFinite(y1) || !Number.isFinite(v1)) {
    return [target, 0];
  }

  return [target + y1, v1];
}

/**
 * Clamps a spring's value to [min, max] and zeros outward velocity when pinned
 * against a boundary so energy cannot accumulate against hard limits.
 */
export function clampSpringState(
  val: number,
  vel: number,
  min: number,
  max: number,
): [number, number] {
  if (val > max) {
    return [max, vel > 0 ? 0 : vel];
  }
  if (val < min) {
    return [min, vel < 0 ? 0 : vel];
  }
  return [val, vel];
}
