/* HAMMER & SICKLE, and what "much more communist" turned out to mean.
 *
 * The move swings an emblem overhead for four damage and then closes the
 * difference between the two health bars. Until 2.81 it closed it by AT MOST
 * fifteen points, which made it a gesture: a man on one against a man on a
 * hundred came out on sixteen. The request was blunt -- "take more and give
 * more... if houston has one hp and the opponent has 100, it should be spread
 * to 40 and 60" -- and the rule that reproduces that sentence is four TENTHS
 * OF THE GAP, floored at the fifteen it used to cap at.
 *
 * WHY THIS FILE EXISTS RATHER THAN A LINE IN THE MOWER SUITE. Everything
 * here is about one expression in applyHit, and every one of its properties
 * is a "nothing bad happened" property: nobody overflows a bar, nobody is
 * killed by a heal, nobody past the midpoint, nobody else on the stage is
 * touched. Those pass beautifully when the harness is broken, so every one of
 * them has a mutant engine behind it that has to fail.
 *
 * THE INVARIANT IS THE OUTER `min`, AND IT IS WORTH SAYING WHICH ONE.
 * `Math.min(|gap| / 2, cap, max(least, |gap| * take))` -- the FIRST term is
 * the whole safety argument. Nothing can pass the midpoint of two numbers
 * that are each at or below the maximum, so nothing can overflow a bar and
 * nothing can finish a man the four damage did not already finish. That holds
 * for any `take` and any `least`, which is measured below rather than
 * asserted: `take: 0.6` does NOT break it, and a suite that claimed otherwise
 * would be protecting the wrong line. What 0.6 breaks is something else --
 * it makes the move an AVERAGE again -- and that has its own test.
 *
 * The engine source is loaded directly, the way the mower and milk suites do:
 * applyHit, `fighters`, `effects` and the ROSTER are all internals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

let __seedCounter = 0;
function seededMath() {
  let s = (0x5bf03635 ^ (++__seedCounter * 2654435761)) >>> 0 || 1;
  const M = Object.create(Math);
  M.random = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return M;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(HERE, "..", "assets", "js", "nerdwars");
const SPRITES_SRC = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {}, __on: {},
    getContext: () => new Proxy({}, {
      get: (t, k) => (k === "canvas" ? { width: 320, height: 180 }
        : k === "measureText" ? () => ({ width: 0 })
        : k === "createLinearGradient" || k === "createRadialGradient"
          ? () => ({ addColorStop() {} })
        : k in t ? t[k] : () => {}),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

async function bootEngine(engineSrc) {
  const view = stubCanvas(960, 540);
  const sandbox = {
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set,
    Number, String, Boolean, Error, DataView, ArrayBuffer, Uint8Array,
    Float32Array, Float64Array, isNaN, parseInt, parseFloat,
    requestAnimationFrame: () => {},
    innerWidth: 960, innerHeight: 540, addEventListener() {},
    Image: class {
      constructor() { this.complete = true; this.naturalWidth = 16; this.naturalHeight = 16; }
      set src(v) { if (this.onload) this.onload(); }
    },
    document: {
      getElementById: (id) => (id === "nw-canvas" || id === "game" ? view : null),
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener() {},
      documentElement: {},
      fullscreenElement: null,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SPRITES_SRC, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
                  { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return { run: (src) => vm.runInContext(src, sandbox) };
}

/* One line of the engine changed in memory, both halves asserted: a needle
   that is missing, or is there twice, makes a control that silently mutates
   nothing or mutates the wrong thing. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

function expectToFail(check, why) {
  try { check(); } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

const SP_UP = 2048;

/* Houston in seat 0 against whoever is named. `seat()` clears every timer
   that could eat an input or a frame, and `RULE` is the swing with its own
   damage taken off -- applyHit still runs the redistribution, so the sweeps
   below measure the rule and nothing else. */
async function arena(names, engineSrc) {
  const booted = await bootEngine(engineSrc);
  const { run } = booted;
  const who = names || ["houston", "reese"];
  const order = JSON.parse(run("JSON.stringify(ORDER)"));
  for (const k of who) assert.ok(order.indexOf(k) >= 0, "precondition: " + k + " is on the roster");
  run("select.cursor = [" +
      who.map((k) => order.indexOf(k)).join(", ") + "];" +
      " twoPlayer = true; playerCount = " + who.length + "; humanCount = 0;" +
      " stagePick = 0; practice = false; startBattle();");
  run("for (var i = 0; i < 90; i++) step();");
  assert.equal(run("fighters.length"), who.length,
    "precondition: the battle should have seated " + who.length + " fighters");
  assert.equal(run("fighters[0].key"), "houston",
    "precondition: houston should be in seat 0");
  run([
    "var MAIN, UP, RULE;",
    "UP = ROSTER.houston.specials.up;",
    /* The same spec object with its four damage taken off, so `share` is
       still the ROSTER's own by-reference copy and nothing else differs. */
    "RULE = Object.assign({}, UP, { damage: 0, base: 0, scale: 0 });",
    "function seat(gap) {",
    "  MAIN = STAGE.platforms.find(function (p) { return p.main; });",
    "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
    "  fighters.forEach(function (f, i) {",
    "    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;",
    "    f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;",
    "    f.grounded = true; f.y = MAIN.y; f.slick = 0; f.slickFoe = 0;",
    "    f.stocks = 9; f.health = 100; f.eliminated = false; f.combo = 0;",
    "    f.hasHit = false; f.attackFrame = 0; f.specialSpawned = false;",
    "    f.sinceHitFrames = 999; f.shield = COMBAT.shieldMax;",
    "    f.x = MAIN.x + 60 + i * (gap == null ? 10 : gap);",
    "    f.facing = i === 0 ? 1 : -1;",
    "  });",
    "  netplay.active = true;",
    "}",
    "function tick() {",
    "  var pads = [];",
    "  for (var i = 0; i < fighters.length; i++) pads.push(bitsToPad(arguments[i] || 0));",
    "  netplay.framePads = pads; step();",
    "}",
    /* One landed swing, with the victim pinned so the probe measures the
       move rather than the knockback it causes. */
    "function swing(a, b) {",
    "  seat(10);",
    "  fighters[0].health = a; fighters[1].health = b;",
    "  var big = 0;",
    "  tick(" + SP_UP + ", 0);",
    "  for (var i = 0; i < UP.startup + UP.active + 2; i++) {",
    "    fighters[1].invuln = 0;",
    "    fighters[1].x = fighters[0].x + 10; fighters[1].vx = 0; fighters[1].vy = 0;",
    "    fighters[1].y = MAIN.y; fighters[1].grounded = true;",
    "    tick(0, 0);",
    "    for (var e = 0; e < effects.length; e++) {",
    "      if (effects[e].kind === 'emblem' && effects[e].spec &&",
    "          effects[e].spec.big > 1) big = 1;",
    "    }",
    "  }",
    "  return [+fighters[0].health.toFixed(4), +fighters[1].health.toFixed(4), big];",
    "}",
    /* The rule on its own: no damage, no knockback, both bars set by hand. */
    "function share(a, b) {",
    "  seat(10);",
    "  fighters[0].health = a; fighters[1].health = b;",
    "  fighters[0].hitstop = 0; fighters[1].hitstop = 0;",
    "  effects.length = 0;",
    "  applyHit(fighters[0], fighters[1], RULE, fighters[0].x);",
    "  return [+fighters[0].health.toFixed(6), +fighters[1].health.toFixed(6)];",
    "}",
  ].join("\n"));
  return booted;
}

/* ===================================================================== */
/* 1. HIS OWN EXAMPLE                                                    */
/* ===================================================================== */

function checkExample(r) {
  assert.equal(r.one[0], 39,
    "one against a hundred has to come out at thirty-nine: the midpoint is " +
    "50.5, forty is four fifths of the way to it, and four tenths of the GAP " +
    "is the rule that reproduces it. He ended on " + r.one[0]);
  assert.equal(r.one[1], 58,
    "and the other man on fifty-eight -- 39 / 58 rather than 40 / 60 because " +
    "the fist's own four damage goes first, which is the only part of the " +
    "arithmetic that was not already true. He ended on " + r.one[1]);
  assert.ok(Math.abs(r.gapAfter) < Math.abs(r.gapBefore) / 4,
    "which closes the difference to about a fifth of what it was: " +
    r.gapBefore + " before, " + r.gapAfter + " after");
  assert.equal(r.parity[0], 48,
    "and at parity it is still a hit and a gift -- four damage, two handed " +
    "straight back: he ended on " + r.parity[0]);
  assert.ok(r.winning[0] < 100 && r.winning[0] - r.winning[1] > 0,
    "and a man on a hundred who lands it on a man on five GIVES: he came " +
    "out on " + r.winning[0] + " against " + r.winning[1]);
}

const EXAMPLE = "(function () {\n" +
  "  var one = swing(1, 100);\n" +
  "  var parity = swing(50, 50);\n" +
  "  var winning = swing(100, 5);\n" +
  "  return { one: one, parity: parity, winning: winning,\n" +
  "           gapBefore: 99, gapAfter: +(one[1] - one[0]).toFixed(2) };\n" +
  "})()";

test("one and a hundred becomes forty and sixty, less the fist's own four",
  async () => {
    const { run } = await arena();
    checkExample(run(EXAMPLE));
  });

test("control: the fifteen-point cap this replaces fails his own example",
  async () => {
    /* `take: 0.5, least: 15, cap: 15` IS the shipping rule written in the new
       shape -- min(|gap|/2, 15, max(15, |gap|/2)) is min(|gap|/2, 15) at
       every gap -- so this control restores the move that was there rather
       than inventing a broken one. */
    const off = await arena(null, sabotage(
      "      share: { take: 0.4, least: 15, cap: 40 },",
      "      share: { take: 0.5, least: 15, cap: 15 },"));
    expectToFail(() => checkExample(off.run(EXAMPLE)),
      "a fifteen-point cap leaves him on sixteen and should fail his example");
  });

/* ===================================================================== */
/* 2. THE INVARIANT                                                      */
/* ===================================================================== */

function checkInvariant(r) {
  assert.ok(r.fired > 500,
    "precondition: the sweep has to have actually moved health; it fired " +
    r.fired + " times");
  assert.equal(r.overflow, 0,
    "nobody may end above maxHealth. " + r.overflow + " pairs did");
  assert.equal(r.killed, 0,
    "and nothing that SHARED may end a man: health only ever moves toward " +
    "the midpoint, so the richer man is left at the midpoint at worst, which " +
    "is at least what the poorer one had. " + r.killed + " pairs ended at or " +
    "below zero");
  assert.equal(r.crossed, 0,
    "and the attacker may never pass the midpoint -- that single `min` " +
    "against half the gap IS the invariant, and it is why neither clamp you " +
    "would expect exists. " + r.crossed + " pairs crossed it");
  /* And nobody is left worse off than the worst bar the sweep started with.
     The poorer man only ever rises, so the floor of the whole grid is the
     floor of its inputs; anything under it would mean health leaked out of
     the pair rather than moving inside it. */
  assert.ok(r.lowest >= 1,
    "lowest bar left standing over the whole sweep: " + r.lowest +
    ", against a lowest starting bar of 1");
}

const SWEEP = "(function () {\n" +
  "  var overflow = 0, killed = 0, crossed = 0, fired = 0, lowest = 999;\n" +
  "  for (var a = 1; a <= 100; a += 3) {\n" +
  "    for (var b = 1; b <= 100; b += 3) {\n" +
  "      var r = share(a, b);\n" +
  "      var moved = r[0] - a;\n" +
  "      if (moved !== 0) fired++;\n" +
  "      if (r[0] > COMBAT.maxHealth + 1e-9 || r[1] > COMBAT.maxHealth + 1e-9) overflow++;\n" +
  "      if (moved !== 0 && (r[0] <= 0 || r[1] <= 0)) killed++;\n" +
  "      var mid = (a + b) / 2;\n" +
  "      if ((b > a ? r[0] - mid : mid - r[0]) > 1e-9) crossed++;\n" +
  "      lowest = Math.min(lowest, r[0], r[1]);\n" +
  "    }\n" +
  "  }\n" +
  "  return { overflow: overflow, killed: killed, crossed: crossed,\n" +
  "           fired: fired, lowest: +lowest.toFixed(2) };\n" +
  "})()";

test("the hammer never overflows a bar and never crosses the middle",
  async () => {
    const { run } = await arena();
    checkInvariant(run(SWEEP));
  });

test("control: without the min against half the gap it does both", async () => {
  /* THE MUTANT IS THE LINE ITSELF, minus its first term. This is the control
     that matters: `take` is the number somebody will retune next, and what
     keeps a bigger `take` safe is not the size of `take`, it is this `min`.
     Measured off the engine: with the half-gap term in place, take 0.6
     crosses the midpoint 0 times out of 10,000 pairs; with it deleted, 9,480
     crossings and 210 overflows. */
  const off = await arena(null, sabotage(
    "    const moved = Math.sign(gap) * Math.min(Math.abs(gap) / 2, move.share.cap,\n" +
    "                    Math.max(move.share.least, Math.abs(gap) * move.share.take));",
    "    const moved = Math.sign(gap) * Math.min(move.share.cap,\n" +
    "                    Math.max(move.share.least, Math.abs(gap) * move.share.take));"));
  expectToFail(() => checkInvariant(off.run(SWEEP)),
    "a transfer that is not capped at half the gap should overflow and cross");
});

/* ===================================================================== */
/* 3. IT IS NOT AN AVERAGE, AND IT IS AT LEAST AS COMMUNIST AS IT WAS     */
/* ===================================================================== */

function checkPiecewise(r) {
  assert.ok(r.worstShortfall >= -1e-9,
    "the new rule has to move at least as much as the old fifteen-point one " +
    "at EVERY gap -- `least` is that fifteen kept as the floor rather than " +
    "the ceiling, because four tenths of a small gap is less than levelling " +
    "it and the request was for more, not less. The worst case moved " +
    r.worstShortfall.toFixed(3) + " less than it used to");
  assert.equal(r.levelled30, true,
    "under a gap of thirty it still LEVELS them, exactly as before");
  /* AND OVER THIRTY-SEVEN AND A HALF IT LEAVES THEM A FIFTH APART, which is
     arithmetic rather than feel: closing by two lots of four tenths closes
     eight tenths of the gap, so a fifth of it is what is left standing. A
     move that LEVELS every gap is an average, and an average decides a match
     the first time it connects -- 12 against 100 becomes 56 and 56. */
  for (const c of r.wide) {
    assert.equal(c.moved, +(c.gap * 0.4).toFixed(4),
      "four tenths of a gap of " + c.gap + " is " + (c.gap * 0.4).toFixed(2) +
      " and that is what has to change hands; " + c.moved + " did");
    assert.equal(c.apart, +(c.gap / 5).toFixed(4),
      "which leaves them a fifth of it apart -- " + (c.gap / 5).toFixed(2) +
      " at a gap of " + c.gap + "; they came out " + c.apart + " apart");
  }
}

const PIECEWISE = "(function () {\n" +
  "  var worst = 1e9;\n" +
  "  for (var g = 0; g <= 99; g++) {\n" +
  "    var r = share(1, 1 + g);\n" +
  "    var moved = r[0] - 1;\n" +
  "    var old = Math.min(g / 2, 15);\n" +
  "    worst = Math.min(worst, moved - old);\n" +
  "  }\n" +
  "  var small = share(1, 31);\n" +
  "  var wide = [40, 50, 70, 99].map(function (g) {\n" +
  "    var r = share(1, 1 + g);\n" +
  "    return { gap: g, moved: +(r[0] - 1).toFixed(4),\n" +
  "             apart: +(r[1] - r[0]).toFixed(4) };\n" +
  "  });\n" +
  "  return { worstShortfall: worst, wide: wide,\n" +
  "           levelled30: Math.abs(small[1] - small[0]) < 1e-9 };\n" +
  "})()";

test("it is at least as communist as it was, and it is still not an average",
  async () => {
    const { run } = await arena();
    checkPiecewise(run(PIECEWISE));
  });

test("control: dropping `least` makes it a nerf below a gap of thirty-seven",
  async () => {
    const off = await arena(null, sabotage(
      "      share: { take: 0.4, least: 15, cap: 40 },",
      "      share: { take: 0.4, least: 0, cap: 40 },"));
    expectToFail(() => checkPiecewise(off.run(PIECEWISE)),
      "four tenths of a small gap moves less than levelling it, and should " +
      "fail the at-least-as-communist test");
  });

test("control: `take` at six tenths turns it back into an average", async () => {
  /* And this is what 0.6 actually costs, which is not the invariant: four
     tenths of the gap is less than half of it, six tenths is more, so the
     outer `min` binds at every gap and the move levels everything again. The
     safety argument survives `take`; the GAME does not. */
  const off = await arena(null, sabotage(
    "      share: { take: 0.4, least: 15, cap: 40 },",
    "      share: { take: 0.6, least: 15, cap: 40 },"));
  checkInvariant(off.run(SWEEP));
  expectToFail(() => checkPiecewise(off.run(PIECEWISE)),
    "at six tenths every gap is levelled and the not-an-average test should " +
    "have failed");
});

/* ===================================================================== */
/* 4. A RAISED SHIELD REFUSES IT                                         */
/* ===================================================================== */

function checkShield(r) {
  assert.equal(r.attacker, 1,
    "a shielded swing must not redistribute anything: the share sits below " +
    "the shield branch, so it is stopped exactly the way the burn is. He " +
    "went from 1 to " + r.attacker);
  assert.equal(r.defender, 100,
    "and the man behind the shield keeps every point; he ended on " + r.defender);
  assert.ok(r.shieldSpent > 0,
    "while the shield still takes the hit -- it is blocked, not ignored: " +
    "the shield lost " + r.shieldSpent);
}

const SHIELD = "(function () {\n" +
  "  seat(10);\n" +
  "  fighters[0].health = 1; fighters[1].health = 100;\n" +
  "  fighters[1].setState('shield'); fighters[1].shield = COMBAT.shieldMax;\n" +
  "  var s0 = fighters[1].shield;\n" +
  "  applyHit(fighters[0], fighters[1], UP, fighters[0].x);\n" +
  "  return { attacker: +fighters[0].health.toFixed(4),\n" +
  "           defender: +fighters[1].health.toFixed(4),\n" +
  "           shieldSpent: +(s0 - fighters[1].shield).toFixed(3) };\n" +
  "})()";

test("a raised shield refuses the redistribution outright", async () => {
  const { run } = await arena();
  checkShield(run(SHIELD));
});

test("control: with the shield branch gone the block shares anyway", async () => {
  const off = await arena(null, sabotage(
    "  if (defender.state === 'shield' && defender.shield > 0) {",
    "  if (false && defender.shield > 0) {"));
  expectToFail(() => checkShield(off.run(SHIELD)),
    "a shielded man who still hands over health should fail the shield test");
});

/* ===================================================================== */
/* 5. IT TAKES FROM THE MAN IT HITS                                      */
/* ===================================================================== */

function checkCrowd(r) {
  assert.equal(r.bystanders, r.bystandersBefore,
    "the fist takes from whoever it LANDS on, not from the richest man on " +
    "the stage: the two bystanders were " + r.bystandersBefore + " and came " +
    "out " + r.bystanders + ". resolveCombat breaks on the first overlap and " +
    "latches hasHit, and a three-way redistribution would break the pairwise " +
    "invariant and be a kingmaker in a four-way");
  assert.ok(Math.abs(r.after[0] - r.after[1]) < 1e-6,
    "and the pair it did land on comes out level, because their gap is " +
    "under thirty: " + r.after[0] + " and " + r.after[1]);
  assert.ok(r.after[0] > 0 && r.after[1] > 0,
    "with nobody driven under zero by it");
}

const CROWD = "(function () {\n" +
  "  seat(10);\n" +
  "  fighters[0].health = 5; fighters[1].health = 20;\n" +
  "  fighters[2].health = 100; fighters[3].health = 40;\n" +
  "  var before = [fighters[2].health, fighters[3].health];\n" +
  "  applyHit(fighters[0], fighters[1], UP, fighters[0].x);\n" +
  "  return { after: [+fighters[0].health.toFixed(4), +fighters[1].health.toFixed(4)],\n" +
  "           bystandersBefore: JSON.stringify(before),\n" +
  "           bystanders: JSON.stringify([fighters[2].health, fighters[3].health]) };\n" +
  "})()";

test("the fist takes from the man it hits, not the richest man on the stage",
  async () => {
    const { run } = await arena(["houston", "reese", "kel", "trev"]);
    checkCrowd(run(CROWD));
  });

test("control: sizing the transfer off the whole stage kills the man he hit",
  async () => {
    /* The mutant is the version somebody would reach for if they read the
       move as "level the scoreline": measure the gap against the richest
       fighter alive. It takes thirty-eight off a man on sixteen. */
    const off = await arena(["houston", "reese", "kel", "trev"], sabotage(
      "    const gap = defender.health - attacker.health;",
      "    let rich = defender;\n" +
      "    for (const f of fighters) if (!f.eliminated && f.health > rich.health) rich = f;\n" +
      "    const gap = rich.health - attacker.health;"));
    expectToFail(() => checkCrowd(off.run(CROWD)),
      "a transfer sized off the richest man on the stage should fail the " +
      "crowd test");
  });

/* ===================================================================== */
/* 6. THE TELL                                                           */
/* ===================================================================== */

function checkTell(r) {
  assert.equal(r.big.gainerRing, r.gold,
    "the ring on whoever GAINED has to be the emblem's gold; it was " +
    r.big.gainerRing);
  assert.equal(r.big.giverRing, r.red,
    "and the ring on whoever GAVE has to be the emblem's red. Two gold rings " +
    "meant 'I took thirty-eight' and 'I gave thirty-eight' with the same " +
    "picture, which for a move that is a gift exactly when you are winning " +
    "is the one thing the tell had to say. It was " + r.big.giverRing);
  assert.ok(r.big.sparks > r.small.sparks,
    "and the stream between them is sized by the amount: " + r.big.sparks +
    " sparks on a thirty-eight-point swing against " + r.small.sparks +
    " on a two-point one");
  assert.equal(r.big.emblem, 2,
    "a swing that moves thirty or more -- twice the whole of what this move " +
    "could ever do before -- draws the emblem at the midpoint at twice the " +
    "size; it drew at " + r.big.emblem);
  assert.equal(r.small.emblem, 0,
    "and an ordinary one does not, or it stops being an event");
  assert.equal(r.big.hitstop, r.heavy,
    "and it lands as an event rather than as a number changing: four extra " +
    "frames of hitstop, symmetric. The hammer's own knockback is far under " +
    "the line applyHit splits on, so without this the biggest thing in the " +
    "game reads with the same three frames as a poke. It read " + r.big.hitstop);
  assert.equal(r.small.hitstop, r.light,
    "while an ordinary share keeps the light hitstop it always had");
}

const TELL = "(function (a, b) {\n" +
  "  seat(10);\n" +
  "  fighters[0].health = a; fighters[1].health = b;\n" +
  "  fighters[0].hitstop = 0; fighters[1].hitstop = 0;\n" +
  "  effects.length = 0;\n" +
  "  applyHit(fighters[0], fighters[1], RULE, fighters[0].x);\n" +
  "  var moved = fighters[0].health - a;\n" +
  "  var gainer = moved > 0 ? fighters[0] : fighters[1];\n" +
  "  var giver = moved > 0 ? fighters[1] : fighters[0];\n" +
  "  var rings = effects.filter(function (e) { return e.kind === 'ring'; });\n" +
  "  function ringOn(f) {\n" +
  "    var hit = rings.filter(function (e) { return Math.abs(e.x - f.x) < 0.001; });\n" +
  "    return hit.length ? hit[0].color : null;\n" +
  "  }\n" +
  "  var em = effects.filter(function (e) { return e.kind === 'emblem'; });\n" +
  "  return { moved: +moved.toFixed(3),\n" +
  "           gainerRing: ringOn(gainer), giverRing: ringOn(giver),\n" +
  "           sparks: effects.filter(function (e) { return e.kind === 'spark'; }).length,\n" +
  "           emblem: em.length ? ((em[0].spec && em[0].spec.big) || 1) : 0,\n" +
  "           hitstop: fighters[0].hitstop,\n" +
  "           symmetric: fighters[0].hitstop === fighters[1].hitstop };\n" +
  "})";

const TELL_ALL = "(function () {\n" +
  "  return { big: (" + TELL + ")(1, 100), small: (" + TELL + ")(48, 52),\n" +
  "           gold: EMBLEM_GOLD, red: EMBLEM_RED,\n" +
  "           heavy: COMBAT.hitstopHeavy, light: COMBAT.hitstopLight };\n" +
  "})()";

test("the tell says which way the health went, and how much of it", async () => {
  const { run } = await arena();
  const r = run(TELL_ALL);
  assert.ok(r.big.moved > 30, "precondition: the big swing moves thirty or more");
  assert.ok(r.small.moved > 0 && r.small.moved < 5,
    "precondition: the small one moves a couple of points");
  assert.equal(r.big.symmetric, true,
    "the extra hitstop has to be symmetric, or the two men leave the moment " +
    "at different times");
  checkTell(r);
});

test("control: two gold rings say nothing about which way it went", async () => {
  const off = await arena(null, sabotage(
    "      addEffect('ring', giver.x, giver.y - 8, EMBLEM_RED);",
    "      addEffect('ring', giver.x, giver.y - 8, EMBLEM_GOLD);"));
  expectToFail(() => checkTell(off.run(TELL_ALL)),
    "a giver painted in the gainer's colour should fail the tell test");
});

test("control: the heavy hitstop written in the share block is overwritten",
  async () => {
    /* NOT A STRAW MAN -- it is where this line was first written, and the
       assignment further down applyHit silently undid it. The share block
       runs a long way above the hitstop the whole function ends with. */
    const off = await arena(null, sabotage(
      "  if (bigShare) {\n" +
      "    attacker.hitstop = COMBAT.hitstopHeavy;\n" +
      "    defender.hitstop = COMBAT.hitstopHeavy;\n" +
      "  }",
      "  if (bigShare) { /* moved up into the share block, where it is lost */ }"));
    expectToFail(() => checkTell(off.run(TELL_ALL)),
      "a bar-emptying swing with a poke's three frames should fail the tell " +
      "test");
  });

/* ===================================================================== */
/* 7. IT SURVIVES A REWIND                                               */
/* ===================================================================== */

test("the redistribution survives a rewind, and adds no field to anybody",
  async () => {
    /* This passes today and is expected to: `take` and `least` live inside
       the `share` object literal, which simFrozen keeps by reference, and
       `health` is already snapshotted and already in the desync hash. The
       test is here for whoever moves either number onto the Fighter next --
       that is the change this catches, and it is the property the roster
       comment says has to survive the next rewrite. */
    const { run } = await arena();
    const r = run("(function () {\n" +
      "  seat(10);\n" +
      "  fighters[0].health = 1; fighters[1].health = 100;\n" +
      "  var snap = saveSim();\n" +
      "  function play() {\n" +
      "    applyHit(fighters[0], fighters[1], UP, fighters[0].x);\n" +
      "    for (var i = 0; i < 10; i++) tick(0, 0);\n" +
      "    return stateHash();\n" +
      "  }\n" +
      "  var h1 = play(), end1 = [fighters[0].health, fighters[1].health];\n" +
      "  restoreSim(snap);\n" +
      "  var back = [fighters[0].health, fighters[1].health];\n" +
      "  var h2 = play(), end2 = [fighters[0].health, fighters[1].health];\n" +
      "  var onFighter = ['share', 'take', 'least'].filter(function (k) {\n" +
      "    return Object.prototype.hasOwnProperty.call(fighters[0], k); });\n" +
      "  return { h1: h1, h2: h2, back: JSON.stringify(back),\n" +
      "           end1: JSON.stringify(end1), end2: JSON.stringify(end2),\n" +
      "           onFighter: JSON.stringify(onFighter) };\n" +
      "})()");
    assert.equal(r.back, "[1,100]",
      "precondition: the rewind has to put both bars back where they were; " +
      "they came back " + r.back);
    assert.equal(r.end2, r.end1,
      "and the replay has to land on the same two numbers: " + r.end1 +
      " then " + r.end2);
    assert.equal(r.h2, r.h1,
      "bit-identically. State hash " + r.h1 + " first time, " + r.h2 + " after");
    assert.equal(r.onFighter, "[]",
      "and none of the three numbers may live on the Fighter -- they are in " +
      "the ROSTER literal, which simFrozen keeps by reference, which is why " +
      "this item adds no field to anything. Found: " + r.onFighter);
  });
