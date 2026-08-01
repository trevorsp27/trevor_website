// Deterministic pseudo-random number generation.
//
// Every player generates the board locally from a shared seed, so the same seed
// must produce byte-identical output on every machine. Math.random() cannot do
// that, hence mulberry32: small, fast, and fully reproducible.

// FNV-1a. Turns a lobby code like "K4TQ" into a 32-bit seed.
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.next = mulberry32(typeof seed === "string" ? hashSeed(seed) : seed);
  }

  float() {
    return this.next();
  }

  // Integer in [0, n).
  int(n) {
    return Math.floor(this.next() * n);
  }

  // Integer in [lo, hi] inclusive.
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }

  pick(list) {
    return list[this.int(list.length)];
  }

  chance(p) {
    return this.next() < p;
  }

  // Fisher-Yates on a copy, so callers never have their input mutated.
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
}
