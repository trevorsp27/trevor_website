// Shared board vocabulary. Kept in its own module so the pure game logic,
// the solver, and the renderer all agree without importing each other.

export const SIZE = 16;
export const CELLS = SIZE * SIZE;

// Wall bits, stored per cell as a 4-bit mask.
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

// Direction table. Index order matters: 0=up, 1=right, 2=down, 3=left.
// The deflection tables below are written against this order.
export const DIRS = [
  { bit: N, dx: 0, dy: -1, name: "up" },
  { bit: E, dx: 1, dy: 0, name: "right" },
  { bit: S, dx: 0, dy: 1, name: "down" },
  { bit: W, dx: -1, dy: 0, name: "left" }
];

export const OPPOSITE_BIT = { [N]: S, [E]: W, [S]: N, [W]: E };

// A "/" diagonal swaps vertical and horizontal in one sense, "\" in the other.
// Precomputed as lookup tables because this runs inside the solver's hot loop.
export const DEFLECT = {
  "/": [1, 0, 3, 2],
  "\\": [3, 2, 1, 0]
};

// Robot i always has COLORS[i]. Keeping this positional means a robot's colour
// never has to be sent over the wire.
export const COLORS = ["red", "blue", "green", "yellow", "silver"];
export const ROBOT_COUNT = COLORS.length;

export const SHAPES = ["circle", "square", "triangle"];

// Any robot may satisfy a wild target.
export const WILD = "wild";

export const DIFFICULTIES = ["easy", "medium", "hard"];

// How long the winning arrangement is celebrated before the reveal settles.
// Shared so the host's timing and the renderer's animation cannot drift apart.
export const CELEBRATE_MS = 2400;

export function idx(x, y) {
  return y * SIZE + x;
}

export function xOf(cell) {
  return cell % SIZE;
}

export function yOf(cell) {
  return Math.floor(cell / SIZE);
}

export function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE;
}

// The 2x2 hub in the middle that no robot may enter.
export function centerCells() {
  const a = SIZE / 2 - 1;
  const b = SIZE / 2;
  return [idx(a, a), idx(b, a), idx(a, b), idx(b, b)];
}
