import test from "node:test";
import assert from "node:assert/strict";

import { HostGame, PHASES } from "../assets/js/bounce-bots/game.js";
import { BOT_LEVELS, botLevel } from "../assets/js/bounce-bots/bot.js";

function soloGame(overrides = {}) {
  return new HostGame({
    code: "BOTS",
    hostId: "host",
    hostName: "Host",
    settings: { rounds: 5, botCount: 1, botLevel: 2, ...overrides }
  });
}

// Advances the host clock without waiting in real time.
function runFor(game, ms, step = 250) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    shiftDeadlines(game, step);
    game.tick();
  }
}

// The bot schedules against Date.now(), so pull its deadlines backwards
// instead of sleeping.
function shiftDeadlines(game, ms) {
  game.bots.forEach((bot) => {
    bot.bidAt -= ms;
    bot.nextMoveAt -= ms;
  });
  if (game.bidDeadline) game.bidDeadline -= ms;
  if (game.demoDeadline) game.demoDeadline -= ms;
  if (game.revealDeadline) game.revealDeadline -= ms;
}

test("a bot joins the roster as an ordinary player", () => {
  const game = soloGame();
  const bot = [...game.players.values()].find((p) => p.isBot);

  assert.ok(bot, "a bot should be in the player list");
  assert.equal(bot.name, "Sharp");
  assert.equal(bot.connected, true);
  assert.equal(game.players.size, 2, "host plus one bot");
});

test("bot count and level are configurable and clamped", () => {
  const game = soloGame({ botCount: 0 });
  assert.equal(game.bots.length, 0);

  game.updateSettings("host", { botCount: 3, botLevel: 3 });
  assert.equal(game.bots.length, 3);
  assert.equal([...game.players.values()].filter((p) => p.isBot).length, 3);

  game.updateSettings("host", { botCount: 99, botLevel: 99 });
  assert.equal(game.bots.length, 3, "capped at three");
  assert.equal(game.settings.botLevel, 3);
});

test("multiple bots get distinct names and ids", () => {
  const game = soloGame({ botCount: 3, botLevel: 1 });
  const names = [...game.players.values()].filter((p) => p.isBot).map((p) => p.name);
  assert.equal(new Set(names).size, 3, names.join(", "));
});

test("only the host can add bots", () => {
  const game = soloGame({ botCount: 0 });
  game.addPlayer("alice", "Alice");

  game.updateSettings("alice", { botCount: 2 });
  assert.equal(game.bots.length, 0);
});

test("bots are never dropped for going quiet", () => {
  const game = soloGame();
  const bot = [...game.players.values()].find((p) => p.isBot);

  // Bots live inside the host and never send heartbeats.
  bot.lastSeen = Date.now() - 600000;
  game.tick();
  assert.equal(bot.connected, true);
});

test("a solo human plus a bot plays a complete round", () => {
  const game = soloGame({ botLevel: 3 });
  game.start("host");
  assert.equal(game.phase, PHASES.THINKING);

  runFor(game, 15000);
  assert.equal(game.phase, PHASES.BIDDING, "the bot should have opened the bidding");
  assert.ok(game.bids.has("bot-1"));

  // The human is the only player still searching, so they end the clock alone.
  game.voteResign("host");
  assert.equal(game.phase, PHASES.DEMO);
  assert.equal(game.currentDemoId(), "bot-1");

  // Assert on the outcome rather than the phase: a fast bot can finish its
  // demo, sit through the reveal, and be bidding on the next round already.
  runFor(game, 20000);
  assert.ok(game.lastRound, "the round should have resolved");
  assert.equal(game.lastRound.winnerId, "bot-1", "the bot should have played its line");
});

test("a ruthless bot bids the optimal line and proves it", () => {
  const game = soloGame({ botLevel: 3 });
  game.start("host");

  const par = game.optimal.moves;
  runFor(game, 15000);
  game.voteResign("host");
  runFor(game, 20000);

  const bot = game.players.get("bot-1");
  assert.equal(bot.score, 1, "a ruthless bot should convert");
  assert.equal(game.lastRound.winnerId, "bot-1");
  assert.equal(game.lastRound.used, par, "and do it in the optimal number of moves");
});

test("a human who underbids the bot demonstrates first", () => {
  const game = soloGame({ botLevel: 1 }); // casual pads its bid
  game.start("host");

  runFor(game, 40000);
  assert.ok(game.bids.has("bot-1"), "the bot should have bid");

  // Undercut it.
  game.bid("host", game.optimal.moves);
  runFor(game, 500);

  game.lockBids("host");
  assert.equal(game.currentDemoId(), "host", "the lower bid goes first");
});

test("bot difficulty changes bid quality, speed, and nerve", () => {
  const casual = botLevel(1);
  const ruthless = botLevel(3);

  // Faster to commit.
  assert.ok(ruthless.think[1] < casual.think[0], "a hard bot bids before an easy one");
  // Tighter bids.
  assert.equal(ruthless.padding[1], 0, "a hard bot bids optimal");
  assert.ok(casual.padding[0] > 0, "an easy bot pads its bid");
  // Steadier hands.
  assert.ok(ruthless.fumble < casual.fumble, "a hard bot fumbles less");
});

test("an easy bot bids above optimal, a ruthless one bids exactly optimal", () => {
  const easy = soloGame({ botLevel: 1 });
  easy.start("host");
  assert.ok(
    easy.bots[0].bidValue > easy.optimal.moves,
    "casual bots leave room to be undercut"
  );

  const hard = soloGame({ botLevel: 3 });
  hard.start("host");
  assert.equal(hard.bots[0].bidValue, hard.optimal.moves);
});

test("a fumbling bot takes the penalty like anyone else", () => {
  const game = soloGame({ botLevel: 1 });
  game.start("host");

  // Force the fumble rather than waiting for the dice.
  game.bots[0].willFumble = true;
  game.bots[0].bidAt = Date.now();
  game.bots[0].bidValue = game.optimal.moves;

  runFor(game, 2000);
  game.voteResign("host");
  runFor(game, 30000);

  const bot = game.players.get("bot-1");
  assert.equal(bot.score, -1, "a bot that cannot show its line pays for it");
  assert.equal(game.lastRound.failures[0].id, "bot-1");
});

test("the bot only releases the clock when it actually has a vote", () => {
  const game = soloGame({ botLevel: 3 });
  game.addPlayer("alice", "Alice");
  game.start("host");

  runFor(game, 12000);
  assert.ok(game.bots[0].hasBid, "the bot should have bid by now");

  // Two humans are still searching, so the bot is not one of the voters and
  // must not be able to cut their thinking time short.
  assert.deepEqual(game.resignVoters().sort(), ["alice", "host"]);
  assert.equal(game.resignVotes.has("bot-1"), false);

  // Once everyone has committed, nobody is searching and the bot joins in.
  game.bid("host", 12);
  game.bid("alice", 12);
  runFor(game, 500);
  assert.ok(game.resignVotes.has("bot-1"), "with nobody searching, the bot agrees to move on");
});

test("every level is fully specified", () => {
  Object.values(BOT_LEVELS).forEach((level) => {
    assert.equal(typeof level.name, "string");
    assert.equal(level.think.length, 2);
    assert.ok(level.think[0] < level.think[1]);
    assert.equal(level.padding.length, 2);
    assert.ok(level.fumble >= 0 && level.fumble <= 1);
    assert.ok(level.moveDelay > 0);
  });
});
