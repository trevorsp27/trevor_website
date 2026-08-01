import test from "node:test";
import assert from "node:assert/strict";

import { HostGame, PHASES } from "../assets/js/bounce-bots/game.js";
import { applyMove, isSolved } from "../assets/js/bounce-bots/rules.js";
import { COLORS } from "../assets/js/bounce-bots/constants.js";

function newGame(overrides = {}) {
  const game = new HostGame({
    code: "TEST",
    hostId: "host",
    hostName: "Host",
    settings: { rounds: 3, bidSeconds: 60, demoSeconds: 45, ...overrides }
  });
  game.addPlayer("alice", "Alice");
  game.addPlayer("bob", "Bob");
  return game;
}

// Drives the authoritative solver solution through the current demonstrator,
// which is the only way to legitimately win a round.
function playOptimal(game, playerId) {
  const solution = game.optimal.solution;
  solution.forEach((move) => game.demoMove(playerId, move.robot, move.dir));
}

test("game starts in the lobby and only the host can start it", () => {
  const game = newGame();
  assert.equal(game.phase, PHASES.LOBBY);

  game.start("alice");
  assert.equal(game.phase, PHASES.LOBBY, "non-host must not start the game");

  game.start("host");
  assert.equal(game.phase, PHASES.THINKING);
  assert.equal(game.round, 1);
});

test("only the host can change settings, and only in the lobby", () => {
  const game = newGame();

  game.updateSettings("alice", { difficulty: "hard" });
  assert.equal(game.settings.difficulty, "medium");

  game.updateSettings("host", { difficulty: "hard", useDiagonals: true });
  assert.equal(game.settings.difficulty, "hard");
  assert.equal(game.settings.useDiagonals, true);

  game.start("host");
  game.updateSettings("host", { difficulty: "easy" });
  assert.equal(game.settings.difficulty, "hard", "settings lock once play begins");
});

test("settings are clamped to sane ranges", () => {
  const game = newGame();
  game.updateSettings("host", { rounds: 999, bidSeconds: 1, demoSeconds: 9999 });
  assert.equal(game.settings.rounds, 25);
  assert.equal(game.settings.bidSeconds, 15);
  assert.equal(game.settings.demoSeconds, 180);
});

test("every generated round is solvable in at least two moves", () => {
  const game = newGame();
  game.start("host");

  for (let i = 0; i < 3; i += 1) {
    assert.ok(game.target, "round must have a target");
    assert.ok(game.optimal, `round ${i + 1} should have a known solution`);
    assert.ok(game.optimal.moves >= 2, "no one-move gimmes");
    game.skipRound("host");
    game.revealDeadline = 0;
    game.tick();
  }
});

test("the first bid starts the countdown", () => {
  const game = newGame();
  game.start("host");
  assert.equal(game.phase, PHASES.THINKING);
  assert.equal(game.bidDeadline, 0);

  game.bid("alice", 5);
  assert.equal(game.phase, PHASES.BIDDING);
  assert.ok(game.bidDeadline > Date.now());
});

test("a player may lower their bid but never raise it", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 5);
  game.bid("alice", 7);
  assert.equal(game.bids.get("alice").moves, 5, "raising must be ignored");

  game.bid("alice", 3);
  assert.equal(game.bids.get("alice").moves, 3, "lowering is allowed");
});

test("nonsense bids are rejected", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 0);
  game.bid("alice", -4);
  game.bid("alice", NaN);
  game.bid("alice", 500);
  assert.equal(game.bids.size, 0);

  game.bid("stranger", 4);
  assert.equal(game.bids.size, 0, "unknown players cannot bid");
});

test("demo order is lowest bid first, ties to the earlier bidder", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 6);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.bid("host", 4);
  game.bids.get("host").at = 1500;

  game.lockBids("host");
  assert.deepEqual(game.demoOrder, ["host", "bob", "alice"]);
  assert.equal(game.currentDemo ?? game.currentDemoId(), "host");
});

test("only the current demonstrator can move robots", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 4);
  game.lockBids("host");
  assert.equal(game.currentDemoId(), "alice");

  const before = game.positions.slice();
  game.demoMove("bob", 0, 1);
  assert.deepEqual(game.positions, before, "a bystander must not move anything");
});

test("bumping a wall does not consume a move", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 4);
  game.lockBids("host");

  // Find a robot/direction pair that cannot move at all.
  let found = null;
  for (let robot = 0; robot < COLORS.length && !found; robot += 1) {
    for (let dir = 0; dir < 4; dir += 1) {
      if (!applyMove(game.board, game.positions, robot, dir)) {
        found = { robot, dir };
        break;
      }
    }
  }
  assert.ok(found, "expected at least one blocked direction");

  game.demoMove("alice", found.robot, found.dir);
  assert.equal(game.demoMoveCount, 0);
});

test("malformed demo moves are ignored", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 4);
  game.lockBids("host");

  game.demoMove("alice", 99, 0);
  game.demoMove("alice", 0, 9);
  game.demoMove("alice", "x", "y");
  assert.equal(game.demoMoveCount, 0);
});

test("solving within the bid scores a point and reveals the round", () => {
  const game = newGame();
  game.start("host");

  const par = game.optimal.moves;
  game.bid("alice", par);
  game.lockBids("host");
  assert.equal(game.currentDemoId(), "alice");

  playOptimal(game, "alice");

  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.players.get("alice").score, 1);
  assert.equal(game.lastRound.winnerId, "alice");
  assert.equal(game.lastRound.used, par);
});

test("running past the bid hands the round to the next bidder", () => {
  const game = newGame();
  game.start("host");

  const par = game.optimal.moves;
  game.bid("alice", 2); // deliberately too low to be achievable
  game.bids.get("alice").at = 1000;
  game.bid("bob", par);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");
  assert.equal(game.currentDemoId(), "alice");

  // Burn Alice's two moves on something that will not solve it.
  let burned = 0;
  for (let robot = 0; robot < COLORS.length && burned < 2; robot += 1) {
    for (let dir = 0; dir < 4 && burned < 2; dir += 1) {
      if (game.phase !== PHASES.DEMO) break;
      const next = applyMove(game.board, game.positions, robot, dir);
      if (next && !isSolved(game.target, next)) {
        game.demoMove("alice", robot, dir);
        burned += 1;
      }
    }
  }

  assert.equal(game.players.get("alice").score, 0);
  assert.equal(game.currentDemoId(), "bob", "turn should pass to the next bidder");
  assert.equal(game.demoMoveCount, 0, "the board resets for the next demonstrator");
});

test("passing hands off, and exhausting all bidders ends the round unsolved", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");

  game.passDemo("alice");
  assert.equal(game.currentDemoId(), "bob");

  game.passDemo("bob");
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.lastRound.winnerId, null);
  assert.ok(game.lastRound.solution.length >= 2, "unsolved rounds reveal the optimal line");
});

test("reset restores the round's starting position", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 5);
  game.lockBids("host");

  const start = game.startPositions.slice();
  const move = game.optimal.solution[0];
  game.demoMove("alice", move.robot, move.dir);
  assert.notDeepEqual(game.positions, start);

  game.resetDemo("alice");
  assert.deepEqual(game.positions, start);
  assert.equal(game.demoMoveCount, 0);
});

test("a disconnect during a demo passes the turn on", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");
  assert.equal(game.currentDemoId(), "alice");

  game.removePlayer("alice");
  assert.equal(game.currentDemoId(), "bob");
});

test("disconnected players are skipped in the demo order", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.removePlayer("alice");
  game.lockBids("host");

  assert.equal(game.currentDemoId(), "bob");
});

test("the bidding clock expiring opens the demo phase", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 4);

  game.bidDeadline = Date.now() - 1;
  game.tick();
  assert.equal(game.phase, PHASES.DEMO);
});

test("a demo timing out passes the turn on", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");

  game.demoDeadline = Date.now() - 1;
  game.tick();
  assert.equal(game.currentDemoId(), "bob");
});

test("a round with no bids at all resolves instead of hanging", () => {
  const game = newGame();
  game.start("host");

  game.bidDeadline = Date.now() - 1;
  game.phase = PHASES.BIDDING;
  game.tick();
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.lastRound.winnerId, null);
});

test("the game ends after the configured number of rounds", () => {
  const game = newGame({ rounds: 2 });
  game.start("host");
  assert.equal(game.round, 1);

  game.skipRound("host");
  game.revealDeadline = 0;
  game.tick();
  assert.equal(game.round, 2);

  game.skipRound("host");
  game.revealDeadline = 0;
  game.tick();
  assert.equal(game.phase, PHASES.OVER);
});

test("the snapshot stays small enough to broadcast on every change", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 4);
  game.bid("bob", 6);

  const bytes = JSON.stringify(game.snapshot()).length;
  assert.ok(bytes < 2048, `snapshot was ${bytes} bytes`);
});

test("the snapshot carries everything a client needs to rebuild the board", () => {
  const game = newGame();
  game.start("host");
  const snap = game.snapshot();

  assert.equal(snap.code, "TEST");
  assert.ok(snap.settings.difficulty);
  assert.equal(typeof snap.settings.useDiagonals, "boolean");
  assert.equal(snap.positions.length, COLORS.length);
  assert.ok(snap.target.cell >= 0);
});
