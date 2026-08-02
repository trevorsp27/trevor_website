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

test("running past the bid costs a point and ends the round", () => {
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

  assert.equal(game.players.get("alice").score, -1, "a failed claim costs a point");
  assert.equal(game.phase, PHASES.REVEAL, "the round ends rather than passing on");
  assert.equal(game.lastRound.failedId, "alice");
  assert.equal(game.lastRound.penalty, -1);
  assert.equal(game.players.get("bob").score, 0, "the next bidder gets no turn");
});

test("passing costs a point and ends the round", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");

  game.passDemo("alice");
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.players.get("alice").score, -1);
  assert.equal(game.players.get("bob").score, 0);
  assert.ok(game.lastRound.solution.length >= 2, "unsolved rounds reveal the optimal line");
});

test("scores can go negative across rounds", () => {
  const game = newGame({ rounds: 3 });
  game.start("host");

  for (let round = 0; round < 2; round += 1) {
    game.bid("alice", 3);
    game.lockBids("host");
    game.passDemo("alice");
    game.revealDeadline = 0;
    game.tick();
  }

  assert.equal(game.players.get("alice").score, -2);
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

test("a disconnect during a demo ends the round without a penalty", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");
  assert.equal(game.currentDemoId(), "alice");

  game.removePlayer("alice");
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.players.get("alice").score, 0, "a dropped connection is not a failed claim");
  assert.equal(game.lastRound.penalty, 0);
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

test("after a bid, only the players who have not bid get a vote", () => {
  const game = newGame(); // host, alice, bob
  game.start("host");
  game.bid("alice", 5);

  assert.deepEqual(game.resignVoters().sort(), ["bob", "host"], "the bidder is excluded");

  game.voteResign("alice");
  assert.equal(game.resignVotes.size, 0, "a bidder cannot resign");
});

test("with two players, the one who did not bid can end the clock alone", () => {
  const game = new HostGame({
    code: "TEST",
    hostId: "host",
    hostName: "Host",
    settings: { rounds: 3 }
  });
  game.addPlayer("alice", "Alice");
  game.start("host");

  game.bid("alice", 4);
  assert.deepEqual(game.resignVoters(), ["host"]);

  game.voteResign("host");
  assert.equal(game.phase, PHASES.DEMO, "one non-bidder is enough");
  assert.equal(game.currentDemoId(), "alice");
});

test("every non-bidder must agree, not just most of them", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 5);

  game.voteResign("bob");
  assert.equal(game.phase, PHASES.BIDDING, "one of two non-bidders is not enough");

  game.voteResign("host");
  assert.equal(game.phase, PHASES.DEMO);
});

test("everyone resigning before any bid throws the round away with no points", () => {
  const game = newGame();
  game.start("host");
  assert.equal(game.phase, PHASES.THINKING);
  assert.deepEqual(game.resignVoters().sort(), ["alice", "bob", "host"]);

  game.voteResign("alice");
  game.voteResign("bob");
  assert.equal(game.phase, PHASES.THINKING, "not everyone has agreed yet");

  game.voteResign("host");
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.lastRound.winnerId, null);
  assert.equal(game.lastRound.penalty, 0);
  [...game.players.values()].forEach((p) => assert.equal(p.score, 0, "nobody scores"));
});

test("a resignation can be taken back", () => {
  const game = newGame();
  game.start("host");

  game.voteResign("bob");
  assert.equal(game.resignVotes.size, 1);

  game.voteResign("bob");
  assert.equal(game.resignVotes.size, 0, "voting again withdraws it");
  assert.equal(game.phase, PHASES.THINKING);
});

test("bidding can itself settle a pending resignation", () => {
  const game = newGame();
  game.start("host");

  // Both others give up while still in the thinking phase.
  game.voteResign("bob");
  game.voteResign("host");
  assert.equal(game.phase, PHASES.THINKING, "alice has not resigned");

  // Alice bids, so the voter list shrinks to the two who already resigned.
  game.bid("alice", 4);
  assert.equal(game.phase, PHASES.DEMO, "the clock never had to run");
  assert.equal(game.currentDemoId(), "alice");
});

test("resign votes are ignored once demos begin", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 4);
  game.lockBids("host");

  game.voteResign("bob");
  assert.equal(game.resignVotes.size, 0);
  assert.equal(game.phase, PHASES.DEMO);
});

test("a disconnect releases the vote and can settle a resignation", () => {
  const game = newGame();
  game.addPlayer("carol", "Carol");
  game.start("host");
  game.bid("alice", 5);

  // Non-bidders: host, bob, carol.
  game.voteResign("host");
  game.voteResign("bob");
  assert.equal(game.phase, PHASES.BIDDING);

  game.removePlayer("carol");
  assert.equal(game.resignVotes.has("carol"), false);
  assert.equal(game.phase, PHASES.DEMO, "carol leaving settles it");
});

test("resign votes reset between rounds", () => {
  const game = newGame();
  game.start("host");
  game.voteResign("bob");
  assert.equal(game.resignVotes.size, 1);

  game.skipRound("host");
  game.revealDeadline = 0;
  game.tick();
  assert.equal(game.resignVotes.size, 0);
});

test("a player who stops reporting in is dropped", () => {
  const game = newGame();
  game.addPlayer("ghost", "Ghost");

  // Backdate the last heartbeat past the timeout.
  game.players.get("ghost").lastSeen = Date.now() - 60000;
  game.tick();

  assert.equal(game.players.get("ghost").connected, false);
  assert.equal(game.players.get("alice").connected, true, "live players stay");
});

test("a heartbeat keeps a player alive", () => {
  const game = newGame();
  game.players.get("alice").lastSeen = Date.now() - 60000;

  game.heartbeat("alice");
  game.tick();

  assert.equal(game.players.get("alice").connected, true);
});

test("a returning player is marked connected again", () => {
  const game = newGame();
  game.players.get("alice").lastSeen = Date.now() - 60000;
  game.tick();
  assert.equal(game.players.get("alice").connected, false);

  game.heartbeat("alice");
  assert.equal(game.players.get("alice").connected, true);
});

test("the host is never dropped for silence", () => {
  const game = newGame();
  // The host never sends itself pings, so its lastSeen goes stale by design.
  game.players.get("host").lastSeen = Date.now() - 600000;
  game.tick();
  assert.equal(game.players.get("host").connected, true);
});

test("a vanished demonstrator resolves without burning the demo clock", () => {
  const game = newGame();
  game.start("host");

  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 5);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");
  assert.equal(game.currentDemoId(), "alice");

  // Alice's tab dies. Her demo deadline is still ~45s away.
  const deadline = game.demoDeadline;
  game.players.get("alice").lastSeen = Date.now() - 60000;
  game.tick();

  assert.ok(deadline - Date.now() > 30000, "the demo clock had plenty left");
  assert.equal(game.phase, PHASES.REVEAL, "resolves without waiting for the timeout");
  assert.equal(game.players.get("alice").score, 0, "a disconnect is not penalised");
});

test("heartbeats from an unknown peer are ignored", () => {
  const game = newGame();
  game.heartbeat("nobody");
  assert.equal(game.players.has("nobody"), false);
});

test("the bidding clock expiring opens the demo phase", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 4);

  game.bidDeadline = Date.now() - 1;
  game.tick();
  assert.equal(game.phase, PHASES.DEMO);
});

test("a demo timing out costs a point and ends the round", () => {
  const game = newGame();
  game.start("host");
  game.bid("alice", 3);
  game.bids.get("alice").at = 1000;
  game.bid("bob", 4);
  game.bids.get("bob").at = 2000;
  game.lockBids("host");

  game.demoDeadline = Date.now() - 1;
  game.tick();
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.players.get("alice").score, -1);
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
