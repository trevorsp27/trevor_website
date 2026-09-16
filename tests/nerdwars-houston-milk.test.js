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
    "    f.grounded = true; f.y = MAIN.y; f.slick = 0; f.slickFoe = 0; f.stocks = 9;",
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

test("he skates on his own milk: the stick back, the brakes not", async () => {
  /* WHOSE FLOOR IT IS, and it is the half of this move that was missing.

     A floor hazard its owner can stand on safely is a wall, so he is not
     exempt from it -- `slick` is armed on him exactly as before and
     stopping() still answers PHYS.slickFriction, which carries a walk 52
     pixels and will carry him off the ledge behind his own spill. What he
     gets back is grip: he can turn, accelerate and close through it, and
     nobody else can.

     The measurement that bought the split is in Fighter.slickFoe. Across a
     hundred CPU matches he spent 345 frames a match with no traction and 339
     of them were in milk he had thrown himself, against 386 for the man
     opposite -- a move whose owner was very nearly its own best victim.

     Turning round is what grip actually buys, so it is measured rather than
     inferred: from a walk one way to a walk the other, inside the spill. */
  const { run } = await arena();
  const READ = "(function (mine) {\n" +
    "  seat();\n" +
    "  if (mine) projectiles.push(new Puddle(fighters[0], SPEC, fighters[0].x, MAIN.y));\n" +
    "  else spill(fighters[0].x);\n" +
    "  tick(0); tick(0);\n" +
    "  return { slick: fighters[0].slick, foe: fighters[0].slickFoe,\n" +
    "           grip: fighters[0].grip(), stop: fighters[0].stopping() };\n" +
    "})";
  const mine = run(READ + "(true)"), theirs = run(READ + "(false)");
  const GRIP = run("PHYS.slickGrip"), FRIC = run("PHYS.slickFriction");

  assert.ok(mine.slick > 0,
    "he is still standing in milk in his own spill; his slick read " + mine.slick);
  assert.equal(mine.stop, FRIC,
    "and he still has no brakes in it -- that is the half he keeps paying; " +
    "his friction read " + mine.stop);
  assert.equal(mine.grip, 1,
    "but the stick answers in his own milk; his grip read " + mine.grip);
  assert.equal(mine.foe, 0,
    "and slickFoe is what says whose it is, so his own must leave it at 0; " +
    "it read " + mine.foe);

  assert.equal(theirs.grip, GRIP,
    "in somebody else's spill he loses the stick like everybody else; his " +
    "grip read " + theirs.grip);
  assert.equal(theirs.stop, FRIC,
    "and the brakes with it; his friction read " + theirs.stop);
  assert.ok(theirs.foe > 0,
    "and slickFoe has to be armed for that to be true; it read " + theirs.foe);

  /* The consequence, in frames, because two numbers off a getter are only
     worth what they do to a body that is moving. */
  const TURN = "(function (mine) {\n" +
    "  seat();\n" +
    "  var at = fighters[0].x + 40;\n" +
    "  if (mine) projectiles.push(new Puddle(fighters[0], SPEC, at, MAIN.y));\n" +
    "  else spill(at);\n" +
    "  for (var i = 0; i < 40; i++) tick(" + RIGHT + ");\n" +
    "  var n = 0;\n" +
    "  for (; n < 200; n++) { tick(1); if (fighters[0].vx < -1) break; }\n" +
    "  return n;\n" +
    "})";
  const own = run(TURN + "(true)"), foe = run(TURN + "(false)");
  assert.ok(own < foe / 3,
    "turning round in his own spill should cost a fraction of what it costs " +
    "in somebody else's; it took " + own + " frames against " + foe);
});

test("a fighter in the air over the spill touches none of it", async () => {
  /* The box is thin and sits ON the platform, which is what makes it
     something you STEP in rather than something you collide with: a
     fighter's hurtbox runs from their feet to fourteen above, so anyone on
     the ground in it overlaps and anyone jumping it does not. */
  const { run } = await arena();
  const r = run("(function () {\n" +
    "  seat();\n" +
    "  spill(fighters[0].x);\n" +
    "  fighters[0].grounded = false; fighters[0].y -= 22;\n" +
    "  tick(0);\n" +
    "  return { slick: fighters[0].slick, foe: fighters[0].slickFoe, h: SPEC.h };\n" +
    "})()");
  assert.equal(r.slick, 0,
    "a fighter in the air over a " + r.h + "px-tall box must not slip; his " +
    "slick read " + r.slick);
  assert.equal(r.foe, 0,
    "and must not lose grip either; his slickFoe read " + r.foe);

  /* AND THE OWNER GETS NOTHING EITHER, which is the cheapest possible guard
     on the drink: it rides in the same loop off the same overlap, so a box()
     that ever grew tall enough to catch a jumping man would start feeding
     Houston in mid-air, and this is the one line that would say so. */
  const own = run(`(function () {
    seat();
    fighters[1].x = MAIN.x + 180;
    fighters[0].health = 40;
    projectiles.push(new Puddle(fighters[0], SPEC, fighters[0].x, MAIN.y));
    var up = 0;
    for (var i = 0; i < 60; i++) {
      fighters[0].grounded = false; fighters[0].y = MAIN.y - 22; fighters[0].vy = 0;
      var was = fighters[0].health;
      tick(0);
      if (fighters[0].health > was + 1e-12) up++;
    }
    return { up: up, health: fighters[0].health };
  })()`);
  assert.equal(own.up, 0,
    "the man who spilt it must not drink it from the air either; he gained " +
    "on " + own.up + " frames and ended on " + own.health);
});

/* =====================================================================
   THE DRINK
   ===================================================================== */

/* Fresh milk pays its owner back, slowly, and only until it turns. It is the
   fifth heal in the file and the first one that happens because of where
   somebody is STANDING rather than because of an event -- so what is worth
   pinning is the four things that stop it being a fountain: it is his and
   nobody else's, it lasts exactly the fresh window and not a frame longer, it
   stops at full health, and one man only ever has one spill going.
 *
 * The arithmetic those four hold up: `curdle` times `heal` is 5.5 for a whole
 * spill drunk end to end, and he cannot even collect that, because the carton
 * always flies forward and he has to walk to it.
 *
 * EVERY PROBE BELOW PARKS THE OTHER MAN at MAIN.x + 180. seat() leaves him at
 * +260, which is past the right edge of the main floor: he walks off, loses a
 * stock, and the KO freeze then eats a quarter of the frames of anything that
 * runs longer than a second. The tests above are all short enough not to care;
 * these count frames, so they do. */
function checkDrink(d) {
  assert.equal(d.rates.length, 1,
    "the drink is one flat rate and nothing modulates it; the frames it " +
    "healed on moved the bar by " + d.rates.join(", "));
  assert.ok(Math.abs(d.rates[0] - d.heal) < 1e-9,
    "and that rate is the roster's `heal`, " + d.heal + " a frame; it moved " +
    d.rates[0]);
  assert.equal(d.frames, d.curdle,
    "it lasts exactly the FRESH window -- `curdle` frames, " + d.curdle +
    " of them -- and not one more. This is the anti-fountain assertion: the " +
    "spill is on the floor for " + d.life + " frames and only the first " +
    d.curdle + " of them feed him. It healed on " + d.frames);
  assert.ok(Math.abs(d.total - d.curdle * d.heal) < 1e-9,
    "so a whole fresh spill stood in end to end is worth " +
    (d.curdle * d.heal).toFixed(2) + " and nothing beats it; he got " + d.total);
  assert.equal(d.last + 1, d.curdledFrom,
    "and the last point of health lands on the frame before it turns -- the " +
    "ring that says the bite is armed is the same ring that says the drink " +
    "is over, which is one thing for a player to learn instead of two. Last " +
    "drink on " + d.last + ", first curdled frame " + d.curdledFrom);
}

const DRINK = `(function () {
  seat();
  fighters[1].x = MAIN.x + 180;
  fighters[0].health = 40;
  var p = new Puddle(fighters[0], SPEC, fighters[0].x, MAIN.y);
  projectiles.push(p);
  var d = { frames: 0, first: 0, last: 0, curdledFrom: 0, total: 0, rates: [] };
  var prev = fighters[0].health;
  for (var i = 1; i <= SPEC.life + 10; i++) {
    var was = p.curdled();
    fighters[0].vx = 0;
    tick(0);
    if (was && !d.curdledFrom) d.curdledFrom = i;
    var hp = fighters[0].health;
    if (hp > prev + 1e-12) {
      d.frames++; if (!d.first) d.first = i; d.last = i;
      d.total += hp - prev;
      var r = +(hp - prev).toFixed(9);
      if (d.rates.indexOf(r) < 0) d.rates.push(r);
    }
    prev = hp;
  }
  d.total = +d.total.toFixed(9);
  d.curdle = SPEC.curdle; d.heal = SPEC.heal; d.life = SPEC.life;
  return d;
})()`;

test("he drinks his own fresh milk, slowly, and stops when it turns", async () => {
  const { run } = await arena();
  checkDrink(run(DRINK));
});

test("control: a drink handed to everybody but the owner fails the drink test",
  async () => {
    /* The fork written backwards. It is the one line in the whole move that
       asks whose milk this is, and it sits two lines under the `slickFoe`
       fork that asks the same question the other way round -- which is
       exactly the kind of neighbourhood a sign gets flipped in. */
    const { run } = await arena(sabotage(
      "      if (drink && f === this.owner && f.health < COMBAT.maxHealth) {",
      "      if (drink && f !== this.owner && f.health < COMBAT.maxHealth) {"));
    expectToFail(() => checkDrink(run(DRINK)),
      "a drink that skips its owner should fail checkDrink");
  });

test("control: a drink that ignores the curdle fails the fresh-window test",
  async () => {
    /* The gate dropped, so the spill feeds him for all 330 frames instead of
       110: three times the ceiling, and a square of floor that heals its
       owner AND bites everybody else at once, which is the wall this move is
       not allowed to be. */
    const { run } = await arena(sabotage(
      "    const drink = !wasCurdled && s.heal > 0;",
      "    const drink = s.heal > 0;"));
    expectToFail(() => checkDrink(run(DRINK)),
      "milk that never stops feeding him should fail checkDrink");
  });

/* The other side of the same fork, and the assertion that catches it being
   written backwards in the direction checkDrink cannot see on its own. */
function checkForeign(f) {
  assert.equal(f.up, 0,
    "the man standing in somebody else's milk gains nothing from it, ever; " +
    "his health rose on " + f.up + " frames");
  assert.ok(f.down > 0,
    "and once it turns it costs him -- the fresh half feeding its owner must " +
    "not have cost the curdled half its bite. It took health off him on " +
    f.down + " frames");
  assert.ok(f.downStart >= f.curdle,
    "and not a frame before: while it is fresh it does nothing to him at all. " +
    "The first frame he lost health was " + f.downStart + ", and it turns at " +
    f.curdle);
}

const FOREIGN = `(function () {
  seat();
  fighters[1].x = fighters[0].x; fighters[1].health = 60;
  projectiles.push(new Puddle(fighters[0], SPEC, fighters[0].x, MAIN.y));
  var r = { up: 0, down: 0, downStart: 0, curdle: SPEC.curdle };
  var prev = fighters[1].health;
  for (var i = 1; i <= SPEC.life; i++) {
    fighters[1].x = fighters[0].x; fighters[1].vx = 0; fighters[1].hitstun = 0;
    if (fighters[1].health < 60) fighters[1].health = 60;
    prev = fighters[1].health;
    tick(0);
    var hp = fighters[1].health;
    if (hp > prev + 1e-12) r.up++;
    if (hp < prev - 1e-12) { r.down++; if (!r.downStart) r.downStart = i; }
    prev = hp;
  }
  return r;
})()`;

test("the other man drinks nothing, and then gets bitten", async () => {
  const { run } = await arena();
  checkForeign(run(FOREIGN));
});

test("control: a drink handed to everybody but the owner also fails the foe test",
  async () => {
    const { run } = await arena(sabotage(
      "      if (drink && f === this.owner && f.health < COMBAT.maxHealth) {",
      "      if (drink && f !== this.owner && f.health < COMBAT.maxHealth) {"));
    expectToFail(() => checkForeign(run(FOREIGN)),
      "a drink handed to the victim should fail checkForeign");
  });

/* A FULL MAN STANDING IN HIS OWN MILK IS STANDING ON A FLOOR, and there are
   two separate lines holding that up rather than one.

   The health test in front of the add is what stops a gulp and a spray of
   droplets firing for an event that did not happen -- feedback for nothing is
   worse than silence.

   The clamp behind it is what stops the LAST point overshooting, and it has to
   be written out by hand because nothing downstream clamps: every one of the
   heals in this file writes its own Math.min and this is the fifth. So the
   probe stands him in it twice, once at exactly full and once with less room
   than a single frame's worth, because each of those two lines is invisible in
   the other's case. */
function checkFull(f) {
  assert.equal(f.full.health, f.max,
    "he was already full and has to end exactly full: not 100.0000001, and " +
    "not NaN, which f.health being one of the numbers in stateHash would turn " +
    "into a desync rather than a bug anybody can see. He ended on " +
    f.full.health);
  assert.equal(f.full.drinks, 0,
    "and no gulp, because nothing was drunk. It fired " + f.full.drinks +
    " times");
  assert.equal(f.brim.health, f.max,
    "and a man with " + f.room + " of room left, standing in a spill worth " +
    f.heal + " a frame, ends on exactly " + f.max + " -- the clamp is this " +
    "move's own and there is nothing behind it. He ended on " + f.brim.health);
  assert.equal(f.brim.drinks, 1,
    "with one gulp, because that time there WAS something to drink; it " +
    "fired " + f.brim.drinks + " times");
}

const FULL = `(function () {
  function stand(health) {
    seat();
    fighters[1].x = MAIN.x + 180;
    fighters[0].health = health;
    projectiles.push(new Puddle(fighters[0], SPEC, fighters[0].x, MAIN.y));
    var drinks = 0, real = cue;
    cue = function (k, o) { if (k === 'drink') drinks++; return real(k, o); };
    for (var i = 0; i < 200; i++) { fighters[0].vx = 0; tick(0); }
    cue = real;
    return { health: fighters[0].health, drinks: drinks };
  }
  var room = SPEC.heal / 2;
  return { full: stand(COMBAT.maxHealth), brim: stand(COMBAT.maxHealth - room),
           max: COMBAT.maxHealth, heal: SPEC.heal, room: room };
})()`;

test("a full man standing in his own milk is standing on a floor", async () => {
  const { run } = await arena();
  checkFull(run(FULL));
});

test("control: a drink written without its own clamp overfills him", async () => {
  /* Half a frame's worth of room and a whole frame's worth of milk. With the
     Math.min gone he lands above the maximum and stays there -- and then the
     health test in front stops him, so it is one point of overshoot that
     never comes back rather than a runaway, which is exactly the kind of
     thing that survives being looked at. */
  const { run } = await arena(sabotage(
    "        f.health = Math.min(COMBAT.maxHealth, f.health + s.heal);",
    "        f.health = f.health + s.heal;"));
  expectToFail(() => checkFull(run(FULL)),
    "an unclamped heal should fail checkFull");
});

test("control: a drink that does not ask whether there is room gulps at full health",
  async () => {
    /* The other line. The clamp keeps the number right, so nothing on the
       health bar moves -- what breaks is that he drinks, audibly and
       visibly, for an event that did not happen. */
    const { run } = await arena(sabotage(
      "      if (drink && f === this.owner && f.health < COMBAT.maxHealth) {",
      "      if (drink && f === this.owner) {"));
    expectToFail(() => checkFull(run(FULL)),
      "a gulp at full health should fail checkFull");
  });

/* THE MOWER SPENDS THE DRINK TO BUY THE BITE, which is the best thing in the
   change and was not designed into it: `mulch` turns his own fresh spill
   early, and turning it is exactly what ends the drink. It is the only place
   two of his own moves trade against each other, and it trades in a direction
   a player can feel -- five and a half seconds of armed floor, paid for with
   whatever was left of the drink. */
function checkMulch(m) {
  assert.ok(m.before > 20,
    "he has to have been drinking first, or this test measures nothing; he " +
    "gained on " + m.before + " frames before the mower");
  assert.equal(m.curdled, true,
    "the mower has to turn it, and quickly: it turned after " + m.turnedAt +
    " frames");
  assert.ok(m.turnedAt < 20,
    "within the mower's own startup and a frame to reach it -- ten plus " +
    "change, not a hundred. It took " + m.turnedAt);
  assert.ok(m.mid <= 15,
    "so the drink survives the press by about the mower's startup and then " +
    "stops dead; it kept feeding him for " + m.mid + " more frames");
  assert.equal(m.after, 0,
    "and nothing after that at all: " + m.after + " frames of drinking from " +
    "a spill that has already turned");
  assert.ok(m.life >= m.full - 2,
    "while the spill's life is refreshed to the full " + m.full + " -- one " +
    "frame of decay is the Puddle updating after the Mower on the frame it " +
    "turns, and nothing more. It read " + m.life);
}

const MULCH = `(function () {
  seat();
  fighters[1].x = MAIN.x + 180;
  fighters[0].health = 40; fighters[0].mana = 999;
  var p = new Puddle(fighters[0], SPEC, fighters[0].x + 18, MAIN.y);
  projectiles.push(p);
  var m = { before: 0, mid: 0, after: 0, life: 0, turnedAt: -1, full: SPEC.life };
  var prev = fighters[0].health;
  for (var i = 0; i < 40; i++) {
    fighters[0].vx = 0; tick(0);
    if (fighters[0].health > prev + 1e-12) m.before++;
    prev = fighters[0].health;
  }
  for (var i = 0; i < 200 && m.turnedAt < 0; i++) {
    tick(i < 2 ? 1024 : 0);
    if (fighters[0].health > prev + 1e-12) m.mid++;
    prev = fighters[0].health;
    if (p.curdled()) { m.turnedAt = i; m.life = p.life; }
  }
  m.curdled = p.curdled();
  prev = fighters[0].health;
  for (var i = 0; i < 200; i++) {
    fighters[0].vx = 0; tick(0);
    if (fighters[0].health > prev + 1e-12) m.after++;
    prev = fighters[0].health;
  }
  return m;
})()`;

test("the mower spends the drink to buy the bite", async () => {
  const { run } = await arena();
  checkMulch(run(MULCH));
});

test("control: a mower that refreshes the spill instead of turning it keeps feeding him",
  async () => {
    /* The one-character version of the wrong fix: mulch that resets the clock
       rather than running it out. The spill comes back fresh, so the mower
       stops being the thing that ends the drink and becomes the thing that
       tops it up -- which is the loop the roster's arithmetic says cannot be
       allowed to exist. */
    const { run } = await arena(sabotage(
      "          p.t = pud.curdle - 1;",
      "          p.t = 0;"));
    expectToFail(() => checkMulch(run(MULCH)),
      "a mower that refreshes the spill should fail checkMulch");
  });

/* TWO CARTONS ARE ONE DRIP, and this is the structural half of the anti-farm
   argument -- the half that is arithmetic rather than a rule. There is no
   ledger on the drink and no cooldown, on purpose, because `puddles` is one:
   a second carton kills the first spill, so there is never more than one
   source and no window of `curdle` frames can be worth more than `curdle`
   times `heal` however the presses are spaced. */
function checkOneDrip(o) {
  assert.equal(o.mostAtOnce, 1,
    "he may only ever have one spill of his own on the floor; at one point " +
    "he had " + o.mostAtOnce);
  assert.ok(o.window <= o.ceiling + 1e-9,
    "so no " + o.curdle + " frames anywhere in the run can be worth more " +
    "than " + o.ceiling.toFixed(2) + " health, however the presses fall. The " +
    "best window was " + o.window.toFixed(4));
  assert.ok(o.total > 0,
    "and the measurement has to have measured something: he gained " +
    o.total + " over the whole run");
}

const ONE_DRIP = `(function () {
  seat();
  fighters[1].x = MAIN.x + 180;
  fighters[0].health = 10;
  var o = { mostAtOnce: 0, window: 0, total: 0, curdle: SPEC.curdle,
            ceiling: SPEC.curdle * SPEC.heal };
  var gains = [], prev = fighters[0].health;
  for (var i = 0; i < 500; i++) {
    fighters[0].mana = 999;
    var n = 0, mine = null;
    for (var k = 0; k < projectiles.length; k++) {
      var q = projectiles[k];
      if (q instanceof Puddle && !q.dead && q.owner === fighters[0]) { n++; mine = q; }
    }
    if (n > o.mostAtOnce) o.mostAtOnce = n;
    /* Stood on whichever spill is his, which is the ONLY way to make this
       measurement non-vacuous: played honestly he gains nothing here at all,
       because the carton flies forward and he would have to walk. */
    if (mine) { fighters[0].x = mine.x; fighters[0].vx = 0; }
    tick(i === 0 || i === 220 ? 512 : 0);
    var g = fighters[0].health - prev; prev = fighters[0].health;
    gains.push(g > 0 ? g : 0);
  }
  var sum = 0;
  for (var i = 0; i < gains.length; i++) {
    sum += gains[i];
    if (i >= SPEC.curdle) sum -= gains[i - SPEC.curdle];
    if (sum > o.window) o.window = sum;
  }
  o.total = +(prev - 10).toFixed(4);
  return o;
})()`;

test("two cartons are one drip", async () => {
  const { run } = await arena();
  checkOneDrip(run(ONE_DRIP));
});

test("control: a second spill allowed to live beside the first doubles the drip",
  async () => {
    /* The cap lifted in Carton.shatter, which is where it lives -- `maxAlive`
       cannot do this job, because a puddle's spec is the payload rather than
       the move. Two spills is two drips, and the ceiling stops being one. */
    const { run } = await arena(sabotage(
      "    if (mine >= (s.puddles || 1)) {",
      "    if (false) {"));
    expectToFail(() => checkOneDrip(run(ONE_DRIP)),
      "two spills at once should fail checkOneDrip");
  });
