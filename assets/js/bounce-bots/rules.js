// Movement simulation. Pure functions only: no DOM, no network, no randomness.
// The host re-runs these to validate a demonstrated solution, and the solver
// runs them a few hundred thousand times per round, so they stay allocation-light.

import { SIZE, DIRS, DEFLECT, COLORS, inBounds, xOf, yOf } from "./constants.js?v=20260802d";

// A robot slides until something stops it. Diagonals do not stop it -- they
// turn it 90 degrees and it keeps going, which is what makes them interesting.
//
// Returns { to, path }. `path` includes the starting cell so the renderer can
// animate the whole slide, including any mid-slide turns.
export function slide(board, positions, robotIndex, dirIndex) {
  const start = positions[robotIndex];
  const path = [start];

  let pos = start;
  let dir = dirIndex;

  // A robot can never revisit a cell travelling the same direction without
  // looping forever, so CELLS iterations is a hard upper bound. The guard is
  // cheap insurance against a malformed board bouncing between two diagonals.
  for (let guard = 0; guard < SIZE * SIZE; guard += 1) {
    const step = DIRS[dir];

    // A wall on the edge we are leaving stops us before we move.
    if (board.walls[pos] & step.bit) break;

    const nx = xOf(pos) + step.dx;
    const ny = yOf(pos) + step.dy;
    if (!inBounds(nx, ny)) break;

    const next = ny * SIZE + nx;
    if (board.blocked[next]) break;

    // Robots block each other. This is what makes multi-robot solutions work:
    // you park a helper to create a wall that isn't there.
    let occupied = false;
    for (let i = 0; i < positions.length; i += 1) {
      if (i !== robotIndex && positions[i] === next) {
        occupied = true;
        break;
      }
    }
    if (occupied) break;

    pos = next;
    path.push(pos);

    // A diagonal deflects every robot except one matching its own colour,
    // which passes straight through.
    const diag = board.diagonals[pos];
    if (diag && diag.color !== COLORS[robotIndex]) {
      dir = DEFLECT[diag.kind][dir];
    }
  }

  return { to: pos, path };
}

// Applies a move and returns fresh positions. Returns null when the robot
// cannot move at all, which callers treat as an illegal move rather than a
// wasted one -- bumping a wall should never burn a move from your bid.
export function applyMove(board, positions, robotIndex, dirIndex) {
  const { to } = slide(board, positions, robotIndex, dirIndex);
  if (to === positions[robotIndex]) return null;

  const next = positions.slice();
  next[robotIndex] = to;
  return next;
}

// Does this arrangement satisfy the target?
export function isSolved(target, positions) {
  if (!target) return false;
  if (target.color === "wild") {
    return positions.some((p) => p === target.cell);
  }
  const robotIndex = COLORS.indexOf(target.color);
  return robotIndex >= 0 && positions[robotIndex] === target.cell;
}

// Replays a move list from a starting arrangement. Used by the host to verify
// a player's demonstration -- never trust the demonstrating client's own claim
// that it reached the target.
//
// Returns { ok, positions, moves, reason }.
export function replay(board, startPositions, moves) {
  let positions = startPositions.slice();

  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i];
    if (
      !move ||
      !Number.isInteger(move.robot) ||
      !Number.isInteger(move.dir) ||
      move.robot < 0 ||
      move.robot >= positions.length ||
      move.dir < 0 ||
      move.dir > 3
    ) {
      return { ok: false, positions, moves: i, reason: "malformed move" };
    }

    const next = applyMove(board, positions, move.robot, move.dir);
    if (!next) {
      return { ok: false, positions, moves: i, reason: "robot could not move" };
    }
    positions = next;
  }

  return { ok: true, positions, moves: moves.length, reason: null };
}
