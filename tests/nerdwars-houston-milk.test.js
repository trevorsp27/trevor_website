/* SPILT MILK -- the slipping, as 2.76 made it read.
 *
 * The numbers were never the problem. A fighter who walked into the spill and
 * let go of the stick at the near edge already coasted 39 pixels where dry
 * stone stopped him in 1.8, and turning round already cost him nineteen
 * frames against one. It still did not play as slippery, and two
 * measurements said why:
 *
 *   NOTHING ON SCREEN SAID SO. A body sliding on milk wore the same pose, at
 *   the same size, as one standing still, so the only evidence the player
 *   ever got was arriving somewhere they had not chosen -- which reads as the
 *   stick having failed rather than as the floor.
 *
 *   AND IT WAS SMALL. Thirty pixels is 19 frames of floor at a walk, and
 *   rendered over the stage's own tile with a fighter standing in it, 30x3 is
 *   a scuff on the stone rather than somewhere you have to decide about.
 *
 * So it is forty pixels now, with twice the tail on it, and the skid is drawn
 * and heard rather than left to be inferred. Both are pinned below.
 *
 * The THIRD thing -- a blow in milk carrying further than a blow on stone --
 * is pinned as a decision rather than as a behavior, with the measurement
 * that killed it, because it is the obvious thing to reach for and it makes
 * the milk worse for the man who throws it. The spray test has a NEGATIVE
 * CONTROL beside it: the same checker run against a copy of the engine with
 * one line changed in memory, asserting that the check then fails.
 *
 * The engine source is loaded directly, the way nerdwars-houston-newdeal.test.js
 * does, because none of this is reachable through NerdWars.fighters: PHYS,
 * Fighter.slick, the Puddle class and `projectiles` are all internals.
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
   interleaving different on every run. */
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
const SPRITES_SRC = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

/* A context that REMEMBERS its fillRects. The spill and the spray off a
   sliding fighter are both drawn in code rather than off a sheet, so what is
   painted is exactly a list of rectangles and a test can read it. */
function recordingContext(rects) {
  const state = { fillStyle: "#000", globalAlpha: 1 };
  return new Proxy({}, {
    get(target, key) {
      if (key === "__rects") return rects;
      if (key === "fillStyle") return state.fillStyle;
      if (key === "globalAlpha") return state.globalAlpha;
      if (key === "fillRect") {
        return (x, y, w, h) =>
          rects.push({ x, y, w, h, c: state.fillStyle, a: state.globalAlpha });
      }
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "measureText") return () => ({ width: 0 });
      if (key === "canvas") return { width: 320, height: 180 };
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) {
      if (key === "fillStyle") state.fillStyle = value;
      else if (key === "globalAlpha") state.globalAlpha = value;
      else target[key] = value;
      return true;
    },
  });
}

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {}, __on: {},
    getContext: () => recordingContext([]),
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

/* Takes the engine SOURCE rather than always reading it off disk, so a
   negative control can boot a mutated copy in a fresh vm. */
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
  vm.runInContext(SPRITES_SRC, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
                  { filename: "nerdwars.js" });
  vm.runInContext("var __rec = " + recordingContext.toString() + ";", sandbox);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return { run: (src) => vm.runInContext(src, sandbox), sandbox };
}

/* One line of the engine, changed in memory. Both halves are asserted: a
   needle that is missing, or is there twice, makes a control that silently
   mutates nothing or mutates the wrong thing, which is exactly the failure a
   negative control exists to rule out. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker, and it has to
   throw an assertion. Anything else is a broken checker rather than a failed
   test, and is let through so it shows up as itself. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

const RIGHT = 2;

/* Houston in seat 0 on stage 0, both fighters parked on the main floor with
   every timer that could eat an input cleared. `freezeFrames` especially:
   several moves set it, nothing else clears it, and a measurement that begins
   inside somebody else's freeze spends its frames on nothing. */
async function arena(engineSrc) {
  const booted = await bootEngine(engineSrc);
  const { run } = booted;
  const O = JSON.parse(run("JSON.stringify(ORDER)"));
  const H = O.indexOf("houston"), R = O.indexOf("reese");
  assert.ok(H >= 0 && R >= 0, "precondition: both fighters should be in ORDER");
  run("select.cursor=[" + H + ", " + R + "]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; practice=false; startBattle();");
  run("for (var i=0;i<90;i++) step();");
  assert.equal(run("fighters[0].key"), "houston",
    "precondition: houston should be in seat 0");
  run([
    "var MAIN, SPEC;",
    "SPEC = ROSTER.houston.specials.neutral.puddle;",
    "function seat() {",
    "  MAIN = STAGE.platforms.find(function (p) { return p.main; });",
    "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
    "  fighters.forEach(function (f) {",
    "    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;",
    "    f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;",
    "    f.grounded = true; f.y = MAIN.y; f.slick = 0; f.stocks = 9;",
    "    f.health = 100; f.eliminated = false; f.combo = 0;",
    "    f.sinceHitFrames = 999;",
    "  });",
    "  fighters[0].x = MAIN.x + 60; fighters[0].facing = 1;",
    "  fighters[1].x = MAIN.x + 260; fighters[1].facing = -1;",
    "  netplay.active = true;",
    "}",
    // Thrown by the OTHER fighter, so nothing here is accidentally measuring
    // an owner exemption -- there isn't one, and a test below says so.
    "function spill(at) {",
    "  var p = new Puddle(fighters[1], SPEC, at, MAIN.y);",
    "  projectiles.push(p);",
    "  return p;",
    "}",
    "function tick(a) { netplay.framePads = [bitsToPad(a || 0), bitsToPad(0)]; step(); }",
  ].join("\n"));
  return booted;
}

/* Walk him into a spill, let go of the stick at the near edge, and report
   where he comes to rest relative to the far edge of it. Dry is the same
   walk with no spill at all. */
const COAST = "(function (wet) {\n" +
  "  seat();\n" +
  "  var edge = fighters[0].x + 60;\n" +
  "  if (wet) spill(edge);\n" +
  "  var guard = 0;\n" +
  "  while (fighters[0].x < edge - SPEC.w / 2 && guard++ < 400) tick(" + RIGHT + ");\n" +
  "  var xin = fighters[0].x, i = 0;\n" +
  "  for (; i < 200; i++) { tick(0); if (fighters[0].vx === 0) break; }\n" +
  "  return { coast: +(fighters[0].x - xin).toFixed(2),\n" +
  "           past: +(fighters[0].x - (edge + SPEC.w / 2)).toFixed(2),\n" +
  "           frames: i };\n" +
  "})";

/* A blow taken standing in it, against the same blow on dry stone. The spill
   is laid ahead of him rather than under him so the slide has floor to happen
   on, which is what a spill is for. */
const SHOVE = "(function (wet, move) {\n" +
  "  seat();\n" +
  "  if (wet) spill(fighters[0].x + 30);\n" +
  "  tick(0);\n" +
  "  var x0 = fighters[0].x, air = 0;\n" +
  "  applyHit(fighters[1], fighters[0], move, fighters[0].x - 20);\n" +
  "  for (var i = 0; i < 400; i++) {\n" +
  "    tick(0);\n" +
  "    if (!fighters[0].grounded) air++;\n" +
  "    if (fighters[0].grounded && Math.abs(fighters[0].vx) < 0.02) break;\n" +
  "  }\n" +
  "  return { went: +(fighters[0].x - x0).toFixed(2), air: air };\n" +
  "})";

test("the spill takes the floor away: grip, stopping and the tail", async () => {
  /* The two numbers the floor answers with, read straight off the fighter. On
     dry ground they are 1 and groundFriction, which is exactly what the
     movement code did before there was anything to slip in. */
  const { run } = await arena();
  const r = run("(function () {\n" +
    "  seat();\n" +
    "  var dryGrip = fighters[0].grip(), dryStop = fighters[0].stopping();\n" +
    "  spill(fighters[0].x);\n" +
    "  tick(0); tick(0);\n" +
    "  var wetGrip = fighters[0].grip(), wetStop = fighters[0].stopping();\n" +
    "  var armed = fighters[0].slick;\n" +
    "  projectiles.length = 0;\n" +
    "  var i = 0;\n" +
    "  for (; i < 120 && fighters[0].slick > 0; i++) tick(0);\n" +
    "  return { dryGrip: dryGrip, dryStop: dryStop, wetGrip: wetGrip,\n" +
    "           wetStop: wetStop, armed: armed, spec: SPEC.slick, tail: i,\n" +
    "           grip: PHYS.slickGrip, fric: PHYS.slickFriction };\n" +
    "})()");

  assert.equal(r.dryGrip, 1, "dry ground must answer the stick exactly");
  assert.ok(r.dryStop < 0.6, "and stop him quickly; groundFriction was " + r.dryStop);
  assert.equal(r.wetGrip, r.grip,
    "standing in milk his grip should be PHYS.slickGrip; it was " + r.wetGrip);
  assert.equal(r.wetStop, r.fric,
    "and his friction PHYS.slickFriction; it was " + r.wetStop);
  assert.equal(r.armed, r.spec,
    "the spill arms the spec's whole tail every frame he stands in it: " +
    r.armed + " against " + r.spec);
  assert.equal(r.tail, r.spec,
    "and once it is gone the skid outlives it by exactly that tail; it ran " +
    r.tail + " frames against a spec of " + r.spec);
});

test("letting go at the near edge carries him out past the far one", async () => {
  /* Arriving somewhere you did not choose is the whole of what the move does,
     so the measurement that matters is not how far he went, it is that where
     he stopped is PAST the thing he walked into. */
  const { run } = await arena();
  const dry = run(COAST + "(false)");
  const wet = run(COAST + "(true)");

  assert.ok(dry.coast < 3,
    "precondition: on dry stone letting go stops him almost at once; he went " +
    dry.coast);
  assert.ok(wet.coast > run("SPEC.w"),
    "in milk the same release should carry him further than the width of the " +
    "spill; he went " + wet.coast + " across a " + run("SPEC.w") + "px spill");
  assert.ok(wet.past > 6,
    "and it should put him clear of the far edge rather than stopping him " +
    "inside it; he came to rest " + wet.past + "px past it");
});

test("a blow lands the same in milk as on stone, and that is a decision",
  async () => {
    /* THE THING THAT WAS TRIED AND BACKED OUT, pinned here so the next person
       to reach for it reads the measurement before they spend it again.

       COMBAT.hitstunDrag is a flat 0.22 a frame and never asks what is
       underfoot, so a jab shoves a fighter 10.8 pixels on dry stone and 10.8
       pixels in a spill. Quartering that drag while `slick` runs makes the
       milk do the one slip every player already knows -- a jab carries 25.9
       instead, a soccerball 77 instead of 31 -- and it costs the man who
       throws the milk almost ten points of win rate. He slips in his own
       spill on purpose, the spill is the thing he stands behind, and he is
       the lightest fighter on the roster: a floor that lengthens every shove
       lengthens his the most and carries him off the side. 44.7% with the
       floor left alone against 35.0% at a quarter drag, five arms of 400 CPU
       matches each, patched at runtime so nothing else differed.

       So the slip is control and never carry. This asserts that, to the
       pixel, and the note above PHYS.slickGrip has the rest of it. */
    const { run } = await arena();
    const dry = run(SHOVE + "(false, ROSTER.kel.jab)");
    const wet = run(SHOVE + "(true, ROSTER.kel.jab)");

    assert.ok(dry.went > 4, "precondition: the jab should shove him at all");
    assert.ok(wet.air > 0, "precondition: and put him in the air, as every " +
      "non-graze hit does -- which is why a grounded test for this would " +
      "measure nothing either way");
    assert.ok(Math.abs(wet.went - dry.went) < 1,
      "a shove must travel the same in a spill as on stone: dry " + dry.went +
      ", wet " + wet.went + ". Milk takes the floor away from somebody " +
      "PRESSING something; it does not throw people further.");
  });


test("a fighter sliding on milk throws milk", async () => {
  /* The slip used to be invisible, which is the whole reason it did not read
     as a slip. Cosmetic and deliberately so: addEffect returns null while
     resimulating, so this cannot desync anybody and is never part of a
     snapshot. */
  const check = (m) => {
    assert.ok(m.moving > 6,
      "a fighter carried across a spill should throw milk off his feet; " +
      m.moving + " droplets in " + m.frames + " frames of sliding");
    assert.equal(m.parked, 0,
      "and a fighter standing still in the same spill should throw none; he " +
      "threw " + m.parked);
  };
  /* The list is emptied after every frame and whatever milk is in it counted,
     which is the only honest way to count spawns: updateEffects runs later in
     the same step() and has already ticked a fresh droplet's `t` to 1 by the
     time the frame is over, so "t === 0" finds nothing forever. */
  const measure = (r) => r("(function () {\n" +
    "  var n = 0, f = 0, i = 0, parked = 0;\n" +
    "  function drain() {\n" +
    "    var c = 0;\n" +
    "    for (i = 0; i < effects.length; i++) if (effects[i].kind === 'milk') c++;\n" +
    "    effects.length = 0;\n" +
    "    return c;\n" +
    "  }\n" +
    "  seat();\n" +
    "  var edge = fighters[0].x + 60;\n" +
    "  spill(edge);\n" +
    "  var guard = 0;\n" +
    "  while (fighters[0].x < edge - SPEC.w / 2 && guard++ < 400) tick(" + RIGHT + ");\n" +
    "  drain();\n" +
    "  for (; f < 40 && fighters[0].vx !== 0; f++) { tick(0); n += drain(); }\n" +
    "  seat();\n" +
    "  spill(fighters[0].x);\n" +
    "  drain();\n" +
    "  for (var j = 0; j < 40; j++) { tick(0); fighters[0].vx = 0; parked += drain(); }\n" +
    "  return { moving: n, frames: f, parked: parked };\n" +
    "})()");

  const { run } = await arena();
  check(measure(run));

  /* NEGATIVE CONTROL: the spray comes out, and the slip goes back to being
     something a player can only infer from where they ended up. */
  const { run: broken } = await arena(sabotage(
    "const e = addEffect('milk', this.x + back * 4, this.y - 2);",
    "const e = null;"));
  const m = measure(broken);
  expectToFail(() => check(m),
    "with the spray removed a sliding fighter threw " + m.moving +
    " droplets, which this check should have rejected");
});

test("the spill is drawn with edges, on the floor rather than above it", async () => {
  /* Three pale rows on gray speckled stone have a middle and no ends: the
     last pixels at either side dissolve into the tile's own speckle, and the
     ends are precisely what a player has to judge -- where to stop, where to
     start, where the skid will put them. One dark row the width of the box
     makes the near edge and the far edge lines instead of a guess. */
  const { run } = await arena();
  const r = run("(function () {\n" +
    "  seat();\n" +
    "  var p = spill(fighters[0].x + 40);\n" +
    "  var out = {};\n" +
    "  [['fresh', 60], ['curdled', SPEC.curdle + 30]].forEach(function (pair) {\n" +
    "    p.t = pair[1];\n" +
    "    var g = __rec([]);\n" +
    "    p.draw(g);\n" +
    "    var rects = g.__rects;\n" +
    "    var widest = 0, rim = null, top = 99, bottom = -99;\n" +
    "    for (var i = 0; i < rects.length; i++) {\n" +
    "      var q = rects[i];\n" +
    "      if (q.w > widest) widest = q.w;\n" +
    "      if (q.w === SPEC.w && q.y === p.y) rim = q;\n" +
    "      if (q.y - p.y < top) top = q.y - p.y;\n" +
    "      if (q.y - p.y > bottom) bottom = q.y - p.y;\n" +
    "    }\n" +
    "    out[pair[0]] = { widest: widest, rim: rim && rim.c, top: top,\n" +
    "                     bottom: bottom, n: rects.length };\n" +
    "  });\n" +
    "  out.w = SPEC.w; out.y = p.y;\n" +
    "  return out;\n" +
    "})()");

  for (const state of ["fresh", "curdled"]) {
    const s = r[state];
    assert.equal(s.widest, r.w,
      state + " milk should be drawn the full width of its own box (" + r.w +
      "); the widest row was " + s.widest);
    assert.ok(s.rim,
      state + " milk needs a full-width row ON the floor line to give it " +
      "edges; there was none at y " + r.y);
    assert.equal(s.bottom, 0,
      state + " milk must not be painted below the floor it is lying on");
    assert.ok(s.top >= -4,
      state + " milk is a spill and not a wall; its top row was " + (-s.top) +
      "px up");
  }
  assert.notEqual(r.fresh.rim, r.curdled.rim,
    "fresh and curdled must not share a rim colour -- the two states are the " +
    "whole of what a player has to read off it");
});

test("he slips in his own milk, and nobody slips over it", async () => {
  /* A floor hazard you can stand in safely is a wall. The owner exemption
     resolveCombat applies on principle is deliberately not applied here --
     the slip is not a hit -- and the box is thin and sits ON the platform,
     which is what makes it something you STEP in rather than something you
     collide with. */
  const { run } = await arena();
  const r = run("(function () {\n" +
    "  seat();\n" +
    "  projectiles.push(new Puddle(fighters[0], SPEC, fighters[0].x, MAIN.y));\n" +
    "  tick(0); tick(0);\n" +
    "  var owner = fighters[0].slick;\n" +
    "  seat();\n" +
    "  spill(fighters[0].x);\n" +
    "  fighters[0].grounded = false; fighters[0].y -= 22;\n" +
    "  tick(0);\n" +
    "  return { owner: owner, over: fighters[0].slick, h: SPEC.h };\n" +
    "})()");
  assert.ok(r.owner > 0,
    "Houston has to slip in his own spill; his slick read " + r.owner);
  assert.equal(r.over, 0,
    "and a fighter in the air over a " + r.h + "px-tall box must not; his " +
    "slick read " + r.over);
});
