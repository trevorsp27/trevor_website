/* SLOTS: the reels, and the jackpot that could not happen.
 *
 * reelSymbol() is the whole of the move's randomness -- three calls, one per
 * reel, from a seed made of battleFrames and the seat. It was a bare xorshift
 * finished with `% 4`, and between those two things a spin nobody stopped by
 * hand could not pay a jackpot AT ALL.
 *
 * Nothing about it looked wrong from inside. Each reel on its own was
 * perfectly uniform -- 25/25/25/25 across the four symbols, which is the
 * measurement anybody would reach for first and the one that passes. The
 * defect was BETWEEN the reels: xorshift is linear over the bits, so the two
 * low bits that `% 4` reads moved in lockstep with the per-reel offset added
 * into the seed. The three reels were welded to each other. Measured over
 * forty thousand casts at the auto-stop frames they agreed pairwise 15.5% of
 * the time against a fair 25%, and all three agreed 0.00% -- not rarely,
 * NEVER.
 *
 * So this file measures the one thing a per-reel check cannot see: whether
 * the reels are independent of each other. It is a statistical property and
 * it is asserted statistically -- forty thousand casts, the same seed the
 * engine builds, the frames the reels land on when nobody touches them, and
 * generous tolerances, because the point is not to pin the third decimal. The
 * point is that three of a kind happens about 6.25% of the time instead of
 * never, and the assertion is written so the old hash misses it by the width
 * of the whole property.
 *
 * The sampler calls the engine's own reelSymbol rather than a copy, and the
 * cast at the bottom pins that the frames it feeds that function are the
 * frames the real move feeds it: forty thousand casts through step() would
 * take minutes, and forty thousand casts of a function that has drifted away
 * from the move would take none and mean nothing.
 *
 * This loads the engine source, as nerdwars-kel-buff.test.js does, because
 * reelSymbol, battleFrames and the reel state are all internals.
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
   not a failed test, and is let through. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e instanceof assert.AssertionError) return e.message;
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
/* The census.                                                          */

/* Forty thousand consecutive casts from seat 0 -- battleFrames 0, 1, 2 ...
   through the engine's own seed arithmetic -- each one read at the frames
   the three reels land on when nobody stops them. The seed is written out
   here rather than taken from the engine so that a change to the SEED is a
   change this file argues with too; the cast at the bottom is what keeps the
   two honest.

   Forty thousand because that is what the before-and-after in the engine was
   measured over, so the numbers here are the numbers in that comment. Twenty
   would do: three of a kind at 6.25% is about 1,250 hits and the old hash
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

  /* 3. And the payout the whole move is named for. `three > 0` is the
     regression, stated on its own and first: the old hash scored ZERO over
     forty thousand casts, so a spin nobody hand-stopped could not pay a
     jackpot however long anybody played. */
  assert.ok(r.three > 0,
    "a jackpot has to be REACHABLE on a spin nobody touched -- three of a kind " +
    "came up " + r.three + " times in " + r.n + " casts, which is the bug this " +
    "test exists for");
  assert.ok(Math.abs(pct(r.three, r.n) - 6.25) <= 1,
    "and it comes up about 6.25% of the time -- one in sixteen, four ways out " +
    "of sixty-four; it came up " + show(r.three, r.n));
}

test("the three reels are independent of each other, and a jackpot can land on its own", async (t) => {
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

test("negative control: the hash it replaced never pays a jackpot on its own", async (t) => {
  /* The whole of the old function: the linear mixer AND `% 4`. This is the
     shipped bug, and the assertion it has to fail is the one about three of
     a kind being reachable at all. */
  const run = await bootEngine(sabotage(OLD_MIXER + "  return h >>> 30;\n",
                                        XORSHIFT + "  return h % 4;\n"));
  const r = JSON.parse(run(CENSUS));
  t.diagnostic("old hash read pairs " + r.pairs.map((c) => show(c, r.n)).join("/") +
    ", three of a kind " + r.three + " of " + r.n +
    ", reel 1 " + r.reels[0].map((c) => show(c, r.n)).join("/"));
  assert.equal(r.three, 0,
    "the old hash should pay no jackpot at all on an untouched spin; it paid " + r.three);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(pct(r.reels[0][i], r.n) - 25) <= 1.5,
      "and each reel alone should still look perfectly fair, which is why nobody " +
      "caught this: reel 1 symbol " + i + " read " + show(r.reels[0][i], r.n));
  }
  expectToFail(() => checkCensus(r),
    "with the old hash back the census should fail; it passed");
});

test("negative control: a linear mixer welds the reels together even off the top bits", async (t) => {
  /* Half the fix undone: the good two bits are still the ones being read,
     but the mixing that earns them is back to an add and a bare xorshift.
     Each reel stays uniform and the pairs fall apart anyway -- which is the
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
   every reel lands on its own. What this pins is the join between the census
   above and the engine: the seed is built the way the census builds it, the
   reels land on the frames the census samples, and the three symbols that
   come out are exactly the three the census would have modeled. Without
   this, a change to the seed or to `autoStop` would leave forty thousand
   perfectly independent samples of a function nothing calls that way. */
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
  return JSON.stringify({ log: log, slot: me.slot, seed: seed,
    startup: DOWN.startup, autoStop: DOWN.autoStop.slice(),
    modeled: [reelSymbol(seed, 0, DOWN.autoStop[0], DOWN),
              reelSymbol(seed, 1, DOWN.autoStop[1], DOWN),
              reelSymbol(seed, 2, DOWN.autoStop[2], DOWN)].join(',') });
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
    "and the symbols the move ends on are exactly reelSymbol at those frames, " +
    "which is what the census samples: the cast showed " + final +
    " and the model says " + c.modeled);
}

test("a cast nobody touches lands on the frames the census samples, off the seed it builds", async () => {
  const run = await simonVsReese();
  checkCast(JSON.parse(run(CAST)));
});

test("negative control: a reel that lands a frame early fails the cast test", async () => {
  /* The join, not the hash. If the auto-stop frames drift, the census goes on
     sampling frames the move no longer uses and stays green while measuring
     nothing -- so the frames themselves are read back off a real cast. */
  const run = await simonVsReese(sabotage(
    "            if (this.reelStops > i || this.reelT >= s.autoStop[i]) {\n",
    "            if (this.reelStops > i || this.reelT >= s.autoStop[i] - 1) {\n"));
  const c = JSON.parse(run(CAST));
  expectToFail(() => checkCast(c),
    "with the reels landing early the cast test should fail; it passed");
});

test("negative control: a seed built from something else fails the cast test", async () => {
  /* The other half of the join. The census writes the seed arithmetic out
     longhand, so a change to it in the engine has to be argued with here
     rather than silently followed. */
  const run = await simonVsReese(sabotage(
    "          this.reelSeed = ((battleFrames * 2654435761) ^ (this.slot * 40503) ^ 0x9e3779b9) >>> 0;\n",
    "          this.reelSeed = ((battleFrames * 2246822519) ^ (this.slot * 40503) ^ 0x9e3779b9) >>> 0;\n"));
  const c = JSON.parse(run(CAST));
  expectToFail(() => checkCast(c),
    "with the seed built from a different constant the cast test should fail; it passed");
});
