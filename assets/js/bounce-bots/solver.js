// Breadth-first search over robot arrangements.
//
// Used at round setup to guarantee the target is actually reachable and isn't a
// one-move gimme. BFS (not DFS) because we need the *optimal* move count, and
// the first time BFS reaches a goal it has found the shortest path.

import { COLORS } from "./constants.js?v=20260803b";
import { applyMove, isSolved } from "./rules.js?v=20260803b";

// Five robots on 256 cells is a ~1e12 state space, so the search is bounded on
// both depth and nodes. Rounds that need more than six moves are rare enough
// that treating "too deep" as "reject and re-roll" costs nothing.
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_NODE_BUDGET = 250000;

function encode(positions) {
  return String.fromCharCode.apply(null, positions);
}

export function solve(board, startPositions, target, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const nodeBudget = options.nodeBudget ?? DEFAULT_NODE_BUDGET;

  if (isSolved(target, startPositions)) {
    return { moves: 0, solution: [] };
  }

  // Only the target robot needs to reach the goal, but any robot may move to
  // get it there, so every robot stays in the branching factor.
  const robotCount = COLORS.length;

  const nodes = [{ positions: startPositions.slice(), depth: 0, parent: -1, move: null }];
  const seen = new Set([encode(startPositions)]);

  for (let head = 0; head < nodes.length; head += 1) {
    const node = nodes[head];
    if (node.depth >= maxDepth) continue;
    if (nodes.length > nodeBudget) break;

    for (let robot = 0; robot < robotCount; robot += 1) {
      for (let dir = 0; dir < 4; dir += 1) {
        const next = applyMove(board, node.positions, robot, dir);
        if (!next) continue;

        const key = encode(next);
        if (seen.has(key)) continue;
        seen.add(key);

        const child = {
          positions: next,
          depth: node.depth + 1,
          parent: head,
          move: { robot, dir }
        };

        if (isSolved(target, next)) {
          return { moves: child.depth, solution: reconstruct(nodes, child) };
        }

        nodes.push(child);
      }
    }
  }

  return null;
}

function reconstruct(nodes, node) {
  const moves = [];
  let current = node;
  while (current && current.move) {
    moves.unshift(current.move);
    current = current.parent >= 0 ? nodes[current.parent] : null;
  }
  return moves;
}

// Round acceptance test. A target that cannot be reached is unplayable, and one
// solvable in a single move ends the round before anyone has looked at it.
export function isPlayableRound(board, positions, target, minMoves = 2, maxDepth = 6) {
  const result = solve(board, positions, target, { maxDepth });
  if (!result) return null;
  if (result.moves < minMoves) return null;
  return result;
}
