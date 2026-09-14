/* SLOTS: the draw underneath the machine, and the payout table over it.
 *
 * reelSymbol() is the whole of the move's randomness -- one call per reel,
 * from a seed made of battleFrames and the seat. It was a bare xorshift
 * finished with `% 4`, and between those two things a spin nobody stopped by
 * hand could not show three alike AT ALL.
 *
 * Nothing about it looked wrong from inside. Each reel on its own was
 * perfectly uniform -- 25/25/25/25 across the four symbols, which is the
 * measurement anybody would reach for first and the one that passes. The
 * defect was BETWEEN the reels: xorshift is linear over the bits, so the two
 * low bits that `% 4` reads moved in lockstep with the per-reel offset added
 * into the seed. The three draws were welded to each other. Measured over
 * forty thousand casts at the auto-stop frames they agreed pairwise 15.5% of
 * the time against a fair 25%, and all three agreed 0.00% -- not rarely,
 * NEVER.
 *
 * So the FIRST half of this file measures the one thing a per-reel check
 * cannot see: whether the three draws are independent of each other. It is a
 * statistical property and it is asserted statistically -- forty thousand
 * casts, the same seed the engine builds, the frames the reels land on when
 * nobody touches them, and generous tolerances, because the point is not to
 * pin the third decimal. The point is that three draws agree about 6.25% of
 * the time instead of never, and the assertion is written so the old hash
 * misses it by the width of the whole property.
 *
 * The SECOND half is the payout, which is a different question and is now
 * answered somewhere else. Four symbols over three independent reels pay
 * three of a kind 6.25% of the time and no weighting of four symbols pays
 * the 15 / 50 / 35 the machine is supposed to pay -- so reelLand() picks the
 * CLASS of the result off the seed first and lets the draw pick the SYMBOL.
 * Reel one is still exactly what the player stopped it on, a pair is always
 * a pair OF that symbol, and a bust is three different ones. The draws are
 * still independent; they are simply no longer what decides whether the
 * machine pays. That is why the census below is about the DRAW and says
 * nothing about the jackpot, and why the payout has a census of its own at
 * the bottom of the file.
 *
 * The samplers call the engine's own reelSymbol and reelLand rather than
 * copies, and the cast in the middle pins that the frames they are fed are
 * the frames the real move feeds them: forty thousand casts through step()
 * would take minutes, and forty thousand casts of a function that has
 * drifted away from the move would take none and mean nothing.
 *
 * This loads the engine source, as nerdwars-kel-buff.test.js does, because
 * reelSymbol, reelLand, battleFrames and the reel state are all internals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

/* Each vm gets its own Math.random stream. Every harness in this suite hands
   the sandbox the HOST's Math, so without this they all draw from one shared
   sequence -- and node --test runs files concurrently, which makes the
   interleaving, and therefore any test that averages over AI behavior,
   different on every run. Math remains the prototype, so everything else on
   it still works. */
let __seedCounter = 0;
function seededMath() {
  let s = (0x9e3779b9 ^ (++__seedCounter * 2654435761)) >>> 0 || 1;
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
const SPRITES = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

/* Stores what is written to it, unlike a discard-everything stub: the engine
   reads back properties it sets (fillStyle, globalAlpha), and a test cannot
   install a spy on a context that throws writes away. */
function stubContext() {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "measureText") return () => ({ width: 0 });
      if (key === "canvas") return { width: 0, height: 0 };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {},
    getContext: () => stubContext(),
    /* Kept rather than thrown away, so a test can deliver a real mousedown to
       the engine's own listener instead of reaching past it. Everything the
       menus do with a mouse -- mapping a client point onto the canvas, hit
       testing the rects the last frame registered, running the action -- is
       behind this one handler, and a test that calls the action directly is
       testing none of it. */
    __on: {},
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

/* `engineSrc` is the one addition to the shared harness: the source to run
   instead of the file on disk, which is how a negative control boots its
   sabotaged copy without that copy ever touching the disk. */
async function bootEngine(engineSrc) {
  const view = stubCanvas(960, 540);
  const sandbox = {
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set, Number,
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float32Array,
    Float64Array, isNaN, parseInt, parseFloat,
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
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
    { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

const tapKey = (run, code) => run(`(function () {
  held.clear(); prevHeld.clear(); held.add(${JSON.stringify(code)});
  step();
  held.clear(); prevHeld.clear();
  return scene;
})()`);

/* ------------------------------------------------------------------ */

/* A copy of the engine with exactly one passage changed, built in memory for
   a negative control. The needle has to be found exactly once: a needle that
   is missing would boot the real engine and pass the control for nothing,
   and one that matches twice would change a line the control never meant
   to. Both are the silent-no-op failure that string edits to this file are
   known for, so both are refused loudly here. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker the real test ran,
   and it has to throw an assertion. Anything else thrown is a broken checker,
   not a failed test, and is let through.

   `wanted` is a fragment of the assertion that was supposed to be the one to
   go, and it is how a control proves it controls anything. A sabotage that
   trips some OTHER assertion is green here and tells you nothing: the
   assertion it was meant to guard could have stopped working entirely and
   the control would never notice. The message comes back either way so a
   control can print what it actually saw. */
function expectToFail(check, why, wanted) {
  try {
    check();
  } catch (e) {
    if (e instanceof assert.AssertionError) {
      if (wanted) {
        assert.ok(e.message.indexOf(wanted) >= 0,
          "the control should have failed on " + JSON.stringify(wanted) +
          " and failed on something else instead: " + e.message);
      }
      return e.message;
    }
    throw e;
  }
  assert.fail(why);
}

async function simonVsReese(engine) {
  const run = await bootEngine(engine);
  run("select.cursor=[7,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters.map(function (f) { return f.key; }).join(',')"),
    "simon,reese", "precondition: ORDER should seat Simon at 7 and Reese at 4");
  return run;
}

/* ------------------------------------------------------------------ */
/* The census of the DRAW.                                              */

/* Forty thousand consecutive casts from seat 0 -- battleFrames 0, 1, 2 ...
   through the engine's own seed arithmetic -- each one read at the frames
   the three reels land on when nobody stops them. The seed is written out
   here rather than taken from the engine so that a change to the SEED is a
   change this file argues with too; the cast below is what keeps the two
   honest.

   reelSymbol and not reelLand, deliberately: this is the raw draw, before
   the payout table bends reels two and three. The draw is still what decides
   the one symbol the player actually chooses (reel one is his, untouched)
   and still what the bust and the odd reel pick out of, so a welded draw
   would still be a broken machine -- it would simply be broken quietly now
   instead of paying no jackpots at all.

   Forty thousand because that is what the before-and-after in the engine was
   measured over, so the numbers here are the numbers in that comment. Twenty
   would do: three draws alike at 6.25% is about 1,250 hits and the old hash
   scores zero, and no sample size makes zero look like 1,250. */
const CASTS = 40000;
const SEAT = 0;

const CENSUS = `(function () {
  var s = ROSTER.simon.specials.down;
  var reels = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  var pairs = [0, 0, 0], three = 0, bad = 0;
  function tally(row, v) { if (v === 0 || v === 1 || v === 2 || v === 3) row[v]++; else bad++; }
  for (var f = 0; f < ${CASTS}; f++) {
    var seed = ((f * 2654435761) ^ (${SEAT} * 40503) ^ 0x9e3779b9) >>> 0;
    var a = reelSymbol(seed, 0, s.autoStop[0], s);
    var b = reelSymbol(seed, 1, s.autoStop[1], s);
    var c = reelSymbol(seed, 2, s.autoStop[2], s);
    tally(reels[0], a); tally(reels[1], b); tally(reels[2], c);
    if (a === b) pairs[0]++;
    if (a === c) pairs[1]++;
    if (b === c) pairs[2]++;
    if (a === b && b === c) three++;
  }
  return JSON.stringify({ n: ${CASTS}, reels: reels, pairs: pairs,
                          three: three, bad: bad });
})()`;

const pct = (n, of) => (100 * n) / of;
const show = (n, of) => pct(n, of).toFixed(2) + "%";

/* Named, because which pair disagrees says which half of the old hash is
   back: a linear mixer put the first two reels 23 points apart and the last
   two only 8. */
const PAIRS = ["reels 1 and 2", "reels 1 and 3", "reels 2 and 3"];

function checkCensus(r) {
  assert.ok(r.n >= 20000,
    "precondition: a statistical claim needs a sample; this was " + r.n + " casts");
  assert.equal(r.bad, 0,
    "precondition: a reel shows one of four symbols and nothing else; " + r.bad +
    " calls came back outside 0-3");

  /* 1. Each reel on its own. This is the measurement that passed all along
     and it is kept because it is still a thing that has to be true -- and
     because a fix that bought independence by biasing a reel would show up
     here and nowhere else. */
  for (let i = 0; i < 3; i++) {
    const row = r.reels[i];
    assert.equal(row[0] + row[1] + row[2] + row[3], r.n,
      "precondition: every cast lands somewhere on reel " + (i + 1));
    for (let sym = 0; sym < 4; sym++) {
      assert.ok(Math.abs(pct(row[sym], r.n) - 25) <= 1.5,
        "each reel shows each of its four symbols a quarter of the time; reel " +
        (i + 1) + " showed symbol " + sym + " " + show(row[sym], r.n) +
        " of " + r.n + " casts");
    }
  }

  /* 2. Each PAIR of reels. This is the one the old hash failed: uniform
     reels welded to each other, agreeing 2%, 33% and 17% of the time instead
     of a quarter each. Two reels that are independent agree exactly as often
     as the second one happens to land on the first one's symbol -- a
     quarter -- and any other number means they are not independent. */
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(pct(r.pairs[i], r.n) - 25) <= 1.5,
      "any two reels agree a quarter of the time if they are independent; " +
      PAIRS[i] + " agreed " + show(r.pairs[i], r.n) + " of " + r.n + " casts");
  }

  /* 3. And all three at once. `three > 0` is the regression, stated on its
     own and first: the old hash scored ZERO over forty thousand casts, which
     is not a rare draw, it is three draws welded into one. */
  assert.ok(r.three > 0,
    "three draws alike has to be REACHABLE at the frames a spin nobody touched " +
    "lands on -- it came up " + r.three + " times in " + r.n + " casts, and the " +
    "hash this test was written for scored zero, which is the bug it exists for");
  assert.ok(Math.abs(pct(r.three, r.n) - 6.25) <= 1,
    "and it comes up about 6.25% of the time -- one in sixteen, four ways out " +
    "of sixty-four; it came up " + show(r.three, r.n) + ". This is the DRAW, not " +
    "the payout: the machine's own 15% jackpot is reelClass's doing and is " +
    "measured at the bottom of this file");
}

test("the three raw draws are independent of each other, and three can agree on their own", async (t) => {
  const run = await bootEngine();
  const r = JSON.parse(run(CENSUS));
  t.diagnostic("reels " + r.reels.map((row) => row.map((c) => show(c, r.n)).join("/")).join("  ") +
    " | pairs " + r.pairs.map((c) => show(c, r.n)).join("/") +
    " | three of a kind " + show(r.three, r.n) + " (" + r.three + " of " + r.n + ")");
  checkCensus(r);
});

/* The two bugs, put back one at a time. Both needles are anchored across
   several lines of the function body so that neither can be a substring of
   anything else, and sabotage() refuses a needle it finds twice. */

const OLD_MIXER =
  "  let h = seed >>> 0;\n" +
  "  h = Math.imul(h ^ ((reel * 0x9e3779b1) >>> 0), 0x85ebca6b) >>> 0;\n" +
  "  h = Math.imul(h ^ ((Math.floor(t / s.reelEvery) * 0x7feb352d) >>> 0), 0xc2b2ae35) >>> 0;\n" +
  "  h ^= h >>> 15;\n" +
  "  h = Math.imul(h, 0x846ca68b) >>> 0;\n" +
  "  h ^= h >>> 16;\n";

const XORSHIFT =
  "  let h = (seed + reel * 7919 + Math.floor(t / s.reelEvery) * 104729) >>> 0;\n" +
  "  h ^= h << 13; h >>>= 0;\n" +
  "  h ^= h >>> 17;\n" +
  "  h ^= h << 5; h >>>= 0;\n";

test("negative control: the hash it replaced never draws three alike on its own", async (t) => {
  /* The whole of the old function: the linear mixer AND `% 4`. This is the
     shipped bug, and the assertion it has to fail is the one about three
     draws agreeing being reachable at all. */
  const run = await bootEngine(sabotage(OLD_MIXER + "  return h >>> 30;\n",
                                        XORSHIFT + "  return h % 4;\n"));
  const r = JSON.parse(run(CENSUS));
  t.diagnostic("old hash read pairs " + r.pairs.map((c) => show(c, r.n)).join("/") +
    ", three of a kind " + r.three + " of " + r.n +
    ", reel 1 " + r.reels[0].map((c) => show(c, r.n)).join("/"));
  assert.equal(r.three, 0,
    "the old hash should never draw three alike on an untouched spin; it drew " +
    r.three);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(pct(r.reels[0][i], r.n) - 25) <= 1.5,
      "and each reel alone should still look perfectly fair, which is why nobody " +
      "caught this: reel 1 symbol " + i + " read " + show(r.reels[0][i], r.n));
  }
  expectToFail(() => checkCensus(r),
    "with the old hash back the census should fail; it passed");
});

test("negative control: a linear mixer welds the draws together even off the top bits", async (t) => {
  /* Half the fix undone: the good two bits are still the ones being read,
     but the mixing that earns them is back to an add and a bare xorshift.
     Each draw stays uniform and the pairs fall apart anyway -- which is the
     whole reason this file measures pairs and not reels. */
  const run = await bootEngine(sabotage(OLD_MIXER, XORSHIFT));
  const r = JSON.parse(run(CENSUS));
  t.diagnostic("linear mixer read pairs " + r.pairs.map((c) => show(c, r.n)).join("/") +
    ", three of a kind " + show(r.three, r.n) + " (" + r.three + " of " + r.n + ")");
  assert.ok(r.pairs.some((c) => Math.abs(pct(c, r.n) - 25) > 5),
    "the sabotage should put at least one pair far off a quarter; they read " +
    r.pairs.map((c) => show(c, r.n)).join("/"));
  expectToFail(() => checkCensus(r),
    "with a linear mixer the census should fail; it passed");
});

/* ------------------------------------------------------------------ */
/* And the frames the census feeds it are the frames the move feeds it.  */

/* One real cast of the SLOTS, driven through the pad and left alone, so
   every reel lands on its own. What this pins is the join between the
   censuses and the engine: the seed is built the way they build it, the
   reels land on the frames they sample, and the three symbols that come out
   are exactly the three they would have modeled. Without this, a change to
   the seed or to `autoStop` would leave forty thousand perfectly independent
   samples of a function nothing calls that way.

   The model is reelLand and no longer three bare reelSymbol calls. That is
   the repair: reels two and three are bent to reel one now, so a model that
   draws them independently gets a different answer from the machine for
   every cast that is not a bust, and this test failed on a 3,3,3 the engine
   was right about. reelLand has to be driven the way the move drives it --
   in order, each call handed what has landed so far -- because the reels it
   reads back are how it knows what the pair is a pair OF. */
const SP_DOWN = 1024;

const CAST = `(function () {
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var DOWN = ROSTER.simon.specials.down;
  projectiles.length = 0; effects.length = 0;
  freezeFrames = 0; banner = null;
  [me, foe].forEach(function (f) {
    f.setState('idle');
    f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
    f.invuln = 0; f.mana = 999; f.vx = 0; f.vy = 0;
    f.grabbing = -1; f.grabbedBy = -1; f.grabTimer = 0; f.grounded = true;
    f.specialSpawned = false; f.hasHit = false; f.attackFrame = 0;
    f.stocks = 99; f.health = 100; f.drowsy = 0;
    f.reels = [-1, -1, -1]; f.reelT = 0; f.reelStops = 0; f.reelSeed = 0;
    f.y = main.y; f.prevY = main.y;
  });
  me.x = main.x + 40; me.facing = 1;
  foe.x = main.x + main.w - 30; foe.facing = -1;
  foe.invuln = 9999;

  var log = [];
  netplay.active = true;
  for (var i = 0; i < 140; i++) {
    me.hitstop = 0; me.mana = 999;
    // battleFrames as runSpecial will see it: the counter is bumped at the
    // END of updateBattle, so the value going into this step is the one the
    // seed is made of.
    var bf = battleFrames;
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_DOWN} : 0), bitsToPad(0)];
    step();
    log.push({ bf: bf, st: me.state, af: me.attackFrame, seed: me.reelSeed,
               t: me.reelT, reels: me.reels.join(',') });
  }
  netplay.active = false; netplay.framePads = null;
  var seed = me.reelSeed;
  // The same three landings, modeled: in order, each call handed what has
  // landed so far, because that is the only way reelLand can be asked.
  var model = [-1, -1, -1];
  for (var j = 0; j < 3; j++) model[j] = reelLand(seed, j, DOWN.autoStop[j], DOWN, model);
  return JSON.stringify({ log: log, slot: me.slot, seed: seed,
    startup: DOWN.startup, autoStop: DOWN.autoStop.slice(),
    stop0: reelSymbol(seed, 0, DOWN.autoStop[0], DOWN),
    modeled: model.join(',') });
})()`;

function checkCast(c) {
  const spawn = c.log.findIndex((r) => r.st === "special" && r.af === c.startup);
  assert.ok(spawn >= 0, "precondition: the lever should have been pulled");
  assert.equal(c.log[spawn].reels, "-1,-1,-1", "and the reels start blank");

  // The seed the census builds, built from the frame and the seat this cast
  // actually used.
  const built = ((c.log[spawn].bf * 2654435761) ^ (c.slot * 40503) ^ 0x9e3779b9) >>> 0;
  assert.equal(c.seed, built,
    "the census seeds itself the way the engine does -- battleFrames " +
    c.log[spawn].bf + ", seat " + c.slot + " -- and got " + built +
    " where the cast used " + c.seed);

  /* Each reel lands on its autoStop frame of the spin, in order, one per
     frame at most. These are the `t` the census samples reelSymbol at, and
     they are read off the recording rather than assumed. */
  const landed = [-1, -1, -1];
  for (let f = 1; f < c.log.length; f++) {
    const was = c.log[f - 1].reels.split(","), now = c.log[f].reels.split(",");
    for (let i = 0; i < 3; i++) {
      if (was[i] === "-1" && now[i] !== "-1") landed[i] = c.log[f].t;
    }
  }
  assert.equal(landed.join(","), c.autoStop.join(","),
    "left alone, reel N lands on its autoStop frame (" + c.autoStop.join(",") +
    "); they landed on spin frames " + landed.join(","));

  const final = c.log[c.log.length - 1].reels;
  assert.ok(final.indexOf("-1") < 0, "precondition: all three reels landed; they read " + final);
  assert.equal(final, c.modeled,
    "and the symbols the move ends on are exactly reelLand at those frames, driven " +
    "in order off the reels that have already landed -- which is what the payout " +
    "census models: the cast showed " + final + " and the model says " + c.modeled);

  /* The player's reel, on a real cast rather than in the sampler: whatever
     bending the payout table does to reels two and three, reel one is the
     draw at the frame it stopped on and nothing else. A machine that bends
     the reel he is aiming at is one this test would otherwise let through,
     because the model above bends with it. */
  assert.equal(Number(final.split(",")[0]), c.stop0,
    "and reel one is exactly his own draw at the frame it stopped on: the cast " +
    "showed " + final.split(",")[0] + " where reelSymbol says " + c.stop0);
}

test("a cast nobody touches lands on the frames the census samples, off the seed it builds", async () => {
  const run = await simonVsReese();
  checkCast(JSON.parse(run(CAST)));
});

test("negative control: a reel that lands a frame early fails the cast test", async (t) => {
  /* The join, not the hash. If the auto-stop frames drift, the census goes on
     sampling frames the move no longer uses and stays green while measuring
     nothing -- so the frames themselves are read back off a real cast. */
  const run = await simonVsReese(sabotage(
    "            if (this.reelStops > i || this.reelT >= s.autoStop[i]) {\n",
    "            if (this.reelStops > i || this.reelT >= s.autoStop[i] - 1) {\n"));
  const c = JSON.parse(run(CAST));
  t.diagnostic(expectToFail(() => checkCast(c),
    "with the reels landing early the cast test should fail; it passed",
    "lands on its autoStop frame"));
});

test("negative control: a seed built from something else fails the cast test", async (t) => {
  /* The other half of the join. The census writes the seed arithmetic out
     longhand, so a change to it in the engine has to be argued with here
     rather than silently followed. */
  const run = await simonVsReese(sabotage(
    "          this.reelSeed = ((battleFrames * 2654435761) ^ (this.slot * 40503) ^ 0x9e3779b9) >>> 0;\n",
    "          this.reelSeed = ((battleFrames * 2246822519) ^ (this.slot * 40503) ^ 0x9e3779b9) >>> 0;\n"));
  const c = JSON.parse(run(CAST));
  t.diagnostic(expectToFail(() => checkCast(c),
    "with the seed built from a different constant the cast test should fail; it passed",
    "the census seeds itself the way the engine does"));
});

test("negative control: reels bent off the wrong first reel fail the cast test", async (t) => {
  /* The third thing the cast test joins, and the one the repair added: the
     model is reelLand driven in order, so the reels the engine hands it have
     to be the reels that actually landed. Bend what the engine passes in --
     the frames and the seed left alone -- and the move and the model part
     company while every other assertion in checkCast still passes. Without
     this control the repaired assertion could be comparing a function to
     itself. */
  const run = await simonVsReese(sabotage(
    "              this.reels[i] = reelLand(this.reelSeed, i, this.reelT, s, this.reels);\n",
    "              this.reels[i] = reelLand(this.reelSeed, i, this.reelT, s,\n" +
    "                [(this.reels[0] + 1) % 4, this.reels[1], this.reels[2]]);\n"));
  const c = JSON.parse(run(CAST));
  t.diagnostic(expectToFail(() => checkCast(c),
    "with the reels bent off a different first reel the cast test should fail; it passed",
    "are exactly reelLand at those frames"));
});

/* ------------------------------------------------------------------ */
/* The census of the PAYOUT, which is no longer what the draw does.     */

/* Four symbols over three independent reels pay three of a kind 6.25% of the
   time, and no weighting of four symbols moves that to the 15 the machine is
   supposed to pay -- the engine's own note works the search: holding bust at
   35% the best reachable triple rate is 7.79%, barely half. So reelLand()
   stopped asking the symbols. It picks the CLASS off the seed and lets the
   draw pick the SYMBOL, and the three things that model owes the player are
   what this measures:

     the machine pays 15 / 50 / 35,
     reel one is EXACTLY the symbol he stopped it on, and
     a pair is always a pair OF that symbol.

   The middle one is why the move is still a game and not a coin toss:
   chasing the sevens with your thumb decides WHICH payout you collect while
   the class decides how generous the pull was. The third is what stops a
   bent reel two handing him a pair of something he never aimed at -- which
   is the same defect one step further along, and is invisible in the payout
   percentages because it is still, honestly, a pair.

   Stop frames are varied per cast instead of sitting on autoStop, because
   the player is the one who picks them: a model measured only at the
   auto-stop frames would say nothing about the machine anybody actually
   plays. They are kept in order and inside the auto-stop caps so every
   outcome in the sample is one a thumb could have produced. */
const PAYCASTS = 40000;

const PAYOUT = `(function () {
  var s = ROSTER.simon.specials.down;
  var shape = [0, 0, 0];      // three alike / a pair / a bust, read off the reels
  var cls = [0, 0, 0];        // and what reelClass decided before they spun
  var incoherent = 0;         // an outcome that is not the class the seed picked
  var notHisStop = 0;         // a reel one that is not his own draw
  var pairNotHis = 0;         // a pair in a symbol he did not stop reel one on
  var firstRow = [0, 0, 0, 0];
  var bad = 0;
  for (var f = 0; f < ${PAYCASTS}; f++) {
    var seed = ((f * 2654435761) ^ (${SEAT} * 40503) ^ 0x9e3779b9) >>> 0;
    // Three stop frames a thumb could actually have produced: in order,
    // inside the auto-stop caps of 30 / 48 / 66, and different every cast.
    var t0 = 4 + (f % 27);
    var t1 = t0 + 3 + ((f * 5) % 16);
    var t2 = t1 + 3 + ((f * 11) % 15);
    var t = [t0, t1, t2];
    // In order, each call handed what has landed so far, which is how the
    // move itself asks -- reelLand reads the earlier reels back.
    var reels = [-1, -1, -1];
    for (var i = 0; i < 3; i++) reels[i] = reelLand(seed, i, t[i], s, reels);
    var a = reels[0], b = reels[1], c = reels[2];
    if (!(a >= 0 && a <= 3 && b >= 0 && b <= 3 && c >= 0 && c <= 3)) { bad++; continue; }
    var sh = (a === b && b === c) ? 0 : (a === b || a === c || b === c) ? 1 : 2;
    var k = reelClass(seed);
    shape[sh]++; cls[k]++;
    if (k !== sh) incoherent++;
    if (a !== reelSymbol(seed, 0, t0, s)) notHisStop++;
    if (sh === 1 && a !== b && a !== c) pairNotHis++;
    firstRow[a]++;
  }
  return JSON.stringify({ n: ${PAYCASTS}, shape: shape, cls: cls,
    incoherent: incoherent, notHisStop: notHisStop, pairNotHis: pairNotHis,
    firstRow: firstRow, bad: bad });
})()`;

const WANT = [15, 50, 35];
const SHAPES = ["three alike", "a pair", "a bust"];

function checkPayout(r) {
  assert.ok(r.n >= 20000,
    "precondition: a statistical claim needs a sample; this was " + r.n + " casts");
  assert.equal(r.bad, 0,
    "precondition: a reel shows one of four symbols and nothing else; " + r.bad +
    " casts came back with a reel outside 0-3");
  assert.equal(r.shape[0] + r.shape[1] + r.shape[2], r.n,
    "precondition: every cast lands in exactly one of the three outcomes; " +
    r.shape.join("+") + " is not " + r.n);

  /* 1. Reel one is HIS. First, because the other two claims mean nothing
     without it: a machine that pays a perfect 15 / 50 / 35 in symbols the
     player never stopped it on is a slot machine with the lever painted on,
     and the percentages alone cannot tell the two apart. */
  assert.equal(r.notHisStop, 0,
    "reel one is EXACTLY the draw at the frame he stopped it on -- " +
    r.notHisStop + " of " + r.n + " casts bent it");

  /* 2. And a pair is HIS pair. reelLand chooses which of reels two and three
     fails to match, never reel one, so the two that agree always include his
     -- which is what makes stopping reel one on the sevens the thing you do
     with your thumb. A pair of something else is still a pair, still pays,
     and still reads on screen as the machine ignoring him. */
  assert.equal(r.pairNotHis, 0,
    "a pair is always a pair OF the symbol he stopped reel one on -- " +
    r.pairNotHis + " pairs came up in a symbol he did not");

  /* 3. The outcome on the reels is the class the seed picked. Not a
     restatement of the percentages below: those are read off the REELS, so
     they would still come out at 15 / 50 / 35 if the classes were being
     honored in aggregate and swapped one for another cast by cast. */
  assert.equal(r.incoherent, 0,
    "the outcome on the reels is the class the seed chose before they spun; " +
    r.incoherent + " of " + r.n + " casts disagreed with reelClass");

  /* 4. And the table itself, which is the number he asked for and the reason
     the class exists at all. A regression to three independent reels shows
     up here as triples at 6.25% -- under half -- with busts up at 37.5%. */
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(pct(r.shape[i], r.n) - WANT[i]) <= 1.5,
      "the machine pays " + WANT.join(" / ") + "; " + SHAPES[i] + " came up " +
      show(r.shape[i], r.n) + " of " + r.n + " casts, wanted about " + WANT[i] + "%");
  }

  /* 5. Reel one still fair across the four symbols. The class comes off the
     seed alone, so nothing in the payout model has any business touching
     WHICH symbol he is able to stop -- and a bias here is how a machine
     quietly stops paying sevens while still paying 15% of something. */
  for (let sym = 0; sym < 4; sym++) {
    assert.ok(Math.abs(pct(r.firstRow[sym], r.n) - 25) <= 1.5,
      "reel one shows each of its four symbols a quarter of the time; symbol " +
      sym + " came up " + show(r.firstRow[sym], r.n));
  }
}

test("the machine pays 15 / 50 / 35, reel one is his, and a pair is his pair", async (t) => {
  const run = await bootEngine();
  const r = JSON.parse(run(PAYOUT));
  t.diagnostic("outcomes " + r.shape.map((c) => show(c, r.n)).join("/") +
    " | classes " + r.cls.map((c) => show(c, r.n)).join("/") +
    " | reel one " + r.firstRow.map((c) => show(c, r.n)).join("/") +
    " | bent reel ones " + r.notHisStop + ", pairs that were not his " + r.pairNotHis);
  checkPayout(r);
});

test("negative control: a machine paying a different table fails the payout census", async (t) => {
  /* The percentages, on their own. Only the class weighting moves, so reel
     one is still his and a pair is still his pair -- the assertion this has
     to fail is the table, and a control that also broke the other two would
     not prove the table is being measured at all. */
  const run = await bootEngine(sabotage("const REEL_TRIPLE = 15;",
                                        "const REEL_TRIPLE = 35;"));
  const r = JSON.parse(run(PAYOUT));
  t.diagnostic("a 35% machine read outcomes " + r.shape.map((c) => show(c, r.n)).join("/"));
  assert.equal(r.notHisStop, 0,
    "the sabotage should leave reel one alone; it bent " + r.notHisStop);
  assert.equal(r.pairNotHis, 0,
    "and should leave the pairs his; " + r.pairNotHis + " were not");
  t.diagnostic(expectToFail(() => checkPayout(r),
    "with the jackpot at 35% the payout census should fail; it passed",
    "the machine pays 15 / 50 / 35"));
});

test("negative control: a reel one that is not his stop fails the payout census", async (t) => {
  /* Reel one nudged one symbol off the draw. Everything downstream still
     agrees with it -- the pairs are pairs of the bent symbol, the table is
     untouched -- so the ONLY thing wrong is that the reel he was aiming at
     is not the reel that stopped, which is exactly the assertion that has to
     catch it. */
  const run = await bootEngine(sabotage("  if (reel === 0) return pick;",
                                        "  if (reel === 0) return (pick + 1) % 4;"));
  const r = JSON.parse(run(PAYOUT));
  t.diagnostic("a bent reel one read " + r.notHisStop + " of " + r.n +
    " casts off his draw, outcomes " + r.shape.map((c) => show(c, r.n)).join("/"));
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(pct(r.shape[i], r.n) - WANT[i]) <= 1.5,
      "the sabotage should leave the payout table alone, which is why the table " +
      "alone cannot catch it: " + SHAPES[i] + " read " + show(r.shape[i], r.n));
  }
  t.diagnostic(expectToFail(() => checkPayout(r),
    "with reel one off his own draw the payout census should fail; it passed",
    "reel one is EXACTLY the draw at the frame he stopped it on"));
});

test("negative control: a pair in a symbol he did not stop fails the payout census", async (t) => {
  /* Reels two and three matching EACH OTHER instead of matching him. Still
     exactly a pair, so the machine still pays 15 / 50 / 35 and reel one is
     still his own draw; what is gone is the only reason to aim reel one at
     anything. This is the control that earns the pairNotHis assertion,
     because no percentage in this file moves when it is applied. */
  const run = await bootEngine(sabotage(
    "    return reel === reelOdd(seed) ? (first + 1 + (pick % 3)) % 4 : first;",
    "    return (first + 1) % 4;"));
  const r = JSON.parse(run(PAYOUT));
  t.diagnostic("pairs not his: " + r.pairNotHis + " of " + r.shape[1] +
    " pairs, outcomes " + r.shape.map((c) => show(c, r.n)).join("/") +
    ", bent reel ones " + r.notHisStop);
  assert.ok(r.pairNotHis > 0,
    "precondition: the sabotage should produce pairs that are not his; it produced none");
  assert.equal(r.notHisStop, 0,
    "and it should leave reel one itself alone; it bent " + r.notHisStop);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(pct(r.shape[i], r.n) - WANT[i]) <= 1.5,
      "and the table should read the same, which is why the table cannot catch " +
      "this: " + SHAPES[i] + " read " + show(r.shape[i], r.n));
  }
  t.diagnostic(expectToFail(() => checkPayout(r),
    "with the pairs formed off the other two reels the payout census should fail; it passed",
    "a pair is always a pair OF the symbol he stopped reel one on"));
});

/* ------------------------------------------------------------------ */
/* And the class cannot be felt out with the stop frames.               */

/* reelClass takes the seed and nothing else, and that is load-bearing rather
   than tidy: the class is settled the moment the lever comes down, so a
   player cannot learn that a pull is generous and then take his time over
   the reels that are left. If the stop frames could move it, the best way to
   play the move would be to stop reel one and then watch the machine, which
   is not a fighting game input.

   So: one seed, twelve different sets of stop frames, and the outcome has to
   be the same every time. Read off the REELS rather than by calling
   reelClass, because the claim is about what the player can make happen. */
const CLASS_FIXED = `(function () {
  var s = ROSTER.simon.specials.down;
  var seeds = 0, readings = 0, wobbled = 0, kinds = [0, 0, 0];
  for (var f = 0; f < 3000; f++) {
    var seed = ((f * 2654435761) ^ (${SEAT} * 40503) ^ 0x9e3779b9) >>> 0;
    var want = -1, moved = 0;
    for (var v = 0; v < 12; v++) {
      // Ordered, and inside the auto-stop caps, so every one of the twelve
      // is a set of frames he could really have stopped them on.
      var t = [3 + v * 2, 20 + v, 40 + v * 2];
      var reels = [-1, -1, -1];
      for (var i = 0; i < 3; i++) reels[i] = reelLand(seed, i, t[i], s, reels);
      var a = reels[0], b = reels[1], c = reels[2];
      var sh = (a === b && b === c) ? 0 : (a === b || a === c || b === c) ? 1 : 2;
      if (want < 0) want = sh; else if (sh !== want) moved = 1;
      readings++;
    }
    if (moved) wobbled++;
    kinds[want]++;
    seeds++;
  }
  return JSON.stringify({ seeds: seeds, readings: readings, wobbled: wobbled,
                          kinds: kinds });
})()`;

function checkClassFixed(r) {
  assert.ok(r.seeds >= 1000,
    "precondition: a claim about every seed needs a sample; this was " + r.seeds);
  assert.ok(r.readings >= r.seeds * 2,
    "precondition: stability needs more than one set of stop frames per seed; " +
    r.readings + " readings over " + r.seeds + " seeds");
  assert.ok(r.kinds[0] > 0 && r.kinds[1] > 0 && r.kinds[2] > 0,
    "precondition: the sample has to contain all three outcomes or stability is " +
    "vacuous -- a machine that always busts is perfectly stable; it read " +
    r.kinds.join("/") + " triples/pairs/busts");
  assert.equal(r.wobbled, 0,
    "the class is decided by the seed ALONE, so no choice of stop frames changes " +
    "WHICH payout a pull was going to be: " + r.wobbled + " of " + r.seeds +
    " seeds changed outcome when the frames moved, which would make watching the " +
    "machine better play than aiming at it");
}

test("no set of stop frames can change which payout a pull was going to be", async (t) => {
  const run = await bootEngine();
  const r = JSON.parse(run(CLASS_FIXED));
  t.diagnostic(r.seeds + " seeds x 12 sets of stop frames | outcomes " +
    r.kinds.map((c) => show(c, r.seeds)).join("/") + " | wobbled " + r.wobbled);
  checkClassFixed(r);
});

test("negative control: a class that moves with the stop frames fails", async (t) => {
  /* The class mixed with the reel's own stop frame. It still pays out and
     still looks like a slot machine; it simply decides what kind of pull it
     was after the player has committed to the frames, which is the exploit
     this test exists to keep shut. */
  const run = await bootEngine(sabotage(
    "  const cls = reelClass(seed);",
    "  const cls = reelClass((seed ^ Math.imul(t, 2654435761)) >>> 0);"));
  const r = JSON.parse(run(CLASS_FIXED));
  t.diagnostic("a frame-sensitive class wobbled on " + r.wobbled + " of " + r.seeds +
    " seeds");
  t.diagnostic(expectToFail(() => checkClassFixed(r),
    "with the class reading the stop frames the stability test should fail; it passed",
    "the class is decided by the seed ALONE"));
});
