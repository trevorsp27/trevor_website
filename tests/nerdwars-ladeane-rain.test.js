/* THE STROKES -- the note rain, after 2.81 turned a conveyor belt into a song.
 *
 * "spiky music notes start falling from ceiling to deal damage", and for two
 * releases they fell in a straight diagonal line: an even sweep at one
 * constant speed, `n * stride + offset` with a small wobble bolted on. The
 * lag-1 autocorrelation of consecutive spawn positions was +0.78 and the mean
 * step between them was 20.8 px, which is the number that says "belt" out
 * loud. Forty of them at 15 damage each read as a drip. Now there are a
 * hundred and sixty-two at 6, arriving in chords of three, scattered.
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
 * note count it does not deliver. 162 = 54 x 3. It is checked here rather
 * than remembered, because the only evidence of getting it wrong is a note
 * that is not there.
 *
 * WHY THE SCATTER IS MEASURED POOLED. Lag-1 over a single 162-note cast has a
 * standard error of about 1 / sqrt(162) = 0.079, so a +-0.15 window is under
 * two sigma and roughly one cast in sixteen will step outside it by chance --
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
/* 1. A HUNDRED AND SIXTY-TWO, AND IT DIVIDES                            */
/* ===================================================================== */

function checkCount(r) {
  assert.equal(r.duration % r.every, 0,
    "`duration` has to be a whole multiple of `every` -- 162 is 54 threes -- " +
    "or the last beat of the song is cut off mid-bar and the only evidence " +
    "is a note that is not there. This is the bakery's 78-vs-80 trap wearing " +
    "a different move: " + r.duration + " over " + r.every);
  assert.equal(r.notes, (r.duration / r.every) * r.per,
    "and the song has to deliver exactly the count the ROSTER advertises: " +
    (r.duration / r.every) * r.per + " from duration " + r.duration +
    ", every " + r.every + ", per " + r.per + ". It delivered " + r.notes);
  assert.equal(r.notes, 162,
    "which is a hundred and sixty-two; it was " + r.notes);
  assert.equal(r.volleys, r.duration / r.every,
    "arriving in " + r.duration / r.every + " volleys; there were " + r.volleys);
  assert.equal(r.biggestVolley, r.per,
    "of " + r.per + " apiece, on the same frame -- a chord reads as music " +
    "where a drip reads as a drip. The biggest was " + r.biggestVolley);
  assert.equal(r.smallestVolley, r.per,
    "and none of them short; the smallest was " + r.smallestVolley);
}

const COUNT = "(function () {\n" +
  "  var r = song(0, 0, false);\n" +
  "  var byFrame = {};\n" +
  "  r.sp.forEach(function (p) { byFrame[p[5]] = (byFrame[p[5]] || 0) + 1; });\n" +
  "  var sizes = Object.keys(byFrame).map(function (k) { return byFrame[k]; });\n" +
  "  return { notes: r.sp.length, volleys: sizes.length,\n" +
  "           biggestVolley: Math.max.apply(null, sizes),\n" +
  "           smallestVolley: Math.min.apply(null, sizes),\n" +
  "           duration: RAIN.duration, every: RAIN.every, per: RAIN.per };\n" +
  "})()";

test("a hundred and sixty-two notes, fifty-four chords of three", async () => {
  const { run } = await arena();
  checkCount(run(COUNT));
});

test("control: a duration that does not divide advertises a count it misses",
  async () => {
    /* 160 still spawns 54 volleys -- the last beat starts on step 159 and the
       song ends on 159 -- so the shower LOOKS right and the ROSTER's own
       arithmetic says 160 notes while 162 arrive. That is exactly the failure
       mode this test exists for: nothing on screen says anything. */
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
    "cast the same statistic has a standard error of 0.079 and is a coin at " +
    "this window -- see the head of this file.)");
  assert.ok(r.pooledStep > 80,
    "and the mean step between one note and the next has to be most of the " +
    "stage rather than a stride: " + r.pooledStep.toFixed(1) + " px, against " +
    "the belt's 20.8");
  assert.ok(r.widest < 15,
    "and there must be nowhere to stand for the whole song: the widest empty " +
    "strip over a single cast was " + r.widest.toFixed(1) + " px, against the " +
    "15 a body needs");
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
  assert.ok(r.count > 20,
    "precondition: the replayed stretch has to contain notes; it had " + r.count);
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
  assert.equal(r.notes, 162,
    "precondition: and the jolted song still delivers its whole 162; it had " +
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
    assert.equal(s.notes, 162,
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
/* 6. SHIELDBREAK IS REALLY GONE                                         */
/* ===================================================================== */

function checkShield(r) {
  assert.equal(r.shieldBreak, undefined,
    "`shieldBreak` has to be gone from the spec entirely, not merely small. " +
    "It took shieldMax twice over and handed a ninety-frame break stun out " +
    "UNDER the shower: measured, holding shield broke 100% of the time and " +
    "spent a third of the window stunned, worst unbroken stun 109 frames. At " +
    "four times the note count that is not counterplay, it is a guaranteed " +
    "stun. It read " + JSON.stringify(r.shieldBreak));
  assert.ok(r.survived >= 6,
    "a full shield has to survive at least six notes, so that hiding is a " +
    "shield that runs out rather than one that betrays you. It broke after " +
    r.survived);
  assert.ok(r.perNote > 0,
    "precondition: a note still costs the shield something: " + r.perNote);
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
  "           max: COMBAT.shieldMax };\n" +
  "})()";

test("a full shield survives a handful of notes rather than breaking on one",
  async () => {
    const { run } = await arena();
    checkShield(run(SHIELD));
  });

test("control: with shieldBreak back, one note takes the whole shield",
  async () => {
    const off = await arena(null, sabotage(
      "      drop: 0.02, life: 200, shape: 'note', ghost: true,",
      "      drop: 0.02, life: 200, shape: 'note', ghost: true, shieldBreak: true,"));
    expectToFail(() => checkShield(off.run(SHIELD)),
      "a note that takes shieldMax twice over should fail the shield test");
  });

/* ===================================================================== */
/* 7. TWO LADEANES GET TWO SONGS                                         */
/* ===================================================================== */

function checkTwo(r) {
  assert.equal(r.aNotes, 162, "precondition: the first Ladeane's whole song");
  assert.equal(r.bNotes, 162, "precondition: and the second's");
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
  assert.ok(r.peak > 100,
    "precondition: both casts have to have actually run -- a single shower " +
    "peaks around sixty. The peak was " + r.peak);
  assert.ok(r.peak < 200,
    "TWO simultaneous casts on the LAVA PIT is the worst case in the game: a " +
    "third of the shower falls past the island instead of dying on a floor " +
    "line, so nothing cleans up early. The bill is saveSim at about 1.75 us " +
    "a projectile a frame, and a rollback resimulating eight frames pays it " +
    "eight times. Peak concurrent projectiles must stay under two hundred; " +
    "it reached " + r.peak + ". The lever if this fails is `per` 3 -> 2, not " +
    "`duration` -- cutting the song short does not lower its peak");
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
    assert.equal(r.notes, 324, "precondition: both whole songs ran; " + r.notes);
    checkCost(r);
  });

test("control: six notes a volley puts the peak over the guard", async () => {
  /* `per` is the lever the design names if this guard ever fails, and this
     is the same knob turned the wrong way -- which makes it the control that
     proves the guard can fail at all. */
  const off = await arena(["ladeane", "ladeane"], sabotage(
    "      every: 3, per: 3, margin: 6, slow: 2.4, fast: 4.2,",
    "      every: 3, per: 7, margin: 6, slow: 2.4, fast: 4.2,"));
  expectToFail(() => checkCost(off.run(COST)),
    "seven notes a volley from two casts should break the projectile guard");
});

/* ===================================================================== */
/* 9. THE VOLLEY FALLOFF, WHICH IS WHAT MAKES "A LOT" SAFE               */
/* ===================================================================== */

/* THIS IS THE ONE THAT NEARLY SHIPPED BROKEN, and it is a whole class of bug
   worth naming: a comment that describes a safety valve, and a key that has
   to be present for the valve to exist at all.
 
   applyHit's falloff is gated on `if (move.count && move.count > 1)`. The ult
   carried no `count`, so the gate was false, so every one of a hundred and
   sixty-two notes landed for a flat six -- while the ROSTER comment beside
   `base` said, in the file's own voice, that "the volley falloff inside 40
   frames is what makes a lot safe". The damage number was calibrated against
   a mechanism that was not running. Measured on a pinned target through one
   whole song, 120 trials over all six stages: 52.5 damage without the key,
   25.6 with it, off the identical 8.5 notes that actually connect.
 
   The test asks for the falloff by its effect -- the damages down a chain --
   rather than by reading `count`, because reading the key back would pass on
   a key that is set to 1. */

function checkFalloff(r) {
  assert.ok(r.hits.length >= 8,
    "precondition: the song has to land enough notes to see a chain at all. " +
    "It landed " + r.hits.length);
  const full = r.damage;
  /* Each entry is [how many notes of this move had already landed inside the
     last forty frames, what this one was worth]. Reading the CHAIN POSITION
     off applyHit's own counter rather than assuming the first recorded hit
     starts a chain: an isolated note more than forty frames after the last
     one legitimately lands for the full six, and a test that assumed
     otherwise would fail on a target the shower happens to miss for a while. */
  const deep = r.hits.filter((h) => h[0] >= 3).length;
  assert.ok(deep > 0,
    "precondition: at least one note has to land four-deep into a chain, or " +
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
    "and the FIRST note of a chain still hurts for all six, which is the " +
    "half of this that makes the move worth casting at somebody who moves");
}

const FALLOFF = "(function () {\n" +
  "  seat(0);\n" +
  "  var L = fighters[0], T = fighters[1];\n" +
  "  T.invuln = 0; T.stocks = 99;\n" +
  /* Read off applyHit rather than off the health bar. Two notes of a chord
     can land on the SAME frame, and a per-frame health delta adds them
     together into one entry -- which reads as a chain that stopped falling
     off. The per-hit number is the thing under test. */
  "  var hits = [], real = applyHit;\n" +
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
  "  return { hits: hits, damage: RAIN.damage, falloff: COMBAT.volleyFalloff.slice() };\n" +
  "})()";

test("a chain of notes falls off, which is what makes a hundred and sixty-two safe",
  async () => {
    const { run } = await arena();
    checkFalloff(run(FALLOFF));
  });

test("control: without `count` the falloff never fires and every note is full price",
  async () => {
    /* The literal defect, restored. `count: 3` is the only thing standing
       between this move and 162 flat hits. */
    const off = await arena(null, sabotage("      count: 3,\n", ""));
    expectToFail(() => checkFalloff(off.run(FALLOFF)),
      "with `count` gone from the ult every note must land for a flat six " +
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
  assert.ok(r.peak > 120,
    "precondition: four songs have to have actually run. Peak was " + r.peak);
  /* AND IT DOES NOT CLEAR TWO HUNDRED, which is why this test exists and
     says so rather than asserting a number it would fail. The design's guard
     was written for TWO simultaneous casts and two is what it holds for --
     109 in a live match, 173 with nothing intercepting. Four seats, all
     casting, with every fighter invulnerable so that nothing is ever
     consumed, peaks at 234.

     That is over the stated 200 and it is NOT a reason to pull `per`. The
     200 was only ever a proxy for the thing that actually matters, which is
     saveSim's per-projectile clone: measured at this peak it costs about
     1.4% of a 16.7 ms frame, inside the 2% the design named, and a rollback
     resimulating eight frames pays roughly 1.9 ms of a 16.7 ms budget. The
     arithmetic ceiling is four songs of 162 notes spawning over 162 frames
     and living about 66, i.e. 4 x 3 x 22 = 264, so 260 is the real roof and
     nothing here leaks past it.

     If this ever fails, the lever is `per` 3 -> 2 (108 notes; the scatter
     statistics are per-note and are unaffected) and NOT `duration`, which
     shortens the song without lowering its peak. */
  assert.ok(r.peak < 260,
    "four simultaneous showers is the most this game can produce and 264 is " +
    "the arithmetic ceiling of four songs. It peaked at " + r.peak);
  assert.ok(r.peak < r.two * 2.2,
    "and it has to scale sub-linearly off the two-cast peak of " + r.two +
    " -- anything near four times it would mean notes are outliving their " +
    "own fall. It was " + r.peak);
});
