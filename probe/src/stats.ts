export interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function stats(xs: number[]): Stats {
  if (xs.length === 0) return { n: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: s.length,
    mean: r(s.reduce((a, b) => a + b, 0) / s.length),
    p50: r(q(0.5)),
    p95: r(q(0.95)),
    p99: r(q(0.99)),
    max: r(s[s.length - 1]),
  };
}

export const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
