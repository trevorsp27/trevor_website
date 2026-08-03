// Board generation. Everything here is a pure function of the seed, so all
// players build a byte-identical board from a four-character lobby code.

import { Rng } from "./rng.js?v=20260803b";
import {
  SIZE,
  CELLS,
  N,
  E,
  S,
  W,
  DIRS,
  OPPOSITE_BIT,
  COLORS,
  SHAPES,
  WILD,
  idx,
  xOf,
  yOf,
  inBounds,
  centerCells
} from "./constants.js?v=20260803b";

// Target squares always carry their own walls, so the count is fixed. Only the
// decorative walls scale with difficulty: more walls means more surfaces to
// stop against, which makes controlling a robot easier.
const TARGET_COUNT = 17;
const EXTRA_WALLS = { easy: 18, medium: 10, hard: 3 };
const DIAGONAL_COUNT = { easy: 6, medium: 9, hard: 12 };

const LOBBY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

export function makeLobbyCode(random = Math.random) {
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += LOBBY_ALPHABET[Math.floor(random() * LOBBY_ALPHABET.length)];
  }
  return out;
}

function countBits(mask) {
  let n = 0;
  let m = mask;
  while (m) {
    n += m & 1;
    m >>= 1;
  }
  return n;
}

// Walls live on edges, but we store them per cell. Writing both sides keeps the
// two representations in sync so movement never needs a neighbour lookup.
function addWall(board, x, y, bit) {
  if (!inBounds(x, y)) return;
  const cell = idx(x, y);
  board.walls[cell] |= bit;

  const step = DIRS.find((d) => d.bit === bit);
  const nx = x + step.dx;
  const ny = y + step.dy;
  if (inBounds(nx, ny)) {
    board.walls[idx(nx, ny)] |= OPPOSITE_BIT[bit];
  }
}

// Never fully seal a cell -- a robot parked there could never leave.
function wouldSeal(board, x, y, bit) {
  const cell = idx(x, y);
  if (countBits(board.walls[cell] | bit) >= 4) return true;

  const step = DIRS.find((d) => d.bit === bit);
  const nx = x + step.dx;
  const ny = y + step.dy;
  if (inBounds(nx, ny)) {
    const neighbour = idx(nx, ny);
    if (countBits(board.walls[neighbour] | OPPOSITE_BIT[bit]) >= 4) return true;
  }
  return false;
}

// An L-shaped pair of walls, the same arrangement the physical board uses.
// One vertical, one horizontal, so a robot can be stopped from two directions.
function addCorner(board, rng, x, y) {
  const vertical = rng.chance(0.5) ? N : S;
  const horizontal = rng.chance(0.5) ? E : W;

  if (!wouldSeal(board, x, y, vertical)) addWall(board, x, y, vertical);
  if (!wouldSeal(board, x, y, horizontal)) addWall(board, x, y, horizontal);
}

// Wall stubs sticking inward from the outer ring. Without these a robot
// travelling along an edge row runs the full width of the board every time,
// which makes the borders useless. The physical board has a couple per side.
function addPerimeterWalls(board, rng) {
  const perSide = 2;

  // Each side gets walls *perpendicular* to it, so they stop robots sliding
  // along that edge. Corners are excluded: a wall there does nothing.
  const sides = [
    { fixed: 0, axis: "row", bits: [E, W] },
    { fixed: SIZE - 1, axis: "row", bits: [E, W] },
    { fixed: 0, axis: "col", bits: [N, S] },
    { fixed: SIZE - 1, axis: "col", bits: [N, S] }
  ];

  sides.forEach((side) => {
    const used = [];
    for (let i = 0; i < perSide; i += 1) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const along = rng.range(2, SIZE - 3);
        if (used.some((prev) => Math.abs(prev - along) < 3)) continue;

        const x = side.axis === "row" ? along : side.fixed;
        const y = side.axis === "row" ? side.fixed : along;
        const bit = rng.pick(side.bits);

        if (wouldSeal(board, x, y, bit)) continue;
        addWall(board, x, y, bit);
        used.push(along);
        break;
      }
    }
  });
}

function isCenter(board, cell) {
  return board.blocked[cell] === 1;
}

// Keeps features spread out instead of clumping in one corner.
function farFrom(cells, cell, minDistance) {
  const x = xOf(cell);
  const y = yOf(cell);
  return cells.every((other) => {
    const dx = Math.abs(xOf(other) - x);
    const dy = Math.abs(yOf(other) - y);
    return Math.max(dx, dy) >= minDistance;
  });
}

export function generateBoard({ code, difficulty = "medium", useDiagonals = false }) {
  const rng = new Rng(`${code}|${difficulty}|${useDiagonals ? "diag" : "plain"}`);

  const board = {
    code,
    difficulty,
    useDiagonals,
    size: SIZE,
    walls: new Uint8Array(CELLS),
    blocked: new Uint8Array(CELLS),
    diagonals: new Array(CELLS).fill(null),
    targets: []
  };

  // Outer border.
  for (let i = 0; i < SIZE; i += 1) {
    board.walls[idx(i, 0)] |= N;
    board.walls[idx(i, SIZE - 1)] |= S;
    board.walls[idx(0, i)] |= W;
    board.walls[idx(SIZE - 1, i)] |= E;
  }

  // The central hub: impassable, and walled off so robots stop cleanly against it.
  const center = centerCells();
  center.forEach((cell) => {
    board.blocked[cell] = 1;
  });
  center.forEach((cell) => {
    const x = xOf(cell);
    const y = yOf(cell);
    DIRS.forEach((step) => {
      const nx = x + step.dx;
      const ny = y + step.dy;
      if (inBounds(nx, ny) && !board.blocked[idx(nx, ny)]) {
        addWall(board, x, y, step.bit);
      }
    });
  });

  addPerimeterWalls(board, rng);

  // Target squares, each with its own corner walls.
  const palette = [];
  COLORS.forEach((color) => {
    SHAPES.forEach((shape) => palette.push({ color, shape }));
  });
  palette.push({ color: WILD, shape: "star" });
  palette.push({ color: WILD, shape: "star" });

  const chosen = rng.shuffle(palette).slice(0, TARGET_COUNT);
  const used = [];

  chosen.forEach((entry) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const x = rng.range(1, SIZE - 2);
      const y = rng.range(1, SIZE - 2);
      const cell = idx(x, y);

      if (isCenter(board, cell)) continue;
      if (!farFrom(used, cell, 2)) continue;

      addCorner(board, rng, x, y);
      board.targets.push({ cell, color: entry.color, shape: entry.shape });
      used.push(cell);
      return;
    }
  });

  // Decorative walls. This is the difficulty knob.
  const extras = EXTRA_WALLS[difficulty] ?? EXTRA_WALLS.medium;
  const wallCells = used.slice();
  for (let i = 0; i < extras; i += 1) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const x = rng.range(1, SIZE - 2);
      const y = rng.range(1, SIZE - 2);
      const cell = idx(x, y);

      if (isCenter(board, cell)) continue;
      if (!farFrom(wallCells, cell, 2)) continue;

      addCorner(board, rng, x, y);
      wallCells.push(cell);
      break;
    }
  }

  // Diagonals go on otherwise-empty cells so they read clearly and don't fight
  // with a wall for the same square.
  if (useDiagonals) {
    const count = DIAGONAL_COUNT[difficulty] ?? DIAGONAL_COUNT.medium;
    const placed = [];
    for (let i = 0; i < count; i += 1) {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const x = rng.range(1, SIZE - 2);
        const y = rng.range(1, SIZE - 2);
        const cell = idx(x, y);

        if (isCenter(board, cell)) continue;
        if (board.walls[cell] !== 0) continue;
        if (board.targets.some((t) => t.cell === cell)) continue;
        if (!farFrom(placed, cell, 3)) continue;

        board.diagonals[cell] = {
          kind: rng.chance(0.5) ? "/" : "\\",
          color: rng.pick(COLORS)
        };
        placed.push(cell);
        break;
      }
    }
  }

  return board;
}

// Round setup: scatter the robots. Kept separate from board generation because
// walls persist for the whole game while robots re-roll every round.
export function randomRobotPositions(rng, board, avoidCell = -1) {
  const positions = [];
  while (positions.length < COLORS.length) {
    const cell = rng.int(CELLS);
    if (board.blocked[cell]) continue;
    if (cell === avoidCell) continue;
    if (positions.includes(cell)) continue;
    positions.push(cell);
  }
  return positions;
}
