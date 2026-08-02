// Authoritative game state. Only the lobby leader runs this; everyone else
// renders the snapshots it produces.
//
// Nothing here touches the DOM or the network. The host wires it to both, which
// keeps the rules testable and stops UI bugs from corrupting game state.

import { Rng } from "./rng.js";
import { generateBoard, randomRobotPositions } from "./board.js";
import { applyMove, isSolved } from "./rules.js";
import { isPlayableRound } from "./solver.js";
import { COLORS } from "./constants.js";

export const PHASES = {
  LOBBY: "lobby",
  THINKING: "thinking",
  BIDDING: "bidding",
  DEMO: "demo",
  REVEAL: "reveal",
  OVER: "over"
};

export const DEFAULT_SETTINGS = {
  difficulty: "medium",
  useDiagonals: false,
  rounds: 10,
  bidSeconds: 60,
  demoSeconds: 45,
  revealSeconds: 8
};

const MIN_MOVES = 2;
const SEARCH_DEPTH = 6;
const ROUND_ATTEMPTS = 60;

// WebRTC gives no reliable signal when a peer's tab is closed abruptly -- a
// graceful close sends a teardown, but a killed tab sends nothing at all. So
// clients report in on a timer and the host drops anyone who goes quiet.
export const HEARTBEAT_MS = 3000;
const PLAYER_TIMEOUT_MS = 10000;

export class HostGame {
  constructor({ code, hostId, hostName, settings, onChange }) {
    this.code = code;
    this.hostId = hostId;
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this.onChange = onChange || (() => {});

    this.players = new Map();

    this.phase = PHASES.LOBBY;
    this.round = 0;
    this.board = null;
    this.rng = null;

    this.target = null;
    this.startPositions = null;
    this.positions = null;
    this.optimal = null;

    this.bids = new Map(); // playerId -> { moves, at }
    this.resignVotes = new Set();
    this.demoOrder = [];
    this.demoIndex = -1;
    this.demoMoveCount = 0;
    this.demoTrail = [];

    this.bidDeadline = 0;
    this.demoDeadline = 0;
    this.revealDeadline = 0;
    this.lastRound = null;
    this.notice = "";

    // Added last: addPlayer() emits a snapshot, so every field it reads must
    // already exist.
    this.addPlayer(hostId, hostName);
  }

  // ---- players -----------------------------------------------------------

  addPlayer(id, name) {
    const existing = this.players.get(id);
    if (existing) {
      existing.connected = true;
      existing.lastSeen = Date.now();
      if (name) existing.name = name;
    } else {
      this.players.set(id, {
        id,
        name: name || "Player",
        score: 0,
        connected: true,
        lastSeen: Date.now()
      });
    }
    this.changed();
  }

  // Called on every client ping. Deliberately does not emit a snapshot: with
  // several players reporting in every few seconds, that would broadcast the
  // whole game state constantly for no reason.
  heartbeat(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    player.lastSeen = Date.now();
    if (!player.connected) {
      // Someone who went quiet and came back is playing again.
      player.connected = true;
      this.changed();
    }
  }

  dropStalePlayers() {
    const now = Date.now();
    this.players.forEach((player) => {
      // The host is running this loop, so it is by definition present.
      if (player.id === this.hostId) return;
      if (!player.connected) return;
      if (now - player.lastSeen <= PLAYER_TIMEOUT_MS) return;
      this.removePlayer(player.id);
    });
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;
    this.resignVotes.delete(id);

    // A disconnect during someone's demo should not stall the round. No
    // penalty: a dropped connection is not a failed claim.
    if (this.phase === PHASES.DEMO && this.currentDemoId() === id) {
      this.failDemo("disconnected", { penalise: false });
      return;
    }

    // Losing a player shrinks the voter list, which may settle a pending
    // resignation.
    if (this.checkResign()) return;
    this.changed();
  }

  // ---- settings & start --------------------------------------------------

  updateSettings(playerId, patch) {
    if (playerId !== this.hostId) return;
    if (this.phase !== PHASES.LOBBY) return;

    const next = { ...this.settings, ...patch };
    next.rounds = clamp(Math.round(next.rounds), 1, 25);
    next.bidSeconds = clamp(Math.round(next.bidSeconds), 15, 180);
    next.demoSeconds = clamp(Math.round(next.demoSeconds), 15, 180);
    this.settings = next;
    this.changed();
  }

  start(playerId) {
    if (playerId !== this.hostId) return;
    if (this.phase !== PHASES.LOBBY && this.phase !== PHASES.OVER) return;

    // Walls are generated once and persist for the whole game; only robots and
    // the target change between rounds.
    this.board = generateBoard({
      code: this.code,
      difficulty: this.settings.difficulty,
      useDiagonals: this.settings.useDiagonals
    });
    this.rng = new Rng(`${this.code}|rounds|${Date.now()}`);

    this.players.forEach((p) => {
      p.score = 0;
    });

    this.round = 0;
    this.lastRound = null;
    this.nextRound();
  }

  // ---- rounds ------------------------------------------------------------

  nextRound() {
    if (this.round >= this.settings.rounds) {
      this.phase = PHASES.OVER;
      this.notice = "Game over";
      this.changed();
      return;
    }

    this.round += 1;
    this.setupRound();

    this.phase = PHASES.THINKING;
    this.bids.clear();
    this.resignVotes.clear();
    this.demoOrder = [];
    this.demoIndex = -1;
    this.demoMoveCount = 0;
    this.demoTrail = [];
    this.bidDeadline = 0;
    this.demoDeadline = 0;
    this.notice = "";
    this.changed();
  }

  // Re-rolls robots and target until the solver confirms a round worth playing.
  setupRound() {
    let fallback = null;

    for (let attempt = 0; attempt < ROUND_ATTEMPTS; attempt += 1) {
      const target = this.board.targets[this.rng.int(this.board.targets.length)];
      const positions = randomRobotPositions(this.rng, this.board, target.cell);

      const result = isPlayableRound(this.board, positions, target, MIN_MOVES, SEARCH_DEPTH);
      if (result) {
        this.target = target;
        this.startPositions = positions;
        this.positions = positions.slice();
        this.optimal = result;
        return;
      }
      if (!fallback) fallback = { target, positions };
    }

    // Extremely unlikely, but never leave the game without a round to play.
    this.target = fallback.target;
    this.startPositions = fallback.positions;
    this.positions = fallback.positions.slice();
    this.optimal = null;
  }

  // ---- bidding -----------------------------------------------------------

  bid(playerId, moves) {
    if (this.phase !== PHASES.THINKING && this.phase !== PHASES.BIDDING) return;
    if (!this.players.has(playerId)) return;

    const value = Math.round(Number(moves));
    if (!Number.isFinite(value) || value < 1 || value > 99) return;

    const existing = this.bids.get(playerId);
    // You may improve your own bid, never inflate it.
    if (existing && value >= existing.moves) return;

    this.bids.set(playerId, { moves: value, at: Date.now() });

    // The first bid of the round starts the clock for everyone.
    if (this.phase === PHASES.THINKING) {
      this.phase = PHASES.BIDDING;
      this.bidDeadline = Date.now() + this.settings.bidSeconds * 1000;
    }

    // Bidding narrows the voter list to the players still searching, so a
    // resignation that was one short may now carry.
    if (this.checkResign()) return;
    this.changed();
  }

  lockBids(playerId) {
    if (playerId !== this.hostId) return;
    if (this.phase !== PHASES.BIDDING) return;
    this.beginDemos();
  }

  // Who gets a say in resigning.
  //
  // Before anyone has bid, the whole table decides whether the round is a
  // write-off. Once a bid is on the table, the bidders have something to prove
  // and it is the players still searching who decide whether to keep looking --
  // so with two players and one bid, the other can end it alone.
  resignVoters() {
    const connected = [...this.players.values()].filter((p) => p.connected);
    if (this.phase !== PHASES.BIDDING) return connected.map((p) => p.id);

    const searching = connected.filter((p) => !this.bids.has(p.id));
    // If everyone has bid there is nobody left searching, so it takes the
    // whole table to agree.
    return (searching.length ? searching : connected).map((p) => p.id);
  }

  voteResign(playerId) {
    if (this.phase !== PHASES.THINKING && this.phase !== PHASES.BIDDING) return;
    if (!this.players.get(playerId)?.connected) return;
    if (!this.resignVoters().includes(playerId)) return;

    // Toggle, so a player can take it back if they spot something.
    if (this.resignVotes.has(playerId)) this.resignVotes.delete(playerId);
    else this.resignVotes.add(playerId);

    if (this.checkResign()) return;
    this.changed();
  }

  // Carries only when every current voter has agreed. Votes from players who
  // are no longer voters (someone who resigned and then bid) simply stop
  // counting, because the tally is always taken over the live voter list.
  checkResign() {
    const voters = this.resignVoters();
    if (!voters.length) return false;
    if (!voters.every((id) => this.resignVotes.has(id))) return false;

    if (this.phase === PHASES.BIDDING) {
      this.notice = "Nobody else was looking — clock cut short";
      this.beginDemos();
    } else {
      this.notice = "Everyone resigned — no points this round";
      this.enterReveal(this.unsolvedResult());
    }
    return true;
  }

  skipRound(playerId) {
    if (playerId !== this.hostId) return;
    if (this.phase === PHASES.LOBBY || this.phase === PHASES.OVER) return;
    this.notice = "Round skipped";
    this.enterReveal(this.unsolvedResult());
  }

  // ---- demonstrations ----------------------------------------------------

  beginDemos() {
    this.resignVotes.clear();

    // Lowest bid first; ties break toward whoever committed earlier. Only the
    // lowest bidder ever demonstrates -- a failure ends the round rather than
    // passing down the list -- but the full order is kept so the UI can show
    // where everyone stood.
    this.demoOrder = [...this.bids.entries()]
      .sort((a, b) => a[1].moves - b[1].moves || a[1].at - b[1].at)
      .map(([id]) => id)
      .filter((id) => this.players.get(id)?.connected);

    if (!this.demoOrder.length) {
      this.enterReveal(this.unsolvedResult());
      return;
    }

    this.demoIndex = 0;
    this.phase = PHASES.DEMO;
    this.positions = this.startPositions.slice();
    this.demoMoveCount = 0;
    this.demoTrail = [];
    this.demoDeadline = Date.now() + this.settings.demoSeconds * 1000;
    this.changed();
  }

  currentDemoId() {
    if (this.demoIndex < 0 || this.demoIndex >= this.demoOrder.length) return null;
    return this.demoOrder[this.demoIndex];
  }

  currentBid() {
    const id = this.currentDemoId();
    return id ? this.bids.get(id)?.moves ?? 0 : 0;
  }

  // Every demonstrated move is validated here. The demonstrating client is
  // never trusted to report its own success.
  demoMove(playerId, robot, dir) {
    if (this.phase !== PHASES.DEMO) return;
    if (playerId !== this.currentDemoId()) return;

    const robotIndex = Number(robot);
    const dirIndex = Number(dir);
    if (!Number.isInteger(robotIndex) || robotIndex < 0 || robotIndex >= COLORS.length) return;
    if (!Number.isInteger(dirIndex) || dirIndex < 0 || dirIndex > 3) return;

    const next = applyMove(this.board, this.positions, robotIndex, dirIndex);
    // Bumping a wall is a no-op, not a wasted move.
    if (!next) return;

    this.positions = next;
    this.demoMoveCount += 1;
    this.demoTrail.push({ robot: robotIndex, dir: dirIndex });

    if (isSolved(this.target, this.positions)) {
      this.succeedDemo();
      return;
    }
    if (this.demoMoveCount >= this.currentBid()) {
      this.failDemo("ran out of moves");
      return;
    }
    this.changed();
  }

  resetDemo(playerId) {
    if (this.phase !== PHASES.DEMO) return;
    if (playerId !== this.currentDemoId()) return;
    this.positions = this.startPositions.slice();
    this.demoMoveCount = 0;
    this.demoTrail = [];
    this.changed();
  }

  passDemo(playerId) {
    if (this.phase !== PHASES.DEMO) return;
    if (playerId !== this.currentDemoId()) return;
    this.failDemo("passed");
  }

  succeedDemo() {
    const id = this.currentDemoId();
    const player = this.players.get(id);
    if (player) player.score += 1;

    this.enterReveal({
      ...this.unsolvedResult(),
      winnerId: id,
      winnerName: player?.name || "Someone",
      bid: this.currentBid(),
      used: this.demoMoveCount,
      solution: this.demoTrail.slice()
    });
  }

  // Claiming a solution you cannot show costs a point, and the round is over --
  // it does not pass to the next bidder. A disconnect is not penalised: a
  // dropped connection is not a failed claim.
  failDemo(reason, { penalise = true } = {}) {
    const id = this.currentDemoId();
    const player = this.players.get(id);
    if (player && penalise) player.score -= 1;

    this.notice = `${player?.name || "Player"} ${reason}`;
    this.enterReveal({
      ...this.unsolvedResult(),
      failedId: id,
      failedName: player?.name || "Player",
      penalty: player && penalise ? -1 : 0,
      bid: this.currentBid(),
      used: this.demoMoveCount,
      reason
    });
  }

  // A round nobody won. Shows the machine's answer so players can see what
  // they missed.
  unsolvedResult() {
    return {
      winnerId: null,
      winnerName: null,
      failedId: null,
      failedName: null,
      penalty: 0,
      bid: null,
      used: null,
      reason: null,
      solution: this.optimal?.solution ?? []
    };
  }

  enterReveal(result) {
    this.phase = PHASES.REVEAL;
    this.resignVotes.clear();
    this.lastRound = { ...result, optimal: this.optimal?.moves ?? null };

    this.positions = this.startPositions.slice();
    this.revealDeadline = Date.now() + this.settings.revealSeconds * 1000;
    this.changed();
  }

  // ---- clock -------------------------------------------------------------

  tick() {
    // Runs first: dropping a vanished demonstrator hands the turn on
    // immediately instead of burning their whole demo clock.
    this.dropStalePlayers();

    const now = Date.now();

    if (this.phase === PHASES.BIDDING && now >= this.bidDeadline) {
      this.beginDemos();
      return;
    }
    if (this.phase === PHASES.DEMO && now >= this.demoDeadline) {
      this.failDemo("ran out of time");
      return;
    }
    if (this.phase === PHASES.REVEAL && now >= this.revealDeadline) {
      this.nextRound();
    }
  }

  changed() {
    this.onChange(this.snapshot());
  }

  // The full state, small enough (well under 2KB) that broadcasting all of it
  // on every change is cheaper than reasoning about deltas.
  snapshot() {
    return {
      v: 1,
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      round: this.round,
      totalRounds: this.settings.rounds,
      target: this.target,
      startPositions: this.startPositions,
      positions: this.positions,
      bids: [...this.bids.entries()].map(([id, b]) => ({ id, moves: b.moves })),
      resignVotes: [...this.resignVotes],
      resignVoters: this.resignVoters(),
      demoOrder: this.demoOrder,
      currentDemo: this.currentDemoId(),
      currentBid: this.currentBid(),
      demoMoveCount: this.demoMoveCount,
      bidDeadline: this.bidDeadline,
      demoDeadline: this.demoDeadline,
      revealDeadline: this.revealDeadline,
      players: [...this.players.values()].map((p) => ({ ...p })),
      lastRound: this.lastRound,
      notice: this.notice
    };
  }
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}
