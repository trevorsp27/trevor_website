// Computer opponents.
//
// The host already runs a BFS solver to validate each round, so the bot has
// perfect information for free. That means difficulty cannot be about *finding*
// the answer -- it has to be about how the bot behaves with an answer it
// already has. Three separate dials do the work:
//
//   speed    how long it takes to commit a bid (a fast bot beats you to the
//            low bid even when you both saw the same line)
//   padding  how far off optimal its bid is (a padded bid is easy to beat)
//   nerve    how often it fumbles the demonstration it promised
//
// Without the speed dial a hard bot is unbeatable and an easy one is trivial;
// with it, difficulty is really "how much time do I get to think".
//
// moveDelay is deliberately NOT a difficulty dial -- it only controls how
// watchable the demonstration is. Note the host ticks every 250ms, so any
// delay is quantised to a multiple of that.

import { Rng } from "./rng.js?v=20260802d";
import { applyMove } from "./rules.js?v=20260802d";
import { COLORS } from "./constants.js?v=20260802d";

export const BOT_LEVELS = {
  1: {
    id: 1,
    name: "Casual",
    blurb: "Slow to commit, pads its bids, and fumbles under pressure.",
    think: [16000, 30000],
    padding: [2, 4],
    fumble: 0.35,
    moveDelay: 1400
  },
  2: {
    id: 2,
    name: "Sharp",
    blurb: "Bids close to optimal and usually backs it up.",
    think: [8000, 17000],
    padding: [0, 2],
    fumble: 0.15,
    moveDelay: 1250
  },
  3: {
    id: 3,
    name: "Ruthless",
    blurb: "Finds the shortest line fast and always proves it.",
    think: [3500, 9000],
    padding: [0, 0],
    fumble: 0,
    moveDelay: 1100
  }
};

export function botLevel(value) {
  return BOT_LEVELS[value] || BOT_LEVELS[2];
}

export class BotPlayer {
  constructor(id, name, level, seed) {
    this.id = id;
    this.name = name;
    this.level = botLevel(level);
    this.rng = new Rng(seed);
    this.isBot = true;
    this.reset();
  }

  reset() {
    this.bidAt = 0;
    this.bidValue = 0;
    this.hasBid = false;
    this.willFumble = false;
    this.plan = [];
    this.planStep = 0;
    this.nextMoveAt = 0;
    this.demoStarted = false;
    this.hasResigned = false;
  }

  // Called once per round, as soon as the host knows the answer.
  planRound(game, now) {
    this.reset();

    const optimal = game.optimal;
    if (!optimal) {
      // No known solution, so the bot sits the round out and agrees to move on.
      this.bidAt = 0;
      this.bidValue = 0;
      return;
    }

    const level = this.level;
    this.bidAt = now + this.rng.range(level.think[0], level.think[1]);
    this.bidValue = optimal.moves + this.rng.range(level.padding[0], level.padding[1]);
    this.willFumble = this.rng.chance(level.fumble);
    this.plan = optimal.solution.slice();
  }

  update(game, now) {
    if (game.phase === "thinking" || game.phase === "bidding") {
      this.think(game, now);
      return;
    }
    if (game.phase === "demo" && game.currentDemoId() === this.id) {
      this.demonstrate(game, now);
    }
  }

  think(game, now) {
    if (!this.hasBid) {
      if (now < this.bidAt) return;
      if (this.bidValue > 0) game.bid(this.id, this.bidValue);
      this.hasBid = true;
    }

    // Having committed, the bot has no reason to keep the clock running.
    //
    // Eligibility has to be re-checked every tick rather than voted once:
    // placing a bid removes the bot from the voter list, and it only rejoins
    // if everyone else bids too. A one-shot vote gets silently dropped.
    if (game.phase !== "thinking" && game.phase !== "bidding") return;
    if (game.resignVotes.has(this.id)) return;
    if (!game.resignVoters().includes(this.id)) return;

    this.hasResigned = true;
    game.voteResign(this.id);
  }

  demonstrate(game, now) {
    // A beat before the first move, so viewers can read the starting position
    // instead of watching a robot fly off the moment the turn hands over.
    // An explicit flag rather than a sentinel value, since nextMoveAt is only
    // meaningful once the turn has actually begun.
    if (!this.demoStarted) {
      this.demoStarted = true;
      this.nextMoveAt = now + this.level.moveDelay;
      return;
    }
    if (now < this.nextMoveAt) return;
    this.nextMoveAt = now + this.level.moveDelay;

    // A fumbling bot plays plausible-looking but wrong moves until it runs out
    // of the moves it promised, then takes the penalty like anyone else.
    const move = this.willFumble ? this.wanderingMove(game) : this.plan[this.planStep];
    this.planStep += 1;

    if (!move) {
      game.passDemo(this.id);
      return;
    }
    game.demoMove(this.id, move.robot, move.dir);
  }

  wanderingMove(game) {
    const options = [];
    for (let robot = 0; robot < COLORS.length; robot += 1) {
      for (let dir = 0; dir < 4; dir += 1) {
        if (applyMove(game.board, game.positions, robot, dir)) options.push({ robot, dir });
      }
    }
    return options.length ? this.rng.pick(options) : null;
  }
}
