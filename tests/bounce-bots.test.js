import test from "node:test";
import assert from "node:assert/strict";

import { Rng, hashSeed } from "../assets/js/bounce-bots/rng.js";
import { generateBoard, randomRobotPositions } from "../assets/js/bounce-bots/board.js";
import { slide, applyMove, replay, isSolved } from "../assets/js/bounce-bots/rules.js";
import { solve } from "../assets/js/bounce-bots/solver.js";
import {
  SIZE,
  CELLS,
  N,
  E,
  S,
  W,
  COLORS,
  idx,
  centerCells
} from "../assets/js/bounce-bots/constants.js";

// A blank arena. No border walls needed: slide() stops at the grid edge on its
// own, which keeps these tests focused on one rule at a time.
function emptyBoard() {
  return {
    walls: new Uint8Array(CELLS),
    blocked: new Uint8Array(CELLS),
    diagonals: new Array(CELLS).fill(null),
    targets: []
  };
}

// Robot 0 is the subject; the rest are parked in a corner well off the paths
// these tests exercise.
function positionsWithRedAt(cell) {
  return [cell, idx(1, 15), idx(2, 15), idx(3, 15), idx(4, 15)];
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

test("rng is deterministic for a given seed", () => {
  const a = new Rng("K4TQ");
  const b = new Rng("K4TQ");
  const seqA = Array.from({ length: 20 }, () => a.float());
  const seqB = Array.from({ length: 20 }, () => b.float());
  assert.deepEqual(seqA, seqB);
});

test("rng diverges for different seeds", () => {
  const a = new Rng("K4TQ");
  const b = new Rng("K4TR");
  const seqA = Array.from({ length: 20 }, () => a.float());
  const seqB = Array.from({ length: 20 }, () => b.float());
  assert.notDeepEqual(seqA, seqB);
});

test("hashSeed is stable and non-trivial", () => {
  assert.equal(hashSeed("ABCD"), hashSeed("ABCD"));
  assert.notEqual(hashSeed("ABCD"), hashSeed("ABCE"));
});

test("same lobby code generates an identical board", () => {
  const a = generateBoard({ code: "K4TQ", difficulty: "medium", useDiagonals: true });
  const b = generateBoard({ code: "K4TQ", difficulty: "medium", useDiagonals: true });
  assert.deepEqual(Array.from(a.walls), Array.from(b.walls));
  assert.deepEqual(a.targets, b.targets);
  assert.deepEqual(a.diagonals, b.diagonals);
});

test("different lobby codes generate different boards", () => {
  const a = generateBoard({ code: "K4TQ", difficulty: "medium" });
  const b = generateBoard({ code: "ZZZZ", difficulty: "medium" });
  assert.notDeepEqual(Array.from(a.walls), Array.from(b.walls));
});

test("walls are stored symmetrically on both sides of an edge", () => {
  const board = generateBoard({ code: "WALL", difficulty: "easy", useDiagonals: true });
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const cell = idx(x, y);
      if (board.walls[cell] & N && y > 0) {
        assert.ok(board.walls[idx(x, y - 1)] & S, `N/S mismatch at ${x},${y}`);
      }
      if (board.walls[cell] & W && x > 0) {
        assert.ok(board.walls[idx(x - 1, y)] & E, `W/E mismatch at ${x},${y}`);
      }
    }
  }
});

test("no cell is ever fully sealed", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const board = generateBoard({ code: `SEAL${difficulty}`, difficulty, useDiagonals: true });
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (board.blocked[cell]) continue;
      assert.ok(countBits(board.walls[cell]) < 4, `cell ${cell} sealed on ${difficulty}`);
    }
  }
});

test("easy boards carry more walls than hard boards", () => {
  const easy = generateBoard({ code: "DENS", difficulty: "easy" });
  const hard = generateBoard({ code: "DENS", difficulty: "hard" });
  const total = (b) => b.walls.reduce((sum, m) => sum + countBits(m), 0);
  assert.ok(total(easy) > total(hard), "easy should be denser than hard");
});

test("the perimeter carries inward-facing wall stubs", () => {
  const board = generateBoard({ code: "EDGE", difficulty: "medium" });

  // A wall perpendicular to an edge, i.e. one that actually stops a robot
  // sliding along that edge. Border walls themselves do not count.
  let topStubs = 0;
  let leftStubs = 0;
  for (let i = 1; i < SIZE - 1; i += 1) {
    if (board.walls[idx(i, 0)] & (E | W)) topStubs += 1;
    if (board.walls[idx(0, i)] & (N | S)) leftStubs += 1;
  }

  assert.ok(topStubs > 0, "top edge should have wall stubs");
  assert.ok(leftStubs > 0, "left edge should have wall stubs");
});

test("a robot sliding along an edge can be stopped short", () => {
  const board = generateBoard({ code: "EDGE", difficulty: "medium" });
  const positions = [idx(0, 0), idx(5, 8), idx(6, 8), idx(7, 8), idx(9, 8)];

  // With perimeter stubs in place, the top-left robot should no longer run
  // the full width of the board.
  const { to } = slide(board, positions, 0, 1);
  assert.ok(to < idx(SIZE - 1, 0), `expected a stop before the far corner, got ${to}`);
});

test("board always produces the full target set", () => {
  const board = generateBoard({ code: "TGTS", difficulty: "medium" });
  assert.equal(board.targets.length, 17);
  const cells = new Set(board.targets.map((t) => t.cell));
  assert.equal(cells.size, 17, "targets must occupy distinct cells");
});

test("a robot slides until it hits the grid edge", () => {
  const board = emptyBoard();
  const positions = positionsWithRedAt(idx(0, 0));
  const { to } = slide(board, positions, 0, 1); // right
  assert.equal(to, idx(SIZE - 1, 0));
});

test("a wall stops a sliding robot", () => {
  const board = emptyBoard();
  board.walls[idx(4, 0)] |= E;
  board.walls[idx(5, 0)] |= W;
  const positions = positionsWithRedAt(idx(0, 0));
  const { to } = slide(board, positions, 0, 1);
  assert.equal(to, idx(4, 0));
});

test("a robot stops against another robot", () => {
  const board = emptyBoard();
  const positions = [idx(0, 0), idx(5, 0), idx(2, 15), idx(3, 15), idx(4, 15)];
  const { to } = slide(board, positions, 0, 1);
  assert.equal(to, idx(4, 0));
});

test("the blocked centre stops a sliding robot", () => {
  const board = emptyBoard();
  centerCells().forEach((cell) => {
    board.blocked[cell] = 1;
  });
  const positions = positionsWithRedAt(idx(0, 7));
  const { to } = slide(board, positions, 0, 1);
  assert.equal(to, idx(6, 7));
});

test("a diagonal deflects a robot ninety degrees", () => {
  const board = emptyBoard();
  board.diagonals[idx(5, 5)] = { kind: "/", color: "blue" };
  const positions = positionsWithRedAt(idx(0, 5));
  // Travelling right into "/" turns the robot upward, so it runs to the top row.
  const { to } = slide(board, positions, 0, 1);
  assert.equal(to, idx(5, 0));
});

test("a robot passes straight through a diagonal of its own colour", () => {
  const board = emptyBoard();
  board.diagonals[idx(5, 5)] = { kind: "/", color: COLORS[0] }; // red, same as robot 0
  const positions = positionsWithRedAt(idx(0, 5));
  const { to } = slide(board, positions, 0, 1);
  assert.equal(to, idx(SIZE - 1, 5));
});

test("the backslash diagonal deflects the other way", () => {
  const board = emptyBoard();
  board.diagonals[idx(5, 5)] = { kind: "\\", color: "blue" };
  const positions = positionsWithRedAt(idx(0, 5));
  // Travelling right into "\" turns the robot downward.
  const { to } = slide(board, positions, 0, 1);
  assert.equal(to, idx(5, SIZE - 1));
});

test("a robot that cannot move yields no move", () => {
  const board = emptyBoard();
  const positions = positionsWithRedAt(idx(0, 0));
  assert.equal(applyMove(board, positions, 0, 3), null); // left, already at edge
});

test("isSolved matches only the target colour", () => {
  const positions = positionsWithRedAt(idx(9, 9));
  assert.ok(isSolved({ cell: idx(9, 9), color: "red" }, positions));
  assert.ok(!isSolved({ cell: idx(9, 9), color: "blue" }, positions));
});

test("a wild target accepts any robot", () => {
  const positions = positionsWithRedAt(idx(9, 9));
  assert.ok(isSolved({ cell: idx(1, 15), color: "wild" }, positions));
});

test("replay rejects a move into a wall", () => {
  const board = emptyBoard();
  const positions = positionsWithRedAt(idx(0, 0));
  const result = replay(board, positions, [{ robot: 0, dir: 3 }]);
  assert.equal(result.ok, false);
  assert.equal(result.moves, 0);
});

test("replay rejects malformed input", () => {
  const board = emptyBoard();
  const positions = positionsWithRedAt(idx(0, 0));
  assert.equal(replay(board, positions, [{ robot: 99, dir: 0 }]).ok, false);
  assert.equal(replay(board, positions, [{ robot: 0, dir: 7 }]).ok, false);
  assert.equal(replay(board, positions, ["nope"]).ok, false);
});

test("replay accepts a legal sequence", () => {
  const board = emptyBoard();
  const positions = positionsWithRedAt(idx(0, 0));
  const result = replay(board, positions, [
    { robot: 0, dir: 1 },
    { robot: 0, dir: 2 }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.positions[0], idx(SIZE - 1, SIZE - 1));
});

test("solver finds the optimal two-move solution", () => {
  const board = emptyBoard();
  const positions = [idx(0, 0), idx(1, 8), idx(2, 8), idx(3, 8), idx(4, 8)];
  const target = { cell: idx(SIZE - 1, SIZE - 1), color: "red" };
  const result = solve(board, positions, target);
  assert.ok(result, "expected a solution");
  assert.equal(result.moves, 2);

  // The reported solution must actually work.
  const check = replay(board, positions, result.solution);
  assert.equal(check.ok, true);
  assert.ok(isSolved(target, check.positions));
});

test("solver reports zero moves when already solved", () => {
  const board = emptyBoard();
  const positions = positionsWithRedAt(idx(9, 9));
  const result = solve(board, positions, { cell: idx(9, 9), color: "red" });
  assert.equal(result.moves, 0);
});

test("solver returns null for an unreachable target", () => {
  const board = emptyBoard();
  // Box the red robot into a one-cell cell so it can never leave.
  board.walls[idx(0, 0)] |= N | E | S | W;
  const positions = positionsWithRedAt(idx(0, 0));
  const result = solve(board, positions, { cell: idx(9, 9), color: "red" }, { maxDepth: 4 });
  assert.equal(result, null);
});

test("generated rounds are solvable on a real board", () => {
  const board = generateBoard({ code: "PLAY", difficulty: "medium" });
  const rng = new Rng("PLAY-round");
  let solvable = 0;

  for (let round = 0; round < 12; round += 1) {
    const target = board.targets[rng.int(board.targets.length)];
    const positions = randomRobotPositions(rng, board, target.cell);
    if (solve(board, positions, target)) solvable += 1;
  }

  // Not every random arrangement resolves within the depth cap, but most should.
  assert.ok(solvable >= 8, `only ${solvable}/12 rounds were solvable`);
});

test("robots never spawn on the blocked centre or on the target", () => {
  const board = generateBoard({ code: "SPWN", difficulty: "medium" });
  const rng = new Rng("SPWN-round");
  const target = board.targets[0];

  for (let i = 0; i < 40; i += 1) {
    const positions = randomRobotPositions(rng, board, target.cell);
    assert.equal(new Set(positions).size, COLORS.length, "robots must not overlap");
    positions.forEach((cell) => {
      assert.equal(board.blocked[cell], 0);
      assert.notEqual(cell, target.cell);
    });
  }
});
