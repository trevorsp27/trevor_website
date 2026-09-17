/* THE STROKES -- the note rain, after 2.81 turned a conveyor belt into a song.
 *
 * "spiky music notes start falling from ceiling to deal damage", and for two
 * releases they fell in a straight diagonal line: an even sweep at one
 * constant speed, `n * stride + offset` with a small wobble bolted on. The
 * lag-1 autocorrelation of consecutive spawn positions was +0.78 and the mean
 * step between them was 20.8 px, which is the number that says "belt" out
 * loud. Forty of them at 15 damage each read as a drip. 2.81 made it a
 * hundred and sixty-two at 6 in chords of three, and 2.84 halved the density
 * and put the damage up: EIGHTY-ONE AT 7, still in chords of three, over the
 * same 162-frame song. The count moved, the length did not.
 *
 * THE WORD "RANDOMIZED" IS A TRAP IN A REQUEST LIKE THIS ONE, and it is the
 * reason half this file exists: these positions are HITBOXES. Every note's
 * lane, its height off the ceiling and its fall speed come out of `noteRoll`
 * -- a Math.imul mixer keyed on the note's own index across the whole song
 * and on `rainSeed`, the single number the cast draws -- so two machines
 * build the identical shower and a rollback replays it to the pixel. A
 * Math.random in there would be a desync sixty times a second.
 *
 * THE BAKERY'S 78-VS-80 TRAP, which this move now has its own version of.
 * `duration` has to be a whole multiple of `every`, or the song advertises a
 * note count it does not deliver. 162 = 27 x 6 since 2.84, and it was 54 x 3
 * before. It is checked here rather than remembered, because the only
 * evidence of getting it wrong is a note that is not there -- and halving
 * `every` is exactly the kind of edit that would have got it wrong.
 *
 * WHY THE SCATTER IS MEASURED POOLED. Lag-1 over a single 81-note cast has a
 * standard error of about 1 / sqrt(81) = 0.111, so a +-0.15 window is under
 * two sigma and a fair share of casts will step outside it by chance --
 * measured, twelve consecutive casts of the shipping build ran -0.13 to
 * +0.20. Pooled over those twelve the same statistic is -0.0038 with a
 * standard error of 0.023, which is six sigma of headroom, and the belt it
 * replaces reads +0.78 pooled or not. The pooled figure is the one with
 * teeth; the per-cast one is a coin.
 *
 * The engine source is loaded directly: `projectiles`, `fighters`, saveSim
 * and the ROSTER are all internals.
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

const ULT = 256;

/* Ladeane in seat 0. Every note is tagged the first frame it is seen rather
   than counted off `projectiles.length`, because dead projectiles are spliced
   out of that array as the song runs and an index-based count silently loses
   a third of it -- which is how the first draft of this file measured 125
   notes and believed it. */
async function arena(names, engineSrc) {
  const booted = await bootEngine(engineSrc);
  const { run } = booted;
  const who = names || ["ladeane", "trev"];
  const order = JSON.parse(run("JSON.stringify(ORDER)"));
  for (const k of who) assert.ok(order.indexOf(k) >= 0, "precondition: " + k + " is on the roster");
  run("select.cursor = [" + who.map((k) => order.indexOf(k)).join(", ") + "];" +
      " twoPlayer = true; playerCount = " + who.length + "; humanCount = 0;" +
      " practice = false;");
  run([
    "var MAIN, RAIN, SPAWNED, STAGE_NAMES;",
    "RAIN = ROSTER.ladeane.ult;",
    "STAGE_NAMES = STAGES.map(function (s) { return s.name; });",
    "function seat(stage) {",
    "  stagePick = stage || 0; startBattle();",
    "  for (var i = 0; i < 60; i++) step();",
    "  MAIN = STAGE.platforms.find(function (p) { return p.main; });",
    "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
    "  SPAWNED = [];",
    "  fighters.forEach(function (f, i) {",
    "    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;",
    "    f.landLag = 0; f.invuln = 9999; f.mana = 100; f.vx = 0; f.vy = 0;",
    "    f.grounded = true; f.y = MAIN.y; f.stocks = 9; f.health = 100;",
    "    f.eliminated = false; f.hasHit = false; f.attackFrame = 0;",
    "    f.specialSpawned = false; f.ultMeter = 999;",
    "    f.rainTimer = 0; f.rainStep = 0; f.rainSpec = null;",
    "    f.x = MAIN.x + 40 + i * 50; f.facing = i === 0 ? 1 : -1;",
    "    f.shield = COMBAT.shieldMax;",
    "  });",
    "  netplay.active = true;",
    "}",
    "function sweep() {",
    "  for (var i = 0; i < projectiles.length; i++) {",
    "    var p = projectiles[i];",
    "    if (p.spec === RAIN && !p.__seen) {",
    "      p.__seen = true;",
    "      SPAWNED.push([+p.x, +p.y, +p.vy, p.tint, p.owner.slot, battleFrames]);",
    "    }",
    "  }",
    "}",
    "function tick() {",
    "  var pads = [];",
    "  for (var i = 0; i < fighters.length; i++) pads.push(bitsToPad(arguments[i] || 0));",
    "  netplay.framePads = pads; step(); sweep();",
    "}",
    "function alive() {",
    "  var c = 0;",
    "  for (var i = 0; i < projectiles.length; i++) if (!projectiles[i].dead) c++;",
    "  return c;",
    "}",
    /* One whole song. `delay` shifts battleFrames at the cast, which is what
       makes one cast different from the next -- `rainSeed` is battleFrames
       times 31 plus the slot. */
    "function song(stage, delay, jolt) {",
    "  seat(stage);",
    "  for (var i = 0; i < (delay || 0); i++) tick(0, 0);",
    "  tick(" + ULT + ", 0);",
    "  var seeds = {}, peak = 0;",
    "  for (var j = 0; j < 460; j++) {",
    /* The jolts start AFTER the cast has landed. Hitstop during the twelve
       startup frames delays the cast itself, so the seed is drawn on a later
       battleFrames and the song is legitimately a different song -- which is
       a fact about when he pressed the button, not about the seed. What is
       under test is the seed holding still once the song is running. */
    "    if (jolt && j >= 20 && j % 17 === 0) fighters[0].hitstop = 6;",
    "    tick(0, 0);",
    "    if (alive() > peak) peak = alive();",
    "    if (fighters[0].rainTimer > 0) seeds[fighters[0].rainSeed] = 1;",
    "  }",
    "  return { sp: SPAWNED, peak: peak, seeds: Object.keys(seeds).map(Number) };",
    "}",
  ].join("\n"));
  return booted;
}

function lag1(a) {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) {
    den += (a[i] - m) ** 2;
    if (i) num += (a[i] - m) * (a[i - 1] - m);
  }
  return num / den;
}
function meanStep(a) {
  let s = 0;
  for (let i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]);
  return s / (a.length - 1);
}

/* ===================================================================== */
/* 1. EIGHTY-ONE, AND IT STILL DIVIDES                                   */
/* ===================================================================== */

/* 2.84: "Make ladeanes music notes half as many". Half as many was built as a
   DENSITY -- `every` 3 -> 6 over an unchanged 162-frame `duration` -- rather
   than as a shorter song, and both readings happen to divide, which is
   precisely why the division has to be asserted rather than trusted. */

function checkCount(r) {
  assert.equal(r.duration % r.every, 0,
    "`duration` has to be a whole multiple of `every` -- 162 is 27 sixes -- " +
    "or the last beat of the song is cut off mid-bar and the only evidence " +
    "is a note that is not there. This is the bakery's 78-vs-80 trap wearing " +
    "a different move: " + r.duration + " over " + r.every);
  assert.equal(r.notes, (r.duration / r.every) * r.per,
    "and the song has to deliver exactly the count the ROSTER advertises: " +
    (r.duration / r.every) * r.per + " from duration " + r.duration +
    ", every " + r.every + ", per " + r.per + ". It delivered " + r.notes);
  assert.equal(r.notes, 81,
    "which is eighty-one, half of the hundred and sixty-two it was; it was " +
    r.notes);
  assert.equal(r.duration, 162,
    "off an unchanged 162-frame song -- the ask was half as many notes, not " +
    "half as long a song, and the length is the thing that makes this move " +
    "worth casting. It was " + r.duration);
  assert.equal(r.volleys, r.duration / r.every,
    "arriving in " + r.duration / r.every + " volleys; there were " + r.volleys);
  assert.equal(r.biggestVolley, r.per,
    "of " + r.per + " apiece, on the same frame -- a chord reads as music " +
    "where a drip reads as a drip. The biggest was " + r.biggestVolley);
  assert.equal(r.smallestVolley, r.per,
    "and none of them short; the smallest was " + r.smallestVolley);
  /* THE LAST VOLLEY HAS TO LAND. `rainTimer` runs `duration` frames, so
     `rainStep` is 0..duration-1 and volleys fire on the steps divisible by
     `every` -- the last of them at duration - every. If the division fails,
     the final bar is a partial one and the count silently disagrees with the
     object. Asserted off the frame the last note actually spawned rather
     than off arithmetic, because arithmetic is the thing under test. */
  assert.equal(r.lastVolleyStep, r.duration - r.every,
    "and the last volley of the song has to be a whole one, fired on step " +
    (r.duration - r.every) + " -- the final beat that divides. It fired on " +
    r.lastVolleyStep);
  assert.equal(r.lastVolleySize, r.per,
    "with all " + r.per + " of its notes, not a remainder; it had " +
    r.lastVolleySize);
}

const COUNT = "(function () {\n" +
  "  var r = song(0, 0, false);\n" +
  "  var byFrame = {}, frames = [];\n" +
  "  r.sp.forEach(function (p) {\n" +
  "    if (!byFrame[p[5]]) frames.push(p[5]);\n" +
  "    byFrame[p[5]] = (byFrame[p[5]] || 0) + 1;\n" +
  "  });\n" +
  "  frames.sort(function (a, b) { return a - b; });\n" +
  "  var sizes = frames.map(function (k) { return byFrame[k]; });\n" +
  "  return { notes: r.sp.length, volleys: sizes.length,\n" +
  "           biggestVolley: Math.max.apply(null, sizes),\n" +
  "           smallestVolley: Math.min.apply(null, sizes),\n" +
  /* Steps rather than battleFrames: the first volley of a cast fires on
     rainStep 0, so the offset between the two is the frame the song began. */
  "           lastVolleyStep: frames[frames.length - 1] - frames[0],\n" +
  "           lastVolleySize: sizes[sizes.length - 1],\n" +
  "           duration: RAIN.duration, every: RAIN.every, per: RAIN.per };\n" +
  "})()";

test("eighty-one notes, twenty-seven chords of three, over an unchanged song",
  async () => {
    const { run } = await arena();
    checkCount(run(COUNT));
  });

test("control: an `every` that does not divide advertises a count it misses",
  async () => {
    /* `every: 5` over 162 frames is the trap in its purest form. It still
       fires a volley every five steps and the shower LOOKS entirely right,
       but 162 / 5 is 32.4, so the object's own arithmetic says 96 notes while
       99 arrive. Nothing on screen says anything -- which is the whole reason
       this test exists, and the reason it is aimed at `every` now that
       `every` is the number that moved. */
    const off = await arena(null, sabotage(
      "      every: 6, per: 3, margin: 6, slow: 2.0, fast: 3.6,",
      "      every: 5, per: 3, margin: 6, slow: 2.0, fast: 3.6,"));
    const r = off.run(COUNT);
    assert.equal(r.every, 5, "precondition: the mutant really is at every 5");
    assert.equal(r.notes, 99,
      "precondition: and it really does deliver 99 while advertising " +
      Math.floor(162 / 5) * 3 + "; it delivered " + r.notes);
    expectToFail(() => checkCount(r),
      "an `every` that is not a whole divisor of `duration` should fail the " +
      "count test");
  });

test("control: a duration that does not divide fails it too", async () => {
  /* The other half of the same trap, kept because `duration` is the number
     somebody would reach for if they wanted a shorter song. 160 over every 6
     advertises 78 and delivers 81. */
  const off = await arena(null, sabotage("      duration: 162,", "      duration: 160,"));
  expectToFail(() => checkCount(off.run(COUNT)),
    "a duration that is not a whole multiple of `every` should fail the " +
    "count test");
});

/* ===================================================================== */
/* 2. IT IS NOT A LINE                                                   */
/* ===================================================================== */

function checkScatter(r) {
  assert.ok(Math.abs(r.pooledLag) < 0.15,
    "consecutive notes must not know where the last one landed. Pooled over " +
    r.n + " spawns from twelve casts the lag-1 autocorrelation of spawn x is " +
    r.pooledLag.toFixed(4) + "; the belt this replaces reads +0.78. (Per " +
    "cast the same statistic has a standard error of 0.111 at 81 notes and " +
    "is a coin at this window -- see the head of this file.)");
  assert.ok(r.pooledStep > 80,
    "and the mean step between one note and the next has to be most of the " +
    "stage rather than a stride: " + r.pooledStep.toFixed(1) + " px, against " +
    "the belt's 20.8");
  /* THE WIDEST-EMPTY-LANE ASSERTION USED TO LIVE HERE AND IT HAD TO MOVE.
     It read `widest < 15` -- "there is nowhere to stand" -- and at 81 notes
     that is simply no longer true: a body-width lane stays open for a whole
     song in 81% of casts, against 4% at 162. That is the direct cost of
     halving the count and it is now measured on its own below, with its own
     control, instead of riding along as a clause of the scatter test. The two
     statistics above are PER-NOTE and are untouched by the count, which is
     why they stayed. */
}

const SCATTER = "(function () {\n" +
  "  var pooled = [], widest = 0;\n" +
  "  for (var d = 0; d < 12; d++) {\n" +
  "    var xs = song(0, d, false).sp.map(function (p) { return p[0]; });\n" +
  "    var sorted = xs.slice().sort(function (a, b) { return a - b; });\n" +
  "    for (var i = 1; i < sorted.length; i++)\n" +
  "      widest = Math.max(widest, sorted[i] - sorted[i - 1]);\n" +
  "    pooled = pooled.concat(xs);\n" +
  "  }\n" +
  "  return { xs: pooled, widest: widest };\n" +
  "})()";

function scatterOf(raw) {
  return { pooledLag: lag1(raw.xs), pooledStep: meanStep(raw.xs),
           widest: raw.widest, n: raw.xs.length };
}

test("the notes do not fall in a line", async () => {
  const { run } = await arena();
  checkScatter(scatterOf(run(SCATTER)));
});

/* ===================================================================== */
/* 2b. THE WIDEST EMPTY LANE, WHICH IS THE ONE SCATTER NUMBER THAT MOVED  */
/* ===================================================================== */

/* A gap in a sorted list of spawn positions is a function of how many
   positions there are, and 2.84 halved them. Measured over 3,000 casts of
   each, the widest lane a whole song leaves open runs

                      min   p10   p50   p90   p99   max
        162 notes     6.3   8.1  10.2  13.5  18.0  29.2
         81 notes     9.6  13.8  18.0  24.1  31.6  46.0

   against the 15 px a body needs. So the honest claim about this move is now
   the median, and the median is what is asserted: it is a shower somebody can
   sometimes stand still in, and that is the shape of the thing that was asked
   for. The bound is deliberately two-sided. A median that climbed past the
   top would mean the shower had thinned into a drip; one that fell under the
   bottom would mean the count had quietly gone back up. */

function checkLanes(r) {
  assert.ok(r.median >= 12,
    "at eighty-one notes half of all casts leave a gap of about eighteen " +
    "pixels somewhere on a 308 px stage -- two bodies -- and a median under " +
    "twelve would mean the note count had gone back up without this file " +
    "noticing. Over " + r.n + " casts the median widest lane was " +
    r.median.toFixed(1) + " px");
  assert.ok(r.median <= 28,
    "and a median over twenty-eight would mean the shower had thinned from a " +
    "song into a drip: a third of the stage open for its whole length. It " +
    "was " + r.median.toFixed(1) + " px");
}

const LANES = "(function () {\n" +
  "  var ws = [];\n" +
  "  for (var d = 0; d < 24; d++) {\n" +
  "    var xs = song(0, d, false).sp.map(function (p) { return p[0]; });\n" +
  "    xs.sort(function (a, b) { return a - b; });\n" +
  "    var w = 0;\n" +
  "    for (var i = 1; i < xs.length; i++)\n" +
  "      if (xs[i] - xs[i - 1] > w) w = xs[i] - xs[i - 1];\n" +
  "    ws.push(w);\n" +
  "  }\n" +
  "  ws.sort(function (a, b) { return a - b; });\n" +
  "  return { median: ws[ws.length >> 1], n: ws.length,\n" +
  "           lo: ws[0], hi: ws[ws.length - 1] };\n" +
  "})()";

test("the widest empty lane is a two-body gap, which is what half as many buys",
  async () => {
    const { run } = await arena();
    checkLanes(run(LANES));
  });

test("control: one note a volley thins the shower into a drip", async () => {
  /* `per` 3 -> 1 is the same knob the count was turned with, turned further,
     and it is the failure this bound exists to catch: 27 notes over the same
     song, with most of the stage standing empty for all of it. */
  const off = await arena(null, sabotage(
    "      every: 6, per: 3, margin: 6, slow: 2.0, fast: 3.6,",
    "      every: 6, per: 1, margin: 6, slow: 2.0, fast: 3.6,"));
  const r = off.run(LANES);
  assert.ok(r.median > 28,
    "precondition: twenty-seven notes really do leave a third of the stage " +
    "open; the median was " + r.median.toFixed(1));
  expectToFail(() => checkLanes(r),
    "a drip of twenty-seven notes should fail the widest-lane test");
});

test("control: the belt it replaces fails the scatter test outright",
  async () => {
    /* The mutant is the shipping 2.80 formula verbatim -- `n * stride +
       offset`, stride 13, offset 6 -- which is the nicest kind of control to
       have: it does not invent a broken engine, it restores the one that was
       there. */
    const off = await arena(null, sabotage(
      "            x: r.margin + noteRoll(s0, 0) * (VW - 2 * r.margin) / 1024,",
      "            x: (n * 13 + 6) % VW,"));
    expectToFail(() => checkScatter(scatterOf(off.run(SCATTER))),
      "a note every thirteen pixels is a conveyor belt and should fail the " +
      "scatter test");
  });

/* ===================================================================== */
/* 3. THE SAME SHOWER ON BOTH MACHINES, AND ACROSS A REWIND              */
/* ===================================================================== */

const FIRST30 = "JSON.stringify(song(0, 3, false).sp.slice(0, 30)" +
  ".map(function (p) { return [+p[0].toFixed(6), +p[1].toFixed(6), +p[2].toFixed(6)]; }))";

test("two fresh engines build the identical shower", async () => {
  const a = await arena();
  const b = await arena();
  const ra = a.run(FIRST30), rb = b.run(FIRST30);
  assert.ok(JSON.parse(ra).length === 30, "precondition: thirty notes to compare");
  assert.equal(ra, rb,
    "every note's lane, height and fall speed is a pure function of the " +
    "note's index and the cast's seed, so two machines have to build the " +
    "same shower to the pixel -- these are HITBOXES, and a shower that " +
    "differed by one pixel would be a desync sixty times a second");
});

test("control: a shower rolled from Math.random differs between two engines",
  async () => {
    const mutant = sabotage(
      "            x: r.margin + noteRoll(s0, 0) * (VW - 2 * r.margin) / 1024,",
      "            x: r.margin + Math.floor(Math.random() * 1024) * (VW - 2 * r.margin) / 1024,");
    const a = await arena(null, mutant);
    const b = await arena(null, mutant);
    expectToFail(() => { assert.equal(a.run(FIRST30), b.run(FIRST30)); },
      "a shower that rolls dice should differ between two engines");
  });

test("a rewind taken across a hit reproduces the rest of the song", async () => {
  const { run } = await arena();
  const r = run("(function () {\n" +
    "  seat(0);\n" +
    "  tick(" + ULT + ", 0);\n" +
    "  for (var i = 0; i < 40; i++) tick(0, 0);\n" +
    "  var snap = saveSim();\n" +
    "  var mark = SPAWNED.length;\n" +
    "  function play() {\n" +
    /* A hit in the middle of the replay, because that is the case the stored
       seed exists for: update() returns on hitstop above the rain block, so a
       seed derived from battleFrames would change here and a stored one
       cannot. */
    "    for (var j = 0; j < 40; j++) {\n" +
    "      if (j === 8) applyHit(fighters[1], fighters[0], ROSTER.trev.jab, fighters[1].x);\n" +
    "      tick(0, 0);\n" +
    "    }\n" +
    "    return { hash: stateHash(),\n" +
    "             notes: JSON.stringify(SPAWNED.slice(mark).map(function (p) {\n" +
    "               return [+p[0].toFixed(6), +p[1].toFixed(6), +p[2].toFixed(6)]; })) };\n" +
    "  }\n" +
    "  var one = play();\n" +
    "  restoreSim(snap);\n" +
    "  SPAWNED.length = mark;\n" +
    "  projectiles.forEach(function (p) { if (p.spec === RAIN) p.__seen = true; });\n" +
    "  var two = play();\n" +
    "  return { h1: one.hash, h2: two.hash, n1: one.notes, n2: two.notes,\n" +
    "           count: JSON.parse(one.notes).length };\n" +
    "})()");
  assert.ok(r.count > 10,
    "precondition: the replayed stretch has to contain notes. Forty frames of " +
    "an `every: 6` song is about seven volleys where it used to be thirteen, " +
    "so this floor came down with the density. It had " + r.count);
  assert.equal(r.n2, r.n1,
    "every note spawned after the rewind has to land in the same lane at the " +
    "same speed as it did before it");
  assert.equal(r.h2, r.h1,
    "and the whole simulation with it. State hash " + r.h1 + " first time, " +
    r.h2 + " after the restore");
});

/* ===================================================================== */
/* 4. ONE SEED FOR THE WHOLE SONG, EVEN WHEN HE IS BEING PUNCHED         */
/* ===================================================================== */

function checkSeed(r) {
  assert.equal(r.seeds.length, 1,
    "a cast draws ONE seed and the whole song is a function of it. Being hit " +
    "must not change it: update() returns on hitstop ABOVE the rain block, so " +
    "rainTimer freezes while battleFrames runs on, and a seed derived from " +
    "their sum looks like a per-cast constant and is not. It took " +
    r.seeds.length + " different values inside one song");
  assert.equal(r.jolted, r.clean,
    "and the shower he gets while being punched has to be the shower he gets " +
    "when he is not -- same lanes, same speeds, note for note. This is the " +
    "one failure in this file that would otherwise ship silently: it looks " +
    "perfectly fine unless somebody is hitting him");
  assert.equal(r.notes, 81,
    "precondition: and the jolted song still delivers its whole 81; it had " +
    r.notes);
}

const SEED = "(function () {\n" +
  "  var a = song(0, 0, true);\n" +
  "  var b = song(0, 0, false);\n" +
  "  function shape(r) { return JSON.stringify(r.sp.map(function (p) {\n" +
  "    return [+p[0].toFixed(6), +p[1].toFixed(6), +p[2].toFixed(6)]; })); }\n" +
  "  return { seeds: a.seeds, jolted: shape(a), clean: shape(b),\n" +
  "           notes: a.sp.length };\n" +
  "})()";

test("the seed is drawn once and survives him being hit", async () => {
  const { run } = await arena();
  checkSeed(run(SEED));
});

test("control: a seed derived from battleFrames changes every time he is hit",
  async () => {
    /* The version that looks free and cannot survive a rollback wrong:
       battleFrames climbs by one a frame and rainTimer falls by one, so their
       sum is a per-cast constant -- right up until hitstop freezes one of
       them. Measured on the design build: thirteen, twenty and twenty-five
       different seeds inside one song. */
    const off = await arena(null, sabotage(
      "          const s0 = this.rainSeed * 977 + n;",
      "          const s0 = (battleFrames + this.rainTimer) * 977 + n;"));
    expectToFail(() => checkSeed(off.run(SEED)),
      "a derived seed should come apart the moment he is hitstopped");
  });

/* ===================================================================== */
/* 5. NOTHING FALLS OFF THE SIDE OF THE SCREEN                           */
/* ===================================================================== */

function checkBounds(r) {
  for (const s of r.stages) {
    assert.equal(s.notes, 81,
      "precondition: " + s.name + " has to get the whole song; it got " + s.notes);
    assert.ok(s.lo >= r.margin,
      "no note may spawn inside the left margin. The quaver is six pixels " +
      "wide drawn centred, so `margin` is what keeps every one of them wholly " +
      "on screen and leaves no lane at the wall. On " + s.name + " the " +
      "leftmost was " + s.lo.toFixed(1) + " against a margin of " + r.margin);
    assert.ok(s.hi <= r.vw - r.margin,
      "nor past the right one: the rightmost on " + s.name + " was " +
      s.hi.toFixed(1) + " against " + (r.vw - r.margin));
  }
}

const BOUNDS = "(function () {\n" +
  "  var out = [];\n" +
  "  for (var st = 0; st < STAGE_NAMES.length; st++) {\n" +
  "    var xs = song(st, 0, false).sp.map(function (p) { return p[0]; });\n" +
  "    out.push({ name: STAGE_NAMES[st], notes: xs.length,\n" +
  "               lo: Math.min.apply(null, xs), hi: Math.max.apply(null, xs) });\n" +
  "  }\n" +
  "  return { stages: out, margin: RAIN.margin, vw: VW };\n" +
  "})()";

test("every note spawns inside the margin, on all six stages", async () => {
  const { run } = await arena();
  checkBounds(run(BOUNDS));
});

test("control: without the margin the lanes at the walls are half off screen",
  async () => {
    const off = await arena(null, sabotage(
      "            x: r.margin + noteRoll(s0, 0) * (VW - 2 * r.margin) / 1024,",
      "            x: noteRoll(s0, 0) * VW / 1024,"));
    expectToFail(() => checkBounds(off.run(BOUNDS)),
      "notes spread over the whole width should fail the margin test");
  });

/* ===================================================================== */
/* 6. SHIELDBREAK IS BACK, AND ONE NOTE TAKES THE WHOLE BAR               */
/* ===================================================================== */

/* THIS SECTION IS THE 2.81 ONE INVERTED, and the inversion is the point.
   2.81 deleted `shieldBreak` and this file asserted it was gone; 2.84 was
   asked to put it back -- the notes "should still shield break" -- in the
   same change that halves the note count, which is the one variable the
   deletion had rested on.

   WHAT HALVING DOES NOT DO IS HALVE THIS. applyHit reads

       defender.shield -= move.shieldBreak ? COMBAT.shieldMax * 2 : dmg * 2.4

   so with the flag set a single note empties the whole bar regardless of
   `damage`, and the break is all-or-nothing. Measured over 120 trials of a
   man holding shield through a whole song, the break rate is 100% at 162
   notes and 100% at 81; what moved is the damage he eats while open, 19.1 to
   11.8, and the share of the song he spends in break stun, which went UP,
   34.4% to 37.2%, because fewer notes means fewer breaks cut short by the
   hitstun that replaces them.

   So the assertion is not "it breaks a bit less". It is that one note does
   the whole job, which is what the flag means, and that a whole song finds
   him. */

function checkShield(r) {
  assert.equal(r.shieldBreak, true,
    "`shieldBreak` has to be ON this move: 2.84 asked for notes that still " +
    "break a shield, and the flag is the only thing that does it. It read " +
    JSON.stringify(r.shieldBreak));
  assert.equal(r.survived, 0,
    "and a full shield has to fall to the FIRST note, not the seventh -- " +
    "shieldMax twice over is not a large number, it is an unconditional one. " +
    "It survived " + r.survived + " notes");
  assert.ok(r.perNote >= r.max,
    "which means the first note alone takes at least the whole bar: it took " +
    r.perNote + " off a shield of " + r.max);
  assert.equal(r.broke, true,
    "and the fighter has to actually end up in the break state, not merely " +
    "at zero shield -- a shield on nought that nobody knocked out of it is a " +
    "different bug. He was in state " + JSON.stringify(r.state));
}

const SHIELD = "(function () {\n" +
  "  seat(0);\n" +
  "  var f = fighters[1];\n" +
  "  f.setState('shield'); f.shield = COMBAT.shieldMax; f.invuln = 0;\n" +
  "  var first = null, took = 0;\n" +
  "  for (var i = 0; i < 12; i++) {\n" +
  "    var s0 = f.shield;\n" +
  "    applyHit(fighters[0], f, RAIN, f.x);\n" +
  "    if (first === null) first = s0 - f.shield;\n" +
  "    if (f.state !== 'shield' || f.shield <= 0) break;\n" +
  "    took++;\n" +
  "  }\n" +
  "  return { shieldBreak: RAIN.shieldBreak, survived: took, perNote: first,\n" +
  "           max: COMBAT.shieldMax, state: f.state, broke: f.state === 'break' };\n" +
  "})()";

test("one note takes a whole shield, and the man is broken out of it",
  async () => {
    const { run } = await arena();
    checkShield(run(SHIELD));
  });

test("control: without the flag a note is worth damage x 2.4 and seven of them break a bar",
  async () => {
    /* The 2.83 spec restored exactly -- the flag taken back off the line it
       now sits on. A note at 7 damage takes 16.8 shield, so a full bar wants
       six of them, and the first one leaves him standing there still holding
       it. That is the state this change was asked to end. */
    const off = await arena(null, sabotage(
      "      drop: 0.02, life: 200, shape: 'note', ghost: true, shieldBreak: true,",
      "      drop: 0.02, life: 200, shape: 'note', ghost: true,"));
    const r = off.run(SHIELD);
    assert.equal(r.shieldBreak, undefined,
      "precondition: the mutant really has no flag");
    assert.ok(r.survived >= 4,
      "precondition: and its notes really do chip rather than break -- it " +
      "survived " + r.survived + " of them");
    expectToFail(() => checkShield(r),
      "a shower whose notes only chip a shield should fail the shield test");
  });

/* AND THE SAME THING THROUGH A WHOLE SONG, which is the version a player
   would recognize: hold shield from the cast and see what happens. The probe
   above calls applyHit directly, so it proves what the FLAG does; this one
   proves that the shower actually reaches a man who is hiding from it, which
   is a different claim and the one the request was about. */

function checkHeldShield(r) {
  assert.ok(r.broke >= 5,
    "a man who holds shield for a whole song has to be broken out of it on " +
    "at least five of six stages -- that is what 'they should still shield " +
    "break' asks for. He broke on " + r.broke + " of " + r.n);
  assert.ok(r.byNote >= 5,
    "and broken BY A NOTE rather than by the shield's own drain, which would " +
    "have happened anyway and is not this move doing anything. A note did it " +
    r.byNote + " times");
  assert.ok(r.dealt > 8,
    "and it has to cost him: once the bar is gone he is a standing target " +
    "for the rest of the song. He took " + r.dealt.toFixed(1) + " on average");
}

const HELD = "(function () {\n" +
  "  var broke = 0, byNote = 0, dealt = 0, n = 0;\n" +
  "  for (var s = 0; s < STAGE_NAMES.length; s++) {\n" +
  "    seat(s);\n" +
  "    var T = fighters[1];\n" +
  "    T.invuln = 0; T.stocks = 99;\n" +
  "    var got = 0, hit = 0, real = applyHit;\n" +
  "    applyHit = function (a, d, m, sx, sc) {\n" +
  "      var h0 = d.health, st0 = d.state;\n" +
  "      var out = real(a, d, m, sx, sc);\n" +
  "      if (m === RAIN && d === T) {\n" +
  "        if (h0 - d.health > 0.0001) got += h0 - d.health;\n" +
  "        if (d.state === 'break' && st0 !== 'break') hit = 1;\n" +
  "      }\n" +
  "      return out;\n" +
  "    };\n" +
  "    tick(" + 256 + ", 0);\n" +
  "    var everBroke = 0;\n" +
  /* Past the end of the song, because the last notes cast are still in the
     air when rainTimer hits zero. */
  "    for (var i = 0; i < 260; i++) {\n" +
  "      tick(0, 128);\n" +
  "      if (T.state === 'break') everBroke = 1;\n" +
  "    }\n" +
  "    applyHit = real;\n" +
  "    broke += everBroke; byNote += hit; dealt += got; n++;\n" +
  "  }\n" +
  "  return { broke: broke, byNote: byNote, dealt: dealt / n, n: n };\n" +
  "})()";

test("holding shield through the whole song gets you broken out of it",
  async () => {
    const { run } = await arena();
    checkHeldShield(run(HELD));
  });

test("control: without the flag the song does not break a held shield",
  async () => {
    const off = await arena(null, sabotage(
      "      drop: 0.02, life: 200, shape: 'note', ghost: true, shieldBreak: true,",
      "      drop: 0.02, life: 200, shape: 'note', ghost: true,"));
    const r = off.run(HELD);
    expectToFail(() => checkHeldShield(r),
      "eighty-one chipping notes should not break a held shield often enough " +
      "to pass the held-shield test");
    /* The discriminator is the DAMAGE and not the break count, which is the
       thing this control taught when it was first written the other way. A
       chipping shower does eventually break a bar -- the shield's own drain
       and 16.8 a note get there on four stages of six -- but it gets there
       late, so he spends most of the song safe behind it and takes about a
       third of what the flag costs him. Measured: 11.8 with the flag against
       4.4 without. */
    assert.ok(r.dealt < 8,
      "and it has to fail for the stated reason -- without the flag the break " +
      "comes late and he is behind the shield for most of the song. He took " +
      r.dealt.toFixed(1));
  });

/* ===================================================================== */
/* 7. TWO LADEANES GET TWO SONGS                                         */
/* ===================================================================== */

function checkTwo(r) {
  assert.equal(r.aNotes, 81, "precondition: the first Ladeane's whole song");
  assert.equal(r.bNotes, 81, "precondition: and the second's");
  assert.notEqual(r.a, r.b,
    "two Ladeanes casting on the same frame have to get different showers, " +
    "or a mirror is one shower drawn twice and half the stage is safe. The " +
    "slot is folded into the seed for exactly this");
}

const TWO = "(function () {\n" +
  "  seat(0);\n" +
  "  fighters.forEach(function (f) { f.ultMeter = 999; });\n" +
  "  var bits = fighters.map(function (f) {\n" +
  "    return f.key === 'ladeane' ? " + ULT + " : 0; });\n" +
  "  tick.apply(null, bits);\n" +
  "  for (var i = 0; i < 200; i++) tick(0, 0, 0, 0);\n" +
  "  var lad = fighters.filter(function (f) { return f.key === 'ladeane'; });\n" +
  "  function shape(slot) {\n" +
  "    return JSON.stringify(SPAWNED.filter(function (p) { return p[4] === slot; })\n" +
  "      .map(function (p) { return [+p[0].toFixed(6), +p[2].toFixed(6)]; }));\n" +
  "  }\n" +
  "  var a = shape(lad[0].slot), b = shape(lad[1].slot);\n" +
  "  return { a: a, b: b, seats: lad.length,\n" +
  "           aNotes: JSON.parse(a).length, bNotes: JSON.parse(b).length };\n" +
  "})()";

test("two Ladeanes in a four-way get two different showers", async () => {
  const { run } = await arena(["ladeane", "trev", "ladeane", "kel"]);
  const r = run(TWO);
  assert.equal(r.seats, 2, "precondition: two Ladeanes are on the stage");
  checkTwo(r);
});

test("control: a seed that forgets the slot gives them one shower twice",
  async () => {
    const off = await arena(["ladeane", "trev", "ladeane", "kel"], sabotage(
      "          this.rainSeed = (battleFrames * 31 + this.slot) | 0;",
      "          this.rainSeed = (battleFrames * 31) | 0;"));
    expectToFail(() => checkTwo(off.run(TWO)),
      "two Ladeanes sharing a seed should fail the two-showers test");
  });

/* ===================================================================== */
/* 8. THE COST GUARD                                                     */
/* ===================================================================== */

function checkCost(r) {
  assert.ok(r.peak > 40,
    "precondition: both casts have to have actually run -- a single shower " +
    "peaks around thirty-four at 81 notes, where it peaked around sixty at " +
    "162. The peak was " + r.peak);
  assert.ok(r.peak < 200,
    "TWO simultaneous casts on the LAVA PIT is the worst case in the game: a " +
    "third of the shower falls past the island instead of dying on a floor " +
    "line, so nothing cleans up early. The bill is saveSim at about 1.75 us " +
    "a projectile a frame, and a rollback resimulating eight frames pays it " +
    "eight times. Peak concurrent projectiles must stay under two hundred; " +
    "it reached " + r.peak + ". The lever if this fails is `per` 3 -> 2, not " +
    "`duration` -- cutting the song short does not lower its peak");
  /* 2.84 HALVED THE HEADROOM PROBLEM RATHER THAN THE GUARD. Halving the
     density halves the concurrency -- measured 119 to 67 for two casts on
     this stage -- so this guard now has three times the room it had. The
     bound stays at 200 because 200 is a statement about saveSim's cost and
     not about this move; what changed is how far under it the move sits. */
  assert.ok(r.peak < 110,
    "and at 81 notes two casts have to sit WELL under it, around seventy, " +
    "because the density halved: a peak near the old 119 would mean `every` " +
    "had quietly gone back to 3. It was " + r.peak);
}

const COST = "(function () {\n" +
  "  var lava = STAGE_NAMES.indexOf('LAVA PIT');\n" +
  "  seat(lava < 0 ? 4 : lava);\n" +
  "  fighters.forEach(function (f) { f.ultMeter = 999; });\n" +
  "  var bits = fighters.map(function (f) {\n" +
  "    return f.key === 'ladeane' ? " + ULT + " : 0; });\n" +
  "  tick.apply(null, bits);\n" +
  "  var peak = 0;\n" +
  "  for (var i = 0; i < 320; i++) { tick(0, 0); if (alive() > peak) peak = alive(); }\n" +
  "  return { peak: peak, stage: STAGE.name, notes: SPAWNED.length };\n" +
  "})()";

test("two showers at once on the lava pit stay under the projectile guard",
  async () => {
    const { run } = await arena(["ladeane", "ladeane"]);
    const r = run(COST);
    assert.equal(r.stage, "LAVA PIT", "precondition: the worst stage");
    assert.equal(r.notes, 162, "precondition: both whole songs ran; " + r.notes);
    checkCost(r);
  });

test("control: ten notes a volley puts the peak over the guard", async () => {
  /* `per` is the lever the design names if this guard ever fails, and this is
     the same knob turned the wrong way -- which makes it the control that
     proves the guard can fail at all. It has to go further than it used to:
     at `every: 6` a volley is half as frequent, so seven a volley no longer
     reaches two hundred and ten is the honest number for this control. That
     is the guard's new headroom made visible rather than a weaker test. */
  const off = await arena(["ladeane", "ladeane"], sabotage(
    "      every: 6, per: 3, margin: 6, slow: 2.0, fast: 3.6,",
    "      every: 6, per: 10, margin: 6, slow: 2.0, fast: 3.6,"));
  const r = off.run(COST);
  assert.ok(r.peak >= 200,
    "precondition: ten a volley really does clear two hundred; it peaked at " +
    r.peak);
  expectToFail(() => checkCost(r),
    "ten notes a volley from two casts should break the projectile guard");
});

/* ===================================================================== */
/* 9. THE VOLLEY FALLOFF, WHICH IS WHAT MAKES "A LOT" SAFE               */
/* ===================================================================== */

/* THIS IS THE ONE THAT NEARLY SHIPPED BROKEN, and it is a whole class of bug
   worth naming: a comment that describes a safety valve, and a key that has
   to be present for the valve to exist at all.
 
   applyHit's falloff is gated on `if (move.count && move.count > 1)`. The ult
   carried no `count`, so the gate was false, so every note landed for a flat
   `damage` -- while the ROSTER comment beside `base` said, in the file's own
   voice, that "the volley falloff inside 40 frames is what makes a lot safe".
   The damage number was calibrated against a mechanism that was not running.

   RE-MEASURED AT 81 NOTES, because the key is worth less when there are
   fewer notes to fall off against. Pinned target, one whole song, 120 trials
   over all six stages: 19.7 damage with the key and 26.2 without, off the
   identical 3.7 notes that connect. At 162 notes the same probe read 26.6
   against 47.0 off 7.8 notes -- so the key has gone from saving 44% of the
   damage to saving 25% of it, and the chains it bites on are shorter.

   WHICH IS WHY THIS PROBE NOW SWEEPS STAGES. At 162 notes one song on one
   stage landed enough notes on a pinned man to see a chain four deep. At 81
   it lands three or four, so a single song is not a sample -- the probe casts
   on every stage and pools the hits, and the chain position is still read off
   applyHit's own counter rather than assumed.
 
   The test asks for the falloff by its effect -- the damages down a chain --
   rather than by reading `count`, because reading the key back would pass on
   a key that is set to 1. */

function checkFalloff(r) {
  assert.ok(r.hits.length >= 12,
    "precondition: the pooled songs have to land enough notes to see a chain " +
    "at all. They landed " + r.hits.length);
  const full = r.damage;
  /* Each entry is [how many notes of this move had already landed inside the
     last forty frames, what this one was worth]. Reading the CHAIN POSITION
     off applyHit's own counter rather than assuming the first recorded hit
     starts a chain: an isolated note more than forty frames after the last
     one legitimately lands for the full six, and a test that assumed
     otherwise would fail on a target the shower happens to miss for a while. */
  /* TWO DEEP, NOT FOUR, AND THAT IS A MEASUREMENT RATHER THAN A WEAKER TEST.
     At 162 notes a pinned man routinely took a note four deep into a chain,
     so this precondition asked for one. At 81 notes the chains are shorter --
     pooled over all six stages the positions reached run 0, 1 and 2 and stop
     there -- because fewer notes inside the same forty frames is exactly what
     halving the density means. Asking for four-deep here would be asserting
     something this move no longer does. What is asserted instead is that MORE
     THAN ONE STEP of the curve fires: a note that lands third into a chain
     has been multiplied by 0.5 where the second was multiplied by 0.7, and a
     shower with the gate off reaches position 0 and nothing else. */
  const depths = new Set(r.hits.map((h) => h[0]));
  assert.ok(depths.has(1) && depths.has(2),
    "precondition: notes have to land both second and third into a chain, or " +
    "there is no falloff to see. The chain positions were " +
    r.hits.map((h) => h[0]).join(","));
  for (const [k, dmg] of r.hits) {
    const want = full * r.falloff[Math.min(k, r.falloff.length - 1)];
    assert.ok(Math.abs(dmg - want) < 1e-6,
      "every note is worth COMBAT.volleyFalloff of a full hit, indexed by how " +
      "many of this move have already landed inside forty frames -- not some " +
      "other curve and not a flat six. Note number " + (k + 1) + " of its " +
      "chain should be " + want.toFixed(4) + " (" + full + " x " +
      r.falloff[Math.min(k, r.falloff.length - 1)] + ") and it was " + dmg);
  }
  assert.ok(r.hits.some((h) => h[0] === 0 && Math.abs(h[1] - full) < 1e-6),
    "and the FIRST note of a chain still hurts for all seven, which is the " +
    "half of this that makes the move worth casting at somebody who moves -- " +
    "and it is worth MORE at 81 notes than it was at 162, because a sparser " +
    "shower lets the forty-frame window lapse more often and more of its " +
    "notes are somebody's first");
}

const FALLOFF = "(function () {\n" +
  "  var hits = [];\n" +
  "  for (var st = 0; st < STAGE_NAMES.length; st++) {\n" +
  "  seat(st);\n" +
  "  var L = fighters[0], T = fighters[1];\n" +
  "  T.invuln = 0; T.stocks = 99;\n" +
  /* Read off applyHit rather than off the health bar. Two notes of a chord
     can land on the SAME frame, and a per-frame health delta adds them
     together into one entry -- which reads as a chain that stopped falling
     off. The per-hit number is the thing under test. */
  "  var real = applyHit;\n" +
  "  applyHit = function (a, d, m, sx, sc) {\n" +
  "    var h0 = d.health, k = (d.volleyOf === m && d.volleyBy === a.slot &&\n" +
  "                           d.volleySince <= 40) ? d.volleyHits : 0;\n" +
  "    var r = real(a, d, m, sx, sc);\n" +
  "    if (m === RAIN && h0 - d.health > 0.0001)\n" +
  "      hits.push([k, +(h0 - d.health).toFixed(4)]);\n" +
  "    return r;\n" +
  "  };\n" +
  "  tick(" + ULT + ", 0);\n" +
  "  for (var i = 0; i < 260; i++) {\n" +
  /* Pinned and healed: what is under test is the damage a chain of notes
     carries, not whether the target survives one. */
  "    T.vx = 0; T.vy = 0; T.hitstun = 0; T.hitstop = 0;\n" +
  "    tick(0, 0);\n" +
  "    if (T.health < 40) T.health = 100;\n" +
  "  }\n" +
  "  applyHit = real;\n" +
  "  }\n" +
  "  return { hits: hits, damage: RAIN.damage, falloff: COMBAT.volleyFalloff.slice() };\n" +
  "})()";

test("a chain of notes falls off, which is what makes eighty-one at seven safe",
  async () => {
    const { run } = await arena();
    const r = run(FALLOFF);
    assert.equal(r.damage, 7,
      "precondition: a note is worth seven now, up from six; it read " + r.damage);
    checkFalloff(r);
  });

test("control: without `count` the falloff never fires and every note is full price",
  async () => {
    /* The literal defect, restored. `count: 3` is the only thing standing
       between this move and 162 flat hits. */
    const off = await arena(null, sabotage("      count: 3,\n", ""));
    const r = off.run(FALLOFF);
    assert.ok(r.hits.length >= 12,
      "precondition: the mutant still lands the same notes -- what changes is " +
      "what they are worth, not how many connect. It landed " + r.hits.length);
    assert.ok(r.hits.every((h) => Math.abs(h[1] - r.damage) < 1e-6),
      "precondition: and every one of them really is full price without the " +
      "key. The damages were " + r.hits.map((h) => h[1]).join(","));
    expectToFail(() => checkFalloff(r),
      "with `count` gone from the ult every note must land for a flat seven " +
      "and fail the falloff test");
  });

/* ===================================================================== */
/* 10. FOUR SEATS, WHICH IS THE CASE THE GUARD WAS NOT WRITTEN FOR        */
/* ===================================================================== */

/* There is no duplicate-character guard in startBattle, so a four-player
   match can seat four Ladeanes and all four can cast on the same frame. The
   test above seats TWO because two is the worst case the design specified;
   this one says out loud that four is reachable and measures it. */

const COST4 = COST.replace("return { peak: peak", "return { seats: fighters.length, peak: peak");

test("four Ladeanes in one match still clear the projectile guard", async () => {
  const { run } = await arena(["ladeane", "ladeane", "ladeane", "ladeane"]);
  const r = run(COST4);
  r.two = run(COST).peak;
  assert.equal(r.seats, 4, "precondition: four seats; there were " + r.seats);
  assert.equal(r.stage, "LAVA PIT", "precondition: the worst stage");
  assert.ok(r.peak > 90,
    "precondition: four songs have to have actually run. At 81 notes apiece " +
    "that is around 135 where it used to be 234. Peak was " + r.peak);
  /* AND SINCE 2.84 IT CLEARS TWO HUNDRED COMFORTABLY, which is the one place
     in this file where halving the note count made something strictly easier.
     Four seats, all casting, with every fighter invulnerable so that nothing
     is ever consumed, used to peak at 234 -- over the stated guard, and this
     test said so rather than asserting a number it would fail. At `every: 6`
     the same worst case peaks at 135.

     The 200 was only ever a proxy for the thing that actually matters, which
     is saveSim's per-projectile clone, and the proxy is no longer the binding
     number for four seats. The arithmetic ceiling is four songs of 81 notes
     spawning over 162 frames and living about 66, i.e. 4 x 3 x 11 = 132 in
     steady state with a little slack at the start, so about 150 is the real
     roof and nothing here leaks past it.

     If this ever fails, the lever is `per` 3 -> 2 (54 notes; the scatter
     statistics are per-note and are unaffected) and NOT `duration`, which
     shortens the song without lowering its peak. */
  assert.ok(r.peak < 160,
    "four simultaneous showers is the most this game can produce and about " +
    "150 is the arithmetic ceiling of four songs at 81 notes. It peaked at " +
    r.peak);
  assert.ok(r.peak < 200,
    "and it is now UNDER the two-cast guard rather than over it, which it " +
    "was not before the density halved: " + r.peak);
  assert.ok(r.peak < r.two * 2.2,
    "and it has to scale sub-linearly off the two-cast peak of " + r.two +
    " -- anything near four times it would mean notes are outliving their " +
    "own fall. It was " + r.peak);
});
