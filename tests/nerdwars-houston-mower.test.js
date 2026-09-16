/* THE LAWNMOWER, which had no test at all and one number that made it
 * pointless.
 *
 * `push` was 1.25 against a roster whose walk runs 1.24 to 1.58, so every
 * fighter in the game except JohnnyHam could hold back on the stick and never
 * be touched by it. A probe across six starting gaps and four things a victim
 * can do said exactly that -- a victim walking away took 0.0 damage from all
 * six -- and the move as a whole connected on 42% of casts for a mean of 2.67
 * damage, having committed him for 72 frames and a third of a mana bar. At
 * push 2 the same probe reads 71% and 5.50 over 62 frames.
 *
 * That is pinned here as an INVARIANT against the roster rather than as the
 * literal, because the number that matters is a comparison: the day somebody
 * gives a new fighter a faster walk, this move quietly goes back to being the
 * thing it was, and nothing else in the file would notice. (`push` is 2.8
 * now; 2 beat the fastest walk arithmetically and still lost to it in a game,
 * because 0.42 a frame over the active window is less than a body length.)
 *
 * THE 2.79 REWORK added the other half of what was wrong with it. It killed
 * him: cast within 120 pixels of an edge, facing it, and he lost a stock in
 * 54 of 60 casts on all six stages, because `roots` writes no friction and
 * the push was unconditional. And it was refused off the floor entirely. So
 * there is now a ledge test, a recovery-brake test, an air-cast test and a
 * stall-out test, and the old "it is refused in the air" test is gone --
 * every assertion in it was deliberately inverted.
 *
 * AND ITS CLOSE-OUT PASS is why there are five more. The first pass's ledge test
 * exercised exactly one geometry -- one stage, one edge, standing still, on
 * dry ground, thirty pixels back -- and passed, while the move went on
 * killing him in four other ways that a probe written afterwards found in an
 * afternoon: standing in his own milk, because the brake was stopping() and
 * stopping() answers slickFriction to the man who spilt it (24 stocks in 24
 * honest carton-then-mower runs); pressed while walking or dashing at a lip,
 * because the rule never ran during the ten startup frames; on the lava
 * pit's top shelf, because dashLandingAhead walks a free fall and this move
 * pins its descent; and off the side of the stage in the air, because the
 * air half asked nothing at all. Every one of the five below is a geometry
 * the old one did not have, which is the actual lesson: a ledge test that
 * knows one ledge tests the branch, not the move.
 *
 * The rest are the parts that are code rather than numbers -- `shreds`,
 * `feeds` and `mulch` -- each with a negative control where a control is
 * cheap, because they are "something did not happen" tests and those pass
 * beautifully when the harness is broken.
 *
 * The engine source is loaded directly, the way the milk and New Deal tests
 * do: Mower, Puddle, `projectiles` and canSpecial are all internals.
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

const SP_NEUTRAL = 512, SP_DOWN = 1024;

/* Houston in seat 0 against whoever is named, both parked on the main floor
   with every timer that could eat an input cleared -- `freezeFrames`
   especially, since a measurement that starts inside somebody else's freeze
   spends its frames on nothing. */
async function arena(foeKey, engineSrc) {
  const booted = await bootEngine(engineSrc);
  const { run } = booted;
  const order = JSON.parse(run("JSON.stringify(ORDER)"));
  const H = order.indexOf("houston"), F = order.indexOf(foeKey || "reese");
  assert.ok(H >= 0 && F >= 0, "precondition: both fighters should be in ORDER");
  run("select.cursor=[" + H + ", " + F + "]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; practice=false; startBattle();");
  run("for (var i=0;i<90;i++) step();");
  assert.equal(run("fighters[0].key"), "houston",
    "precondition: houston should be in seat 0");
  run([
    "var MAIN, MOW, PUD;",
    "MOW = ROSTER.houston.specials.down;",
    "PUD = ROSTER.houston.specials.neutral.puddle;",
    "function seat(gap) {",
    "  MAIN = STAGE.platforms.find(function (p) { return p.main; });",
    "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
    "  fighters.forEach(function (f) {",
    "    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;",
    "    f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;",
    "    f.grounded = true; f.y = MAIN.y; f.slick = 0; f.slickFoe = 0;",
    "    f.stocks = 9; f.health = 100; f.eliminated = false; f.combo = 0;",
    "    f.hasHit = false; f.attackFrame = 0; f.specialSpawned = false;",
    "    f.sinceHitFrames = 999;",
    "  });",
    "  fighters[0].x = MAIN.x + 55; fighters[0].facing = 1;",
    "  fighters[1].x = fighters[0].x + (gap == null ? 120 : gap);",
    "  fighters[1].facing = -1;",
    "  netplay.active = true;",
    "}",
    "function tick(a, b) {",
    "  netplay.framePads = [bitsToPad(a || 0), bitsToPad(b || 0)]; step();",
    "}",
    /* Six stages, and only one of them has the shelf that broke the first
       ledge rule. Restarting the battle is how the select screen does it,
       so nothing here knows anything the game does not. seat() re-reads
       MAIN afterwards, which is the whole reason it looks it up rather
       than closing over it. */
    "function restage(n) {",
    "  stagePick = n; startBattle();",
    "  for (var i = 0; i < 90; i++) step();",
    "}",
    "function decks() {",
    "  return projectiles.filter(function (p) { return !p.dead && p.spec === MOW; });",
    "}",
    "function spills() {",
    "  return projectiles.filter(function (p) { return !p.dead && p.spec === PUD; });",
    "}",
  ].join("\n"));
  return booted;
}

test("the deck has to outrun a walk, or holding back beats it outright",
  async () => {
    /* The comparison IS the test. At 1.25 the move connected on 42% of casts
       for 2.67 damage because every fighter but one could simply walk away
       from it; the literal number is not what keeps that from coming back,
       the margin over the fastest man on the roster is. */
    const { run } = await arena();
    const walks = JSON.parse(run(
      "JSON.stringify(ORDER.map(function (k) { return [k, ROSTER[k].walk]; }))"));
    const push = Number(run("MOW.push"));
    walks.sort((a, b) => b[1] - a[1]);
    const [fastestKey, fastest] = walks[0];

    assert.ok(push > fastest,
      "the mower roots him for " + run("MOW.active") + " frames and cannot " +
      "be steered, so it has to catch somebody who simply holds back: push " +
      "is " + push + " against " + fastestKey + "'s walk of " + fastest);
    /* And by enough to matter. Catching a retreating man at a hundredth of a
       pixel a frame is arithmetically true and worth nothing over the length
       of the move. */
    assert.ok(push - fastest > 0.2,
      "and by a margin that closes ground inside the move: it gains only " +
      (push - fastest).toFixed(3) + "px a frame on " + fastestKey);

    // What that buys, in the only unit that matters: floor swept.
    const swept = push * Number(run("MOW.active"));
    assert.ok(swept > 70,
      "a mower that travels less than a body-length is a kick with extra " +
      "commitment; this one sweeps " + swept.toFixed(0) + "px");
  });

/* THE AIR CAST. This used to be a test that the move was REFUSED off the
   floor and that the mana was kept, and every one of its three assertions is
   now false on purpose: the move is legal in the air, it is paid for, and it
   puts a deck on the stage. What is worth keeping from it is the shape --
   ask canSpecial, then actually cast, then look at what exists -- and the one
   note about the harness that cost somebody an afternoon.

   The claim lives in a named checker so the control runs exactly it. */
function checkAirCast(r) {
  assert.equal(r.ok, true,
    "canSpecial has to ALLOW a mower off the floor now; it refused");
  assert.ok(r.after < r.before,
    "and an allowed cast is a paid cast -- the old refusal lived in " +
    "canSpecial specifically so that the subtraction never happened, and " +
    "there is nothing left to refuse: mana went " + r.before + " -> " + r.after);
  assert.equal(r.born.grounded, false,
    "precondition: his feet must still be off the floor when the deck comes " +
    "out, or this is measuring a grounded cast");
  assert.equal(r.born.n, 1, "one deck should exist in the air; there were " + r.born.n);
  assert.equal(r.born.air, true,
    "and it has to know it is an air deck: that flag is what picks its reach " +
    "and drops its box under his feet");
  assert.equal(r.kept.grounded, false,
    "precondition: still falling twelve frames later");
  assert.equal(r.kept.n, 1,
    "and it must still be there while he falls -- a deck that dies on the " +
    "first airborne frame is the old rule wearing the new one's clothes; " +
    r.kept.n + " survived");
}

const AIRCAST = "(function () {\n" +
  "  seat();\n" +
  /* A hundred pixels up, which is high enough that he is still falling
     twelve frames after the deck appears. Thirty is not: at 0.75 a frame
     through the wind-up and 2.8 through the ride he lands mid-window and
     the deck converts, which is a true thing about the move and not the
     thing this test is asking about. */
  "  fighters[0].grounded = false; fighters[0].y = MAIN.y - 100;\n" +
  "  fighters[0].vy = 0;\n" +
  "  var before = fighters[0].mana;\n" +
  // canSpecial takes the PAD and resolves the slot itself; handing it a
  // spec silently asks about the neutral special, which is legal in the air.
  "  var ok = fighters[0].canSpecial(bitsToPad(" + SP_DOWN + "));\n" +
  "  tick(" + SP_DOWN + ");\n" +
  "  for (var i = 0; i < 12; i++) tick(0, 0);\n" +
  "  var d = decks()[0];\n" +
  "  var born = { n: decks().length, air: d ? d.air === true : null,\n" +
  "               grounded: fighters[0].grounded };\n" +
  "  for (var j = 0; j < 12; j++) tick(0, 0);\n" +
  "  var e = decks()[0];\n" +
  "  var kept = { n: decks().length, air: e ? e.air === true : null,\n" +
  "               grounded: fighters[0].grounded };\n" +
  "  return { ok: ok, before: before, after: fighters[0].mana,\n" +
  "           born: born, kept: kept };\n" +
  "})()";

test("the mower casts in the air, is paid for, and the deck lives while he falls",
  async () => {
    const { run } = await arena();
    checkAirCast(run(AIRCAST));
  });

test("control: a deck that cannot survive its owner leaving the floor fails checkAirCast",
  async () => {
    /* The old rule, restored on one line. Mower.update's first clause is
       what tells a ground deck from an air one; put back the unconditional
       version and the air cast still happens, still costs him, and produces
       a projectile that is dead before combat resolves on its first frame. */
    const off = await arena("reese", sabotage(
      "    if (this.air && this.owner.grounded) this.air = false;",
      "    if (!this.owner.grounded) this.dead = true;"));
    expectToFail(() => checkAirCast(off.run(AIRCAST)),
      "a deck killed by its owner being airborne should fail checkAirCast");
  });

/* HE MOWS AT A LEDGE AND KEEPS HIS STOCK. This is the test the move did not
   have, and the absence of it is most of why it shipped killing him: cast
   standing anywhere inside 120 pixels of an edge, facing it, and he lost a
   stock in 54 of 60 casts across all six stages. `roots` means updateAttack
   writes no friction, the push was unconditional, and the deck is latched to
   a direction he cannot change. */
function checkLedge(r) {
  assert.ok(r.saw > 0,
    "precondition: the move has to have actually run -- no deck ever existed");
  assert.equal(r.lost, 0,
    "mowing at the edge of the stage must not cost him a stock; he lost " +
    r.lost);
  assert.equal(r.grounded, true,
    "and he should be standing on the platform when it is over, not falling " +
    "past it");
  assert.ok(r.x <= r.edge,
    "on the platform he started on: x " + r.x.toFixed(1) +
    " against a right edge of " + r.edge);
}

const LEDGE = "(function () {\n" +
  /* seat() parks him at MAIN.x + 55 with 185 pixels of runway, where the
     stop rule provably never fires. Nothing in this file measured a ledge
     because nothing in this file ever stood at one. */
  "  seat();\n" +
  "  fighters[0].x = MAIN.x + MAIN.w - 30; fighters[0].facing = 1;\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  var s0 = fighters[0].stocks;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  var saw = 0;\n" +
  /* Long enough after the move for a fall to finish and the KO to land:
     nobody updates for about twelve frames after a knockOut, so a probe
     that stops at the end of the move reads a stock he is about to lose. */
  "  for (var i = 0; i < MOW.startup + MOW.active + MOW.recovery + 150; i++) {\n" +
  "    if (decks().length) saw++;\n" +
  "    tick(0, 0);\n" +
  "  }\n" +
  "  return { lost: s0 - fighters[0].stocks, saw: saw, x: fighters[0].x,\n" +
  "           edge: MAIN.x + MAIN.w, grounded: fighters[0].grounded };\n" +
  "})()";

test("he mows at the lip of the stage and keeps his stock", async () => {
  const { run } = await arena();
  checkLedge(run(LEDGE));
});

test("control: with the ledge check off he walks himself into the blast zone",
  async () => {
    /* The mutant IS the shipped 2.78 behaviour of this branch, which is the
       nicest kind of control to have: it does not invent a broken engine, it
       restores the one that was killing him. */
    const off = await arena("reese", sabotage(
      "          if (!this.groundAhead(s.reach + s.boxW / 2)) {",
      "          if (false) {"));
    expectToFail(() => checkLedge(off.run(LEDGE)),
      "an unconditional push at a ledge should fail checkLedge");
  });

/* AND HE STOPS AT THE EDGE OF A SHELF, which the test above cannot see.

   The first pass asked dashLandingAhead, whose whole job is to WALK the fall off the
   lip and say whether it ends somewhere survivable -- and it walks a free
   fall, vy += gravity to maxFall 5.4, because that is what a dash does. The
   mower pins vy at 2.8 for as long as its air window runs, which is slower,
   which means he covers more ground sideways per pixel of drop than the
   projection allows for and lands short of whatever it cleared him for. On
   the lava pit's top shelf -- x 128, 64 wide, 86 pixels above the floor and
   with another shelf out to its right -- the projection put him on that
   second shelf and the real ride reached its height eight pixels to the left
   of it, missed, and overshot the main floor as well. Eight stocks in 184
   platform casts -- every floating platform on every stage, both lips --
   and all eight of them on this one shelf.

   So the question is groundAhead's now: is there floor at my feet a little
   way ahead. It cannot be wrong about a fall because it does not model one.
   The cost is that he will not drop off a shelf onto the floor below even
   when that would have been safe, which is the right cost -- a mower stops
   at a kerb -- and measured, he still crosses every platform on every stage
   end to end before he stops at the far one. */
function checkShelf(r) {
  assert.ok(r.saw > 0,
    "precondition: the move has to have actually run -- no deck ever existed");
  assert.equal(r.lost, 0,
    "mowing at the edge of a floating platform must not cost him a stock");
  assert.equal(r.y, r.shelfY,
    "and he should still be standing on the shelf he started on, at y " +
    r.shelfY + "; he is at " + r.y);
}

const SHELF = "(function () {\n" +
  // The lava pit, and its top shelf specifically: the one geometry that
  // survived the first pass's ledge rule, found by walking every platform on every
  // stage rather than by reasoning about which one would be worst.
  "  restage(4);\n" +
  "  seat();\n" +
  "  var p = STAGE.platforms[3];\n" +
  "  fighters[0].y = p.y; fighters[0].grounded = true; fighters[0].vy = 0;\n" +
  "  fighters[0].facing = 1; fighters[0].x = p.x + p.w - 8;\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].y = MAIN.y; fighters[1].facing = 1;\n" +
  "  var s0 = fighters[0].stocks;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  var saw = 0;\n" +
  "  for (var i = 0; i < 220; i++) { if (decks().length) saw++; tick(0, 0); }\n" +
  "  return { lost: s0 - fighters[0].stocks, saw: saw, y: fighters[0].y,\n" +
  "           shelfY: p.y };\n" +
  "})()";

test("he mows at the edge of a floating shelf and stays on it", async () => {
  const { run } = await arena();
  checkShelf(run(SHELF));
});

test("control: asking dashLandingAhead instead walks him off the shelf",
  async () => {
    /* The mutant restores the first pass's question verbatim, pin argument and all.
       It is not a straw man: it is the line that shipped. */
    const off = await arena("reese", sabotage(
      "          if (!this.groundAhead(s.reach + s.boxW / 2)) {",
      "          if (!this.dashLandingAhead(s.reach + s.boxW / 2, s.push, 0)) {"));
    expectToFail(() => checkShelf(off.run(SHELF)),
      "a free-fall projection of a pinned descent should fail checkShelf");
  });

/* AND HE STOPS AT A KERB HE IS STANDING IN MILK AT.

   This is the one that should have been obvious and was not, because the two
   halves live four thousand lines apart. The kerb braked with stopping(),
   and stopping() returns slickFriction -- 0.985 -- for anybody whose `slick`
   is armed, and Puddle.update arms it on the owner as well ("HE IS NOT
   EXEMPT", it says so where it does it). So in the exact combination the
   ROSTER advertises as the reason `mulch` exists -- milk at their feet,
   mower driven through it -- the kerb bled one and a half per cent a frame
   instead of forty-five and he crossed the lip still doing most of the push.
   Twenty-four honest runs, carton thrown, spill left to land, mower cast:
   twenty-four stocks.

   The carton is really thrown here and the spill is really landed on, rather
   than a Puddle being constructed at his feet, because the bug was in the
   combination and a hand-placed puddle would not have proved that his own
   thrown milk arms his own `slick`. */
function checkMilkKerb(r) {
  assert.ok(r.spills > 0,
    "precondition: the carton has to have landed and spilt, or there is no " +
    "milk to be slipping in");
  assert.ok(r.slick > 0,
    "precondition: and he has to actually be standing in it -- if `slick` " +
    "never armed on him, this test proves nothing about the brake");
  assert.equal(r.lost, 0,
    "mowing through his own milk at a lip must not cost him a stock");
  assert.equal(r.grounded, true,
    "and he should be standing on the floor when it is over, not falling");
  assert.ok(r.x <= r.lip,
    "on the stage he started on: x " + r.x + " against a lip of " + r.lip);
}

const MILK = "(function () {\n" +
  "  seat();\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  fighters[0].x = MAIN.x + MAIN.w - 100; fighters[0].facing = 1;\n" +
  "  tick(" + SP_NEUTRAL + ", 0);\n" +
  // long enough for the carton to fly, land and become a puddle
  "  for (var i = 0; i < 70; i++) tick(0, 0);\n" +
  "  var spilt = spills().length;\n" +
  "  var s0 = fighters[0].stocks;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  var slick = 0;\n" +
  "  for (var j = 0; j < 220; j++) {\n" +
  "    fighters[0].hitstop = 0;\n" +
  "    if (fighters[0].slick > slick) slick = fighters[0].slick;\n" +
  "    tick(0, 0);\n" +
  "  }\n" +
  "  return { spills: spilt, slick: slick, lost: s0 - fighters[0].stocks,\n" +
  "           grounded: fighters[0].grounded, x: +fighters[0].x.toFixed(1),\n" +
  "           lip: MAIN.x + MAIN.w };\n" +
  "})()";

test("he mows through his own milk at a lip and keeps his stock", async () => {
  const { run } = await arena();
  checkMilkKerb(run(MILK));
});

test("control: a kerb that brakes with stopping() is no kerb in milk",
  async () => {
    /* The first pass's line verbatim. It reads like the careful choice -- ask the
       physics rather than hard-code a number -- and it is the bug. */
    const off = await arena("reese", sabotage(
      "            this.vx = 0;",
      "            this.vx *= this.stopping();"));
    expectToFail(() => checkMilkKerb(off.run(MILK)),
      "a slick-scaled brake at a kerb should fail checkMilkKerb");
  });

/* AND THE KERB RULE RUNS DURING THE STARTUP FRAMES.

   `roots` suppresses updateAttack's friction for all sixty-two frames of the
   move, and the first pass's kerb only ever ran from the startup frame onward. So the
   ten wind-up frames kept whatever speed he pressed the button with and
   never asked about the floor: at a walk that is a lethal band about four
   pixels wide, and carrying a dash it is fourteen. The fix is the word
   `else` -- one clause covering every grounded frame -- and this test exists
   because the two ways of writing it look identical in a diff. */
function checkStartupKerb(r) {
  assert.ok(r.carried > 1,
    "precondition: he has to enter the move actually moving, or the startup " +
    "frames have nothing to coast on: vx read " + r.carried);
  assert.equal(r.lost, 0,
    "pressing it at a lip while already moving must not cost him a stock");
  assert.equal(r.grounded, true, "and he should still be on the floor");
}

const STARTUP = "(function () {\n" +
  "  seat();\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  fighters[0].x = MAIN.x + MAIN.w - 8; fighters[0].facing = 1;\n" +
  // a dash's worth of carried speed, set rather than earned so the frame the
  // button goes in is exact; startAttack keeps 40% of it either way
  "  fighters[0].vx = 4.5;\n" +
  "  var s0 = fighters[0].stocks;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  var carried = Math.abs(fighters[0].vx);\n" +
  "  for (var i = 0; i < 220; i++) { fighters[0].hitstop = 0; tick(0, 0); }\n" +
  "  return { carried: carried, lost: s0 - fighters[0].stocks,\n" +
  "           grounded: fighters[0].grounded };\n" +
  "})()";

test("he can press it at a lip while already moving and keep his stock",
  async () => {
    const { run } = await arena();
    checkStartupKerb(run(STARTUP));
  });

test("control: a kerb that only runs from the startup frame lets him coast off",
  async () => {
    const off = await arena("reese", sabotage(
      "        if (this.grounded) {\n" +
      "          if (!this.groundAhead(s.reach + s.boxW / 2)) {",
      "        if (this.grounded && this.attackFrame >= s.startup) {\n" +
      "          if (!this.groundAhead(s.reach + s.boxW / 2)) {"));
    expectToFail(() => checkStartupKerb(off.run(STARTUP)),
      "ten unbraked wind-up frames at a lip should fail checkStartupKerb");
  });

/* AND HIS VX OFF THE FLOOR IS INSIDE THE GAME'S OWN CEILING.

   `roots` is read as `roots && grounded`, so the moment he leaves the floor
   updateAttack's air arm owns his vx -- except that that arm only CLAMPS
   inside the branch that reads the stick. Holding nothing, there was no
   clamp and no friction, so a mower lifted out of a mow kept the full push
   of 2.8 against an airDriftMax of 1.9 for the whole fall: forty-seven per
   cent over the ceiling every other airborne body in the game obeys. It is
   the amplifier rather than the bug -- it is what turned a ledge overshoot
   into a sideways exit through the blast line rather than a drop he could
   drift out of -- and it is worth its own test because nothing else in the
   file would ever look at vx while he is airborne. */
function checkAirClamp(r) {
  assert.ok(Math.abs(r.pushed - r.push) < 1e-9,
    "precondition: the last grounded frame should still be the full push, " +
    r.pushed + " against " + r.push);
  assert.ok(r.worst > 0,
    "precondition: he has to have been airborne and moving for there to be " +
    "anything to clamp");
  assert.ok(r.worst <= r.cap + 1e-9,
    "airborne inside a mower he may not exceed the drift ceiling every other " +
    "body obeys: worst |vx| was " + r.worst + " against " + r.cap);
}

const CLAMP = "(function () {\n" +
  "  seat();\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  for (var i = 0; i < 20; i++) { fighters[0].hitstop = 0; tick(0, 0); }\n" +
  "  var pushed = Math.abs(fighters[0].vx);\n" +
  // lifted out of the mow mid-push, which is what a launch or a platform
  // going away does, and holding nothing so the stick arm cannot save it
  "  fighters[0].grounded = false; fighters[0].y -= 40;\n" +
  "  var worst = 0;\n" +
  "  for (var j = 0; j < 30; j++) {\n" +
  "    fighters[0].hitstop = 0; tick(0, 0);\n" +
  "    if (!fighters[0].grounded && Math.abs(fighters[0].vx) > worst)\n" +
  "      worst = Math.abs(fighters[0].vx);\n" +
  "  }\n" +
  "  return { pushed: pushed, worst: worst, cap: PHYS.airDriftMax,\n" +
  "           push: MOW.push };\n" +
  "})()";

test("a mower lifted off the floor keeps no more speed than the air allows",
  async () => {
    const { run } = await arena();
    checkAirClamp(run(CLAMP));
  });

test("control: without the clamp he carries the full ground push through the fall",
  async () => {
    const off = await arena("reese", sabotage(
      "          this.vx = clamp(this.vx, -PHYS.airDriftMax, PHYS.airDriftMax);",
      "          this.vx *= 1;"));
    expectToFail(() => checkAirClamp(off.run(CLAMP)),
      "an unclamped 2.8 through a fall should fail checkAirClamp");
  });

/* AND IT GIVES UP OVER NOTHING.

   The kerb is the ground half's answer and the air half had none: it wrote
   vy for thirty frames whether or not there was floor underneath him, so a
   press off the side of the stage bought a 68-pixel forced descent against a
   jump worth 46.5. Measured across six stages, three distances past the lip
   and four heights, with a real recovery attempt afterwards: 34 stocks in 72
   presses, against 9 in 72 for not pressing at all. The move was still
   killing him, through a door the ledge rule had just built.

   Three things are pinned and the third is the one that matters. It ends
   almost immediately; no deck is put out over the blast zone at all; and it
   does NOT hand a jump back. The stall-out hands one back because thirty
   frames of descent were paid for it -- a two-frame press that returns a
   jump for 28 mana is a mana-to-jumps converter, which is a recovery, which
   is the one thing this move may not be. Delete the third assertion and the
   move becomes his best way home. */
function checkGiveUp(r) {
  assert.equal(r.floor, false,
    "precondition: floorBeneath() must be false out there, or this is not " +
    "the case being tested");
  assert.ok(r.ended !== null && r.ended <= 4,
    "over the blast zone the move has to end on the frame it notices, not " +
    "thirty frames later: it ran " + r.ended);
  assert.equal(r.saw, 0,
    "and it should not put a deck out over the blast zone at all; " + r.saw +
    " frames of one existed");
  assert.equal(r.jumps, r.jumps0,
    "and it must NOT hand a jump back on this exit, or two frames and 28 " +
    "mana buy a jump and the move is a recovery: jumpsLeft went " + r.jumps0 +
    " -> " + r.jumps);
  assert.equal(r.lost, 0,
    "and with a jump still in hand he gets back: he lost " + r.lost);
}

const GIVEUP = "(function () {\n" +
  "  seat();\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  fighters[0].x = MAIN.x + MAIN.w + 24; fighters[0].y = MAIN.y - 10;\n" +
  "  fighters[0].grounded = false; fighters[0].vy = 0; fighters[0].facing = 1;\n" +
  "  fighters[0].jumpsLeft = 0;\n" +
  "  var floor = fighters[0].floorBeneath();\n" +
  "  var jumps0 = fighters[0].jumpsLeft;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  var saw = decks().length ? 1 : 0, ended = null, f = 1;\n" +
  "  for (var i = 0; i < 80; i++) {\n" +
  "    tick(0, 0); f++;\n" +
  "    if (decks().length) saw++;\n" +
  "    if (fighters[0].state !== 'special') { ended = f; break; }\n" +
  "  }\n" +
  "  var jumps = fighters[0].jumpsLeft;\n" +
  /* And then the same press from the same place with a jump in hand,
     played out the way a person plays it: hold away, jump, hold away,
     up-special, let go. Letting go at the end matters -- an early draft
     of this held away for two hundred frames and sailed him underneath
     the stage and out the far blast line, which reads as a death caused
     by the move and is a death caused by the probe. */
  "  seat();\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  fighters[0].x = MAIN.x + MAIN.w + 24; fighters[0].y = MAIN.y - 10;\n" +
  "  fighters[0].grounded = false; fighters[0].vy = 0; fighters[0].facing = 1;\n" +
  "  fighters[0].jumpsLeft = 1;\n" +
  "  var s0 = fighters[0].stocks;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  for (var a = 0; a < 6; a++) tick(1, 0);\n" +
  "  for (var b = 0; b < 6; b++) tick(17, 0);\n" +
  "  for (var c = 0; c < 6; c++) tick(1, 0);\n" +
  "  for (var d = 0; d < 4; d++) tick(2048, 0);\n" +
  "  for (var e = 0; e < 200; e++) tick(0, 0);\n" +
  "  return { floor: floor, ended: ended, saw: saw, jumps: jumps,\n" +
  "           jumps0: jumps0, lost: s0 - fighters[0].stocks };\n" +
  "})()";

test("pressed out over the blast zone the mower gives up instead of riding",
  async () => {
    const { run } = await arena();
    checkGiveUp(run(GIVEUP));
  });

test("control: without the floor test the air cast rides him down over nothing",
  async () => {
    /* The first pass's behaviour exactly: the air branch drove vy for its whole window
       with no question asked, and the stall-out at the end of it handed a
       jump back as consolation. */
    const off = await arena("reese", sabotage(
      "            !this.floorBeneath()) {",
      "            false) {"));
    expectToFail(() => checkGiveUp(off.run(GIVEUP)),
      "a forced descent over the blast zone should fail checkGiveUp");
  });

/* AND THE RECOVERY BRAKES. Its own test because it is a pre-existing bug
   rather than a new feature, and a bug nothing else in the file would notice
   coming back: `roots` suppresses updateAttack's friction for the whole move,
   the push only ever ran through the active window, so the twelve recovery
   frames coasted at full speed with no hitbox and nothing slowing them. At
   2.8 that is thirty-four free pixels after the move is visually over, and it
   is where the last of the ledge deaths lived once the stop rule was in. */
function checkRecoveryDamp(r) {
  assert.ok(r.sawActive !== null && Math.abs(r.sawActive - r.push) < 1e-9,
    "precondition: the last ACTIVE frame should still be driving him at the " +
    "full push; it read " + r.sawActive + " against " + r.push);
  assert.ok(r.vxLast !== null,
    "precondition: the move should have reached its last recovery frame");
  assert.ok(Math.abs(r.vxLast) < r.push / 2,
    "the recovery frames have to brake, because `roots` means nothing else " +
    "will: vx on the last frame of the move read " + r.vxLast +
    " against a push of " + r.push);
}

const DAMP = "(function () {\n" +
  "  seat();\n" +
  // Behind him and out of the way: a trade puts hitstop in the middle of a
  // frame count and a knockback puts somebody else's number in his vx.
  "  fighters[1].x = MAIN.x + 15; fighters[1].facing = 1;\n" +
  "  var total = MOW.startup + MOW.active + MOW.recovery;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  var vxLast = null, sawActive = null;\n" +
  "  for (var i = 0; i < 120; i++) {\n" +
  "    fighters[0].hitstop = 0;\n" +
  "    tick(0, 0);\n" +
  "    if (fighters[0].state !== 'special') break;\n" +
  "    if (fighters[0].attackFrame === MOW.startup + MOW.active - 1)\n" +
  "      sawActive = fighters[0].vx;\n" +
  "    if (fighters[0].attackFrame === total - 1) {\n" +
  "      vxLast = fighters[0].vx; break;\n" +
  "    }\n" +
  "  }\n" +
  "  return { vxLast: vxLast, sawActive: sawActive, push: MOW.push };\n" +
  "})()";

test("the recovery frames brake instead of coasting", async () => {
  const { run } = await arena();
  checkRecoveryDamp(run(DAMP));
});

test("control: with the recovery damp gone he leaves the move at full speed",
  async () => {
    const off = await arena("reese", sabotage(
      "            this.vx *= PHYS.groundFriction;",
      "            this.vx *= 1;"));
    expectToFail(() => checkRecoveryDamp(off.run(DAMP)),
      "an undamped recovery should fail checkRecoveryDamp");
  });

/* IT REVS, AND IT STALLS. Twenty active frames in the air against forty on
   the floor, which is the single most important thing about the air cast:
   thirty-one committed frames off the floor rather than sixty-two. Enforced
   by the one-shot in runSpecial that jumps attackFrame to the last recovery
   frame and lets the engine's own exit finish the move. */
function checkStallOut(r) {
  assert.equal(r.landed, false,
    "precondition: this is the no-floor-beneath-him case and he must not " +
    "have landed, or the move ended for the other reason");
  assert.ok(r.ended <= 35,
    "the airborne commitment is startup 10 plus twenty active frames plus " +
    "the frame the stall-out costs, and the ground version runs " + r.total +
    ": this one ran " + r.ended);
  assert.ok(r.jumps >= 1,
    "and the stall-out hands a jump back, so a mispress out over the blast " +
    "line costs him a second rather than a stock: jumpsLeft read " + r.jumps);
}

const STALL = "(function () {\n" +
  "  seat();\n" +
  // Two hundred up, so nothing catches him inside the ground version's
  // sixty-two frames and the only thing that can end the move is the stall.
  "  fighters[0].grounded = false; fighters[0].y = MAIN.y - 200;\n" +
  "  fighters[0].vy = 0; fighters[0].jumpsLeft = 0;\n" +
  "  var total = MOW.startup + MOW.active + MOW.recovery;\n" +
  "  tick(" + SP_DOWN + ", 0);\n" +
  "  var f = 1;\n" +
  "  for (var i = 0; i < 140; i++) {\n" +
  "    fighters[0].hitstop = 0;\n" +
  "    tick(0, 0); f++;\n" +
  "    if (fighters[0].state !== 'special') break;\n" +
  "  }\n" +
  "  return { ended: f, total: total, jumps: fighters[0].jumpsLeft,\n" +
  "           landed: fighters[0].grounded };\n" +
  "})()";

test("an air cast stalls out at twenty active frames and gives a jump back",
  async () => {
    const { run } = await arena();
    checkStallOut(run(STALL));
  });

test("control: an air window as long as the ground one fails checkStallOut",
  async () => {
    const off = await arena("reese", sabotage(
      "      air: { hang: 0.35, fall: 2.4, active: 20, reach: 7, sink: 6 },",
      "      air: { hang: 0.35, fall: 2.4, active: 99, reach: 7, sink: 6 },"));
    expectToFail(() => checkStallOut(off.run(STALL)),
      "an air cast that runs the full sixty-two frames, and never hands the " +
      "jump back, should fail checkStallOut");
  });

test("the deck eats an enemy shot and the eating pays for the move",
  async () => {
    /* `shreds` is the only copy of this on the roster and it was priced as
       though it were not there. `feeds` is what makes walking into a screen
       full of somebody else's projectiles affordable as the answer to a
       screen full of projectiles. */
    const { run } = await arena("cobeus");
    const PROBE = "(function () {\n" +
      "  seat(110);\n" +
      "  fighters[1].mana = 999;\n" +
      "  tick(0, " + SP_NEUTRAL + ");\n" +
      "  for (var i = 0; i < 18; i++) tick(0, 0);\n" +
      "  var born = projectiles.filter(function (p) { return !p.dead; }).length;\n" +
      "  fighters[0].mana = 60;\n" +
      "  var atPress = fighters[0].mana;\n" +
      "  tick(" + SP_DOWN + ", 0);\n" +
      "  for (var j = 0; j < 70; j++) { fighters[0].hitstop = 0; tick(0, 0); }\n" +
      "  var left = projectiles.filter(function (p) {\n" +
      "    return !p.dead && p.spec !== MOW; }).length;\n" +
      "  return { born: born, left: left, atPress: atPress,\n" +
      "           after: fighters[0].mana, cost: MOW.mana, feeds: MOW.feeds,\n" +
      "           max: COMBAT.manaMax };\n" +
      "})()";
    const r = run(PROBE);
    assert.ok(r.born > 0, "precondition: the foe should have put a shot on the stage");
    assert.equal(r.left, 0,
      "the deck must destroy the enemy shot it drives through; " + r.left + " survived");
    assert.ok(r.feeds > 0 && r.feeds < r.cost,
      "the refund has to be worth having and worth less than the cast, or " +
      "one shot is a free mower: feeds " + r.feeds + " against " + r.cost);

    /* THE REFUND MEASURED AGAINST ITSELF. Mana regenerates every frame and
       the cast is spent somewhere inside the window, so an absolute figure
       here would be arithmetic about the harness. The same probe on an
       engine identical but for `feeds` gives the one number that is the
       refund and nothing else -- and doubles as the negative control, since
       a broken probe produces no difference at all. */
    const off = await arena("cobeus", sabotage("      feeds: 12,", "      feeds: 0,"));
    const q = off.run(PROBE);
    assert.equal(q.left, 0,
      "precondition: the control engine still shreds; " + q.left + " survived");
    assert.equal(r.after - q.after, r.feeds,
      "eating one shot should leave him exactly `feeds` better off than the " +
      "same cast on an engine that does not pay: " + r.after + " against " +
      q.after + ", a difference of " + (r.after - q.after) + " where feeds " +
      "is " + r.feeds);
  });

test("the deck mulches his own fresh milk and leaves everybody else's alone",
  async () => {
    /* The spill's damaging half runs on a clock nobody watches. Mulching is
       what makes WHEN it turns a decision he gets to make, and it is the one
       place two of his own moves combine. */
    const { run } = await arena();
    const MULCH = "(function (mine) {\n" +
      "  seat(200);\n" +
      "  var owner = mine ? fighters[0] : fighters[1];\n" +
      "  var p = new Puddle(owner, PUD, fighters[0].x + 40, MAIN.y);\n" +
      "  projectiles.push(p);\n" +
      "  var was = { curdled: p.curdled(), life: p.life };\n" +
      "  tick(" + SP_DOWN + ", 0);\n" +
      "  for (var i = 0; i < MOW.startup + MOW.active; i++) tick(0, 0);\n" +
      "  return { was: was, curdled: p.curdled(), life: p.life, dead: p.dead,\n" +
      "           full: PUD.life, curdle: PUD.curdle };\n" +
      "})";
    const mine = run(MULCH + "(true)");
    assert.equal(mine.was.curdled, false, "precondition: it starts fresh");
    assert.equal(mine.dead, false, "mulching must not destroy the spill");
    assert.equal(mine.curdled, true,
      "the deck over his own fresh spill has to turn it");
    assert.ok(mine.life > mine.full - 80,
      "and start its life over, or turning it early is a way of ending it " +
      "early: it has " + mine.life + " of " + mine.full + " frames left");

    const theirs = run(MULCH + "(false)");
    assert.equal(theirs.curdled, false,
      "and somebody else's milk is not his to turn; it read curdled");

    /* NEGATIVE CONTROL: the flag off, on an otherwise identical engine. */
    const off = await arena("reese", sabotage("      mulch: true,", "      mulch: false,"));
    const q = off.run(MULCH + "(true)");
    expectToFail(() => { assert.equal(q.curdled, true); },
      "with mulch off the spill should not have turned and the check should " +
      "have failed");
  });

test("the deck goes with the man, and does not eat another deck", async () => {
  /* A projectile-eater that outlived the man pushing it would be a free
     screen clear off any trade, and two shredders that annihilated on
     contact would make the mirror a coin toss on who pressed first. */
  const { run } = await arena("houston");
  const r = run("(function () {\n" +
    /* Far enough apart that neither reaches the other inside the window: two
       mowers that meet knock each other out of the move, which is a true
       thing about the game and not the thing this test is asking about. */
    "  seat(150); fighters[1].facing = -1;\n" +
    "  tick(" + SP_DOWN + ", " + SP_DOWN + ");\n" +
    "  for (var i = 0; i < 20; i++) tick(0, 0);\n" +
    "  var both = decks().length;\n" +
    "  fighters[0].setState('hitstun'); fighters[0].hitstun = 20;\n" +
    "  fighters[0].grounded = false;\n" +
    "  tick(0, 0);\n" +
    "  var mine = decks().filter(function (d) { return d.owner === fighters[0]; }).length;\n" +
    "  return { both: both, mine: mine };\n" +
    "})()");
  assert.equal(r.both, 2,
    "two mowers should grind past each other rather than annihilate; " +
    r.both + " were on the stage");
  /* WHICH RULE THIS IS. It used to pass for two reasons -- he is airborne
     AND he is out of the move -- and it passes for one now: a deck dies with
     the move's STATE, not with its owner's footing. The footing half is real
     and still holds for a GROUND deck, but it is checkAirCast that pins the
     two apart, because an air deck is supposed to outlive his feet leaving
     the floor and this probe would not notice either way. */
  assert.equal(r.mine, 0,
    "and a deck must not outlive the man pushing it; " + r.mine + " did");
});

/* =====================================================================
   HE CAN LET GO OF THE HANDLE, AND HE CAN THROW IT.

   Two follow-ups out of one cast, both on the button that started the move.
   Everything above this line is about a machine welded to a man; everything
   below is about the frames after it is not.

   THE TEST ABOVE STILL HOLDS AND IS NOT WEAKENED. "the deck goes with the
   man" never presses the button twice, so the guarantee it protects -- a
   deck that outlived its owner would be a free screen clear off any trade --
   is exactly preserved. What is added here is its sibling: a deck he LET GO
   of outlives his commitment, which is a different sentence, and the control
   for it is withholding the press on the same engine.

   THE FRAME ARITHMETIC, once, because every probe below depends on it.
   updateAttack increments `attackFrame` at the top and the release gate reads
   it afterwards, so a press made on the tick where it still reads T-1 is a
   press "on frame T" -- the frame `after` is counted in. Measured on the
   shipping engine: refused at 21, taken at 22, with startup 10 and after 12.

   AND THE LEDGE GUARANTEE IS A MERGE GATE, not a data point. The two probes
   above -- "he mows at the lip" and "he mows at the edge of a floating shelf"
   -- read 0 of 60 and 0 of 60 on this engine, unchanged. What is added is the
   release-specific sweep: the machine may go over a lip, HE may not, and the
   shove is the only thing in his kit that puts a hitbox on a floor he is not
   standing on.
   ===================================================================== */

const LEFT = 1, RIGHT = 2;

/* Casts the mower, holds everything neutral until the frame asked for, then
   presses the special again with whatever direction bit is handed in. The
   foe is parked out of reach and made invulnerable, because a bite pauses
   `attackFrame` through hitstop and every probe here counts frames. */
const RELEASE_HARNESS = [
  "function clear(gap) {",
  "  seat(gap == null ? 150 : gap);",
  "  fighters[1].invuln = 9999;",
  "  fighters[1].x = MAIN.x + MAIN.w - 12;",
  "}",
  "function armed(T, extra) {",
  "  tick(1024, 0);",
  "  var guard = 0;",
  "  while (fighters[0].attackFrame < T - 1 && guard++ < 300) tick(0, 0);",
  "  var before = fighters[0].attackFrame;",
  "  tick(1024 | (extra || 0), 0);",
  "  var d = decks()[0];",
  "  return { before: before, af: fighters[0].attackFrame,",
  "           released: d ? !!d.released : null, shoved: d ? !!d.shoved : null,",
  "           vx: d ? d.vx : null, x: d ? d.x : null, y: d ? d.y : null,",
  "           alive: decks().length };",
  "}",
].join("\n");

async function relArena(foeKey, engineSrc) {
  const booted = await arena(foeKey, engineSrc);
  booted.run(RELEASE_HARNESS);
  return booted;
}

/* --------------------------------------------------------------------
   1. THE GATE
   -------------------------------------------------------------------- */

function checkGate(r) {
  assert.equal(r.early.alive, 1,
    "precondition: a deck has to be on the stage before either press");
  assert.equal(r.early.released, false,
    "a press one frame before `after` must be refused -- twelve is one whole " +
    "hitEvery cycle with three frames spare, so a deck he never actually " +
    "mowed with cannot be thrown. It was taken on frame " + r.early.before);
  assert.ok(r.early.af < r.last,
    "and a refused press must leave the move running; attackFrame jumped to " +
    r.early.af + " of " + r.last);
  assert.equal(r.onTime.released, true,
    "and the press on frame " + r.at + " has to be taken; it was not");
  assert.equal(r.onTime.af, r.last,
    "which ends the move through the engine's own exit -- attackFrame jumps " +
    "to the last recovery frame rather than any new way out of a special. It " +
    "read " + r.onTime.af + " against " + r.last);
  assert.equal(r.onTime.vx, r.push,
    "and a plain release carries on at `push`; it left at " + r.onTime.vx);
  assert.equal(r.hisVx, 0,
    "`this.vx = 0` is load-bearing: he ends the move standing still rather " +
    "than coasting at " + r.push + " into a lip the move's brake is no " +
    "longer watching. He was doing " + r.hisVx);
}

const GATE = "(function () {\n" +
  "  var A = MOW.startup + MOW.release.after;\n" +
  "  clear(); var early = armed(A - 1, 0);\n" +
  "  clear(); var onTime = armed(A, 0);\n" +
  "  return { at: A, early: early, onTime: onTime, push: MOW.push,\n" +
  "           hisVx: fighters[0].vx,\n" +
  "           last: MOW.startup + MOW.active + MOW.recovery - 1 };\n" +
  "})()";

test("the release is refused before its twelfth frame and taken on it",
  async () => {
    const { run } = await relArena();
    checkGate(run(GATE));
  });

test("control: a release with no window at all is taken on the cast frame",
  async () => {
    const off = await relArena("reese", sabotage(
      "      release: { after: 12, shove: 4.0 },",
      "      release: { after: 0, shove: 4.0 },"));
    expectToFail(() => checkGate(off.run(GATE)),
      "with `after` at zero the early press should be taken and the gate " +
      "test should have failed");
  });

/* --------------------------------------------------------------------
   2. IT OUTLIVES HIS COMMITMENT, NOT HIM
   -------------------------------------------------------------------- */

function checkOutlives(r) {
  assert.equal(r.released, true,
    "precondition: the press has to have come off the handle");
  assert.equal(r.alive, 1,
    "a deck he has let go of has to survive him being knocked out of the " +
    "move -- it does not outlive HIM, it outlives his COMMITMENT, and the " +
    "countdown it was born with is the only clock it has. " + r.alive +
    " were left");
  assert.ok(r.life > 0 && r.life <= MOWER_ACTIVE,
    "and it keeps the countdown it was born with rather than getting a " +
    "lifetime of its own: " + r.life + " frames left of " + MOWER_ACTIVE);
  assert.equal(r.everDies, true,
    "and it must still run out; it was alive " + r.lastSeen + " frames after " +
    "the press, against a spec active window of " + MOWER_ACTIVE);
}

let MOWER_ACTIVE = 0;

const OUTLIVES = "(function (press) {\n" +
  "  clear();\n" +
  "  tick(1024, 0);\n" +
  "  var guard = 0, A = MOW.startup + MOW.release.after;\n" +
  "  while (fighters[0].attackFrame < A - 1 && guard++ < 300) tick(0, 0);\n" +
  "  tick(press ? 1024 : 0, 0);\n" +
  "  var d = decks()[0];\n" +
  "  var rel = d ? !!d.released : null, life = d ? d.life : 0;\n" +
  /* Hit out of the move: off the floor and in hitstun, which is the exact
     pair of facts the three owner clauses in Mower.update read. */
  "  fighters[0].setState('hitstun'); fighters[0].hitstun = 40;\n" +
  "  fighters[0].grounded = false; fighters[0].vy = -3;\n" +
  "  tick(0, 0); tick(0, 0);\n" +
  "  var alive = decks().length, lastSeen = 0;\n" +
  "  for (var i = 0; i < 120; i++) { if (decks().length) lastSeen = i; tick(0, 0); }\n" +
  "  return { released: rel, alive: alive, life: life, lastSeen: lastSeen,\n" +
  "           everDies: decks().length === 0, active: MOW.active };\n" +
  "})";

test("the machine goes on without him, and runs out on its own clock",
  async () => {
    const { run } = await relArena();
    const r = run(OUTLIVES + "(true)");
    MOWER_ACTIVE = r.active;
    checkOutlives(r);

    /* NEGATIVE CONTROL, and it is the press rather than a mutant engine:
       the same probe with the button withheld has to lose the deck, because
       that is the guarantee the test above this block protects and it must
       not have been loosened for everybody. */
    const q = run(OUTLIVES + "(false)");
    expectToFail(() => checkOutlives(q),
      "an ESCORTED deck must die with the man pushing it; withholding the " +
      "press left " + q.alive + " on the stage");
  });

/* --------------------------------------------------------------------
   3. THE KERB, WITH THE HANDLE LET GO
   -------------------------------------------------------------------- */

function checkRelLedge(r) {
  assert.ok(r.saw > 0, "precondition: a deck has to have existed at all");
  assert.equal(r.released, true, "precondition: and it has to have been let go");
  assert.equal(r.lost, 0,
    "letting the machine go at a lip must not cost him a stock -- his 0% " +
    "ledge death rate is a property two releases were built to guarantee, " +
    "and the release hands a deck its own velocity for the first time");
  assert.equal(r.off, false,
    "and a PLAINLY released deck stops at the kerb: it does not turn and it " +
    "does not fall. It got " + r.overhang.toFixed(1) + "px past the edge");
  /* AND IT SITS THERE, STILL SPINNING, which is the half that makes the
     control fire. A deck with no kerb rule does not sail off into the blast
     zone -- `overFloor` kills it the frame its wheels leave the floor -- so
     what a missing `ledgeAhead` actually costs is the rest of its life at the
     lip, where it is still a hitbox. */
  assert.ok(r.saw >= r.life - 1,
    "and it has to live out the countdown it was born with, parked live at " +
    "the lip: " + r.life + " frames were left at the press and it existed " +
    "for " + r.saw + " of them");
}

const REL_LEDGE = "(function (bits) {\n" +
  "  seat();\n" +
  "  fighters[0].x = MAIN.x + MAIN.w - 40; fighters[0].facing = 1;\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  fighters[1].invuln = 9999;\n" +
  "  var s0 = fighters[0].stocks, A = MOW.startup + MOW.release.after;\n" +
  "  tick(1024, 0);\n" +
  "  var guard = 0;\n" +
  "  while (fighters[0].attackFrame < A - 1 && guard++ < 300) tick(0, 0);\n" +
  "  tick(1024 | (bits || 0), 0);\n" +
  "  var d = decks()[0];\n" +
  "  var rel = d ? !!d.released : false, shoved = d ? !!d.shoved : false;\n" +
  "  var life = d ? d.life : 0;\n" +
  "  var saw = 0, overhang = 0, edge = MAIN.x + MAIN.w;\n" +
  "  for (var i = 0; i < 220; i++) {\n" +
  "    var k = decks()[0];\n" +
  "    if (k) { saw++; overhang = Math.max(overhang, k.x - edge); }\n" +
  "    tick(0, 0);\n" +
  "  }\n" +
  "  return { lost: s0 - fighters[0].stocks, saw: saw, released: rel,\n" +
  "           life: life, shoved: shoved, overhang: overhang,\n" +
  "           off: overhang > 11 };\n" +
  "})";

test("a deck he lets go of stops at the kerb, and he keeps his stock",
  async () => {
    const { run } = await relArena();
    checkRelLedge(run(REL_LEDGE + "(0)"));
  });

test("control: a released deck that never asks about the floor drives off",
  async () => {
    /* The mutant deletes the deck's own copy of the question. runSpecial's
       brake is on HIS vx and a deck off the handle no longer reads it, so
       without ledgeAhead there is nothing left watching the lip at all. */
    const off = await relArena("reese", sabotage(
      "      if (!this.ledgeAhead()) this.vx = 0;",
      "      if (false) this.vx = 0;"));
    expectToFail(() => checkRelLedge(off.run(REL_LEDGE + "(0)")),
      "a released deck with no kerb rule should have driven off the platform");
  });

/* --------------------------------------------------------------------
   4. IT STILL SHREDS. IT DOES NOT STILL FEED HIM.
   -------------------------------------------------------------------- */

test("a deck he has let go of still eats a shot and is paid nothing for it",
  async () => {
    /* `feeds` is priced at the ROSTER as a discount on walking into a volley
       YOURSELF. A deck he is not standing behind costs him none of that, and
       this is the line that stops a let-go shredder being free.

       THE ESCORTED CASE IS THE CONTROL and it is in the same engine, which
       is the better control here: a broken probe pays nothing either way and
       the difference is what is being asserted. */
    const { run } = await relArena("cobeus");
    const FEED = "(function (letGo) {\n" +
      "  seat(200);\n" +
      "  fighters[1].mana = 999; fighters[0].invuln = 9999;\n" +
      "  tick(0, 512);\n" +
      "  for (var i = 0; i < 18; i++) tick(0, 0);\n" +
      "  function shots() { return projectiles.filter(function (p) {\n" +
      "    return !p.dead && p.spec !== MOW; }).length; }\n" +
      "  var born = shots();\n" +
      "  projectiles.forEach(function (p) {\n" +
      "    if (p.spec === MOW) return;\n" +
      "    p.x = fighters[0].x + 110; p.y = MAIN.y - 6; p.vx = 0; p.vy = 0;\n" +
      "  });\n" +
      "  fighters[0].mana = 60;\n" +
      "  tick(1024, 0);\n" +
      "  var guard = 0, A = MOW.startup + MOW.release.after;\n" +
      "  while (fighters[0].attackFrame < A - 1 && guard++ < 300)\n" +
      "    { fighters[0].hitstop = 0; tick(0, 0); }\n" +
      "  tick(letGo ? 1024 : 0, 0);\n" +
      "  var d = decks()[0];\n" +
      "  var rel = d ? !!d.released : false;\n" +
      "  var was = shots(), gain = null, atShred = null;\n" +
      "  for (var j = 0; j < 70; j++) {\n" +
      "    fighters[0].hitstop = 0;\n" +
      "    var m0 = fighters[0].mana;\n" +
      "    tick(0, 0);\n" +
      "    if (shots() < was && gain === null) {\n" +
      "      gain = fighters[0].mana - m0;\n" +
      "      atShred = d && !d.dead ? !!d.released : null;\n" +
      "    }\n" +
      "    was = shots();\n" +
      "  }\n" +
      "  return { born: born, left: shots(), released: rel, gain: gain,\n" +
      "           atShred: atShred, regen: COMBAT.manaRegen, feeds: MOW.feeds };\n" +
      "})";
    const go = run(FEED + "(true)");
    const held = run(FEED + "(false)");
    assert.ok(go.born > 0 && held.born > 0,
      "precondition: the foe should have put a shot on the stage both times");
    assert.equal(go.released, true, "precondition: the deck was let go");
    assert.equal(held.released, false, "precondition: the other one was not");
    assert.equal(go.left, 0,
      "a released deck must still destroy the enemy shot it drives through; " +
      go.left + " survived");
    assert.equal(held.left, 0,
      "precondition: so must an escorted one; " + held.left + " survived");
    assert.equal(go.atShred, true,
      "precondition: the shot has to die AFTER the deck came off the handle, " +
      "or this measures the weld rather than the release");
    assert.equal(held.atShred, false,
      "precondition: and the other deck has to still be on the handle");
    assert.equal(held.gain, held.feeds,
      "an ESCORTED deck has to pay him exactly `feeds` on the frame it eats " +
      "a shot -- that is the discount the ROSTER prices for walking into a " +
      "volley yourself. It paid " + held.gain);
    assert.ok(go.gain !== null && go.gain <= go.regen,
      "and a deck he has LET GO of has to pay him nothing at all: it is not " +
      "a volley he walked into. The most it may move on that frame is the " +
      "regen tick of " + go.regen + "; it moved " + go.gain);
  });

/* --------------------------------------------------------------------
   5. MAXALIVE FALLS OUT FOR FREE
   -------------------------------------------------------------------- */

test("he cannot cast a second mower while the one he let go is still rolling",
  async () => {
    /* canSpecial filters on owner AND spec, and a released deck is still
       `spec === s`, so the budget the ROSTER writes down is unchanged by the
       release with no second rule written for it. */
    const { run } = await relArena();
    const r = run("(function () {\n" +
      "  clear();\n" +
      "  var a = armed(MOW.startup + MOW.release.after, 0);\n" +
      "  fighters[0].setState('idle'); fighters[0].attackFrame = 0;\n" +
      "  fighters[0].mana = 100; fighters[0].specialSpawned = false;\n" +
      "  var whileAlive = fighters[0].canSpecial(bitsToPad(1024));\n" +
      "  var n = 0;\n" +
      "  while (decks().length && n++ < 200) {\n" +
      "    fighters[0].setState('idle'); fighters[0].attackFrame = 0;\n" +
      "    fighters[0].mana = 100; tick(0, 0);\n" +
      "  }\n" +
      "  fighters[0].setState('idle'); fighters[0].attackFrame = 0;\n" +
      "  fighters[0].mana = 100; fighters[0].specialSpawned = false;\n" +
      "  return { released: a.released, whileAlive: !!whileAlive,\n" +
      "           afterwards: !!fighters[0].canSpecial(bitsToPad(1024)),\n" +
      "           waited: n, max: MOW.maxAlive };\n" +
      "})()");
    assert.equal(r.released, true, "precondition: the deck came off the handle");
    assert.equal(r.max, 1, "precondition: the ROSTER still budgets one deck");
    assert.equal(r.whileAlive, false,
      "a second cast has to be refused while the released one is still " +
      "alive, or letting go is a way of doubling the move");
    assert.equal(r.afterwards, true,
      "and allowed the moment it expires; it was still refused after " +
      r.waited + " frames");
  });

/* --------------------------------------------------------------------
   6. THE AIR CAST MAY NOT BE LET GO
   -------------------------------------------------------------------- */

function checkAirRelease(mid, land) {
  assert.equal(mid.wasAir, true,
    "precondition: the deck has to have been born an AIR deck");
  assert.equal(mid.airborne, false,
    "precondition: and his feet still off the floor at the press");
  assert.equal(mid.inAir, false,
    "an air deck may not be released while he is off the floor: a deck he is " +
    "holding UNDER himself is not a machine he can push away");
  /* TWO GUARDS, AND THIS IS THE FRAME THAT TELLS THEM APART. `grounded` on
     him answers the press above; `!b.air` on the deck answers this one.
     Fighters update before projectiles do, so on the tick his feet touch
     down he is already grounded while the deck is still an air deck, and
     without the second guard the box under his feet -- dropped by `sink`,
     with its own reach -- would be launched forward from there. */
  assert.equal(land.onLanding, false,
    "and it may not be released on the frame he lands either, while the deck " +
    "is still an air deck: `!b.air` is the guard that answers that frame and " +
    "`grounded` cannot");
  assert.equal(mid.converted, true,
    "precondition: an air deck that touches down has to convert to a ground " +
    "deck, which is the rule that already existed and needs no new code");
  assert.equal(mid.afterLanding, true,
    "and from the frame after it converts it is releasable like any other; " +
    "it was still refused on attackFrame " + mid.af);
}

const AIR_RELEASE = "(function (sameFrame) {\n" +
  "  seat(200);\n" +
  "  fighters[1].invuln = 9999;\n" +
  "  fighters[0].x = MAIN.x + MAIN.w / 2;\n" +
  "  fighters[0].y = MAIN.y - 60; fighters[0].grounded = false; fighters[0].vy = 0;\n" +
  "  tick(1024, 0);\n" +
  "  var guard = 0, A = MOW.startup + MOW.release.after;\n" +
  "  while (fighters[0].attackFrame < A - 1 && guard++ < 90) tick(0, 0);\n" +
  "  var d = decks()[0];\n" +
  "  var wasAir = d ? d.air === true : null;\n" +
  "  var airborne = fighters[0].grounded;\n" +
  "  tick(1024, 0);\n" +
  "  d = decks()[0];\n" +
  "  var inAir = d ? !!d.released : null;\n" +
  "  fighters[0].y = MAIN.y; fighters[0].grounded = true; fighters[0].vy = 0;\n" +
  "  tick(sameFrame ? 1024 : 0, 0);\n" +
  "  d = decks()[0];\n" +
  "  var onLanding = d ? !!d.released : null;\n" +
  "  var converted = d ? d.air === false : null;\n" +
  "  fighters[0].y = MAIN.y; fighters[0].grounded = true; fighters[0].vy = 0;\n" +
  "  tick(1024, 0);\n" +
  "  d = decks()[0];\n" +
  "  return { wasAir: wasAir, airborne: airborne, inAir: inAir,\n" +
  "           onLanding: onLanding, converted: converted,\n" +
  "           af: fighters[0].attackFrame,\n" +
  "           afterLanding: d ? !!d.released : false };\n" +
  "})";

test("the air cast may not be let go, and converts when it lands",
  async () => {
    const { run } = await relArena();
    checkAirRelease(run(AIR_RELEASE + "(false)"), run(AIR_RELEASE + "(true)"));
  });

test("control: without the deck's own `air` guard it comes off on the landing frame",
  async () => {
    /* Removing `this.grounded` alone changes nothing, and neither does
       removing `!b.air` alone for a press made in mid-air -- either guard
       refuses it. The landing frame is the one place they disagree, which is
       why the probe above asks about it and why this is the mutant. */
    const off = await relArena("reese", sabotage(
      "        if (b.released || b.air) continue;",
      "        if (b.released) continue;"));
    expectToFail(
      () => checkAirRelease(off.run(AIR_RELEASE + "(false)"),
                            off.run(AIR_RELEASE + "(true)")),
      "an air deck launched on the landing frame should have failed the test");
  });

/* --------------------------------------------------------------------
   7. IT SURVIVES A REWIND
   -------------------------------------------------------------------- */

function checkRelRollback(r) {
  for (const k of ['released', 'shoved', 'vx', 'vy']) {
    assert.equal(r.fresh[k], true,
      "`" + k + "` has to be declared in Mower's CONSTRUCTOR, so a deck that " +
      "has never been let go already has it: restoreSim rebuilds projectiles " +
      "with Object.create and a key the snapshot does not carry simply will " +
      "not exist on the other side of a rewind");
    assert.equal(r.inSnap[k], true,
      "and a snapshot taken while it is still welded to him has to carry `" +
      k + "` as well, or a rewind has nothing to put back");
    assert.equal(r.afterRestore[k], true,
      "and `" + k + "` has to still be there after a restore; it was deleted");
  }
  assert.equal(r.restored, r.snapped,
    "and the deck comes back exactly as it was: " + r.snapped + " against " +
    r.restored);
  assert.equal(r.h2, r.h1,
    "and fourteen frames replayed across the release have to be " +
    "bit-identical. State hash " + r.h1 + " first time, " + r.h2 + " after");
  assert.equal(r.flew2, r.flew,
    "with the deck in the same place going the same speed at the end of both");
}

const REL_ROLLBACK = "(function () {\n" +
  "  clear();\n" +
  "  var A = MOW.startup + MOW.release.after, guard = 0;\n" +
  "  tick(1024, 0);\n" +
  "  while (fighters[0].attackFrame < A - 1 && guard++ < 300) tick(0, 0);\n" +
  "  var d = decks()[0], fresh = {};\n" +
  "  ['released', 'shoved', 'vx', 'vy'].forEach(function (k) {\n" +
  "    fresh[k] = Object.prototype.hasOwnProperty.call(d, k); });\n" +
  "  var snap = saveSim(), inSnap = {};\n" +
  "  var cell = snap.projectiles.filter(function (p) { return p.spec === MOW; })[0];\n" +
  "  ['released', 'shoved', 'vx', 'vy'].forEach(function (k) {\n" +
  "    inSnap[k] = cell ? Object.prototype.hasOwnProperty.call(cell, k) : false; });\n" +
  "  function shot() { var p = decks()[0];\n" +
  "    return p ? [+p.x.toFixed(4), +p.y.toFixed(4), p.vx, p.vy, p.life,\n" +
  "                !!p.released, !!p.shoved] : null; }\n" +
  "  var snapped = JSON.stringify(shot());\n" +
  "  function play() {\n" +
  "    tick(1024 | " + RIGHT + ", 0);\n" +
  "    for (var i = 0; i < 13; i++) tick(0, 0);\n" +
  "    return stateHash();\n" +
  "  }\n" +
  "  var h1 = play(), flew = JSON.stringify(shot());\n" +
  "  restoreSim(snap);\n" +
  "  var back = decks()[0], afterRestore = {};\n" +
  "  ['released', 'shoved', 'vx', 'vy'].forEach(function (k) {\n" +
  "    afterRestore[k] = back ? Object.prototype.hasOwnProperty.call(back, k) : false; });\n" +
  "  var restored = JSON.stringify(shot());\n" +
  "  var h2 = play(), flew2 = JSON.stringify(shot());\n" +
  "  return { fresh: fresh, inSnap: inSnap, afterRestore: afterRestore,\n" +
  "           snapped: snapped, restored: restored, flew: flew, flew2: flew2,\n" +
  "           h1: h1, h2: h2 };\n" +
  "})()";

test("a rewind across the release replays bit-identically", async () => {
  const { run } = await relArena();
  const r = run(REL_ROLLBACK);
  assert.equal(JSON.parse(r.flew)[6], true,
    "precondition: the replay HEAVES the deck, so the rewind crosses both " +
    "new fields and not merely `released`");
  checkRelRollback(r);
});

test("control: deck fields written on the frame he lets go vanish on a rewind",
  async () => {
    const off = await relArena("reese", sabotage(
      "    this.released = false;\n    this.shoved = false;\n" +
      "    this.vx = 0;\n    this.vy = 0;\n",
      ""));
    expectToFail(() => checkRelRollback(off.run(REL_ROLLBACK)),
      "fields that are not constructor keys must fail the snapshot test");
  });

/* --------------------------------------------------------------------
   8. THE FORK: FORWARD SHOVES IT, ANYTHING ELSE LETS IT GO
   -------------------------------------------------------------------- */

function checkFork(r) {
  assert.equal(r.neutral.released, true, "precondition: a neutral press lets go");
  assert.equal(r.neutral.shoved, false,
    "a press with no direction on it must be the plain release; it shoved");
  assert.equal(r.neutral.vx, r.push,
    "and carry on at `push`; it left at " + r.neutral.vx);
  assert.equal(r.fwd.shoved, true,
    "holding the way he is already pointed has to shove it -- that is the " +
    "one case where throwing the machine further means anything, and it is " +
    "where the stick already is");
  assert.equal(r.fwd.vx, r.shove,
    "at `shove`; it left at " + r.fwd.vx);
  assert.equal(r.back.shoved, false,
    "and holding BACK is a plain release, not a shove: the mow drives him " +
    "past people, so a Houston whose target has got behind him is holding " +
    "back and wants his forty frames to turn round with");
  assert.equal(r.bothWays, true,
    "and the same must be true facing left, where forward is the other bit");
}

const FORK = "(function () {\n" +
  "  var A = MOW.startup + MOW.release.after;\n" +
  "  clear(); var neutral = armed(A, 0);\n" +
  "  clear(); var fwd = armed(A, " + RIGHT + ");\n" +
  "  clear(); var back = armed(A, " + LEFT + ");\n" +
  "  clear(); fighters[0].facing = -1;\n" +
  "  fighters[0].x = MAIN.x + MAIN.w - 60;\n" +
  "  var leftFwd = armed(A, " + LEFT + ");\n" +
  "  clear(); fighters[0].facing = -1;\n" +
  "  fighters[0].x = MAIN.x + MAIN.w - 60;\n" +
  "  var leftBack = armed(A, " + RIGHT + ");\n" +
  "  return { neutral: neutral, fwd: fwd, back: back, push: MOW.push,\n" +
  "           shove: MOW.release.shove,\n" +
  "           bothWays: leftFwd.shoved === true && leftBack.shoved === false };\n" +
  "})()";

test("forward shoves the machine and anything else lets it go", async () => {
  const { run } = await relArena();
  checkFork(run(FORK));
});

test("control: reading the pad without `facing` shoves him the wrong way",
  async () => {
    /* The mutant reads `right` whichever way he is pointed, which is the
       obvious way to write this line and is wrong for exactly half the
       game. */
    const off = await relArena("reese", sabotage(
      "        !!(this.facing > 0 ? pad.right : pad.left);",
      "        !!pad.right;"));
    expectToFail(() => checkFork(off.run(FORK)),
      "a heave that ignores which way he is facing should fail the fork test");
  });

test("a confused Houston holding toward his machine gets the plain release",
  async () => {
    /* The left/right swap happens in Fighter.update BEFORE updateAttack is
       called, so the pad this rule reads is the effective one. That is the
       file's own rule about confusion arriving for free, and it costs
       damage rather than a stock: a misfired follow-up is a worse cast,
       never a lost one. */
    const { run } = await relArena();
    const r = run("(function () {\n" +
      "  var A = MOW.startup + MOW.release.after;\n" +
      "  clear(); fighters[0].confused = 600;\n" +
      "  var pressed = armed(A, " + RIGHT + ");\n" +
      "  clear(); fighters[0].confused = 600;\n" +
      "  var swapped = armed(A, " + LEFT + ");\n" +
      "  return { pressed: pressed, swapped: swapped };\n" +
      "})()");
    assert.equal(r.pressed.released, true,
      "precondition: the press still comes off the handle while confused");
    assert.equal(r.pressed.shoved, false,
      "holding toward the deck while confused gives the plain release, " +
      "because confusion turns every input and nothing compensates");
    assert.equal(r.swapped.shoved, true,
      "and holding AWAY from it shoves it, which is the same rule read from " +
      "the other end and is how a player finds out they are confused");
  });

/* --------------------------------------------------------------------
   9. THE SHOVE TAKES THE KERB RULE OFF THE MACHINE
   -------------------------------------------------------------------- */

function checkShoveLedge(r) {
  assert.equal(r.shoved, true, "precondition: the deck has to have been heaved");
  assert.equal(r.lost, 0,
    "the thing that goes over the lip is the MACHINE. He writes nothing to " +
    "his own vx except the release's `this.vx = 0`, and he ends the move on " +
    "the same frame either way, so his 0% ledge death rate is untouched");
  assert.equal(r.off, true,
    "and the deck has to actually cross the lip -- that is the whole of what " +
    "the shove is. It got " + r.overhang.toFixed(1) + "px past the edge");
  assert.equal(r.everDies, true,
    "and it must clean itself up: the `life` countdown it was born with " +
    "cannot outlast his commitment, and the blast floor takes whatever is " +
    "left. It was still alive " + r.lastSeen + " frames later");
}

const SHOVE_LEDGE = "(function () {\n" +
  "  seat();\n" +
  "  fighters[0].x = MAIN.x + MAIN.w - 40; fighters[0].facing = 1;\n" +
  "  fighters[1].x = MAIN.x + 20; fighters[1].facing = 1;\n" +
  "  fighters[1].invuln = 9999;\n" +
  "  var s0 = fighters[0].stocks, A = MOW.startup + MOW.release.after;\n" +
  "  tick(1024, 0);\n" +
  "  var guard = 0;\n" +
  "  while (fighters[0].attackFrame < A - 1 && guard++ < 300) tick(0, 0);\n" +
  "  tick(1024 | " + RIGHT + ", 0);\n" +
  "  var d = decks()[0];\n" +
  "  var shoved = d ? !!d.shoved : false;\n" +
  "  var overhang = 0, edge = MAIN.x + MAIN.w, lastSeen = -1;\n" +
  "  for (var i = 0; i < 220; i++) {\n" +
  "    var k = decks()[0];\n" +
  "    if (k) { lastSeen = i; overhang = Math.max(overhang, k.x - edge); }\n" +
  "    tick(0, 0);\n" +
  "  }\n" +
  "  return { lost: s0 - fighters[0].stocks, shoved: shoved, overhang: overhang,\n" +
  "           off: overhang > 11, lastSeen: lastSeen,\n" +
  "           everDies: decks().length === 0, active: MOW.active };\n" +
  "})()";

test("a shoved deck goes over the lip and he does not", async () => {
  const { run } = await relArena();
  const r = run(SHOVE_LEDGE);
  checkShoveLedge(r);
  assert.ok(r.lastSeen < r.active,
    "and it cannot outlive his commitment: the last frame it existed was " +
    r.lastSeen + " after the press, against an active window of " + r.active);
});

test("control: without its own fall a shoved deck is just a fast release",
  async () => {
    /* The mutant sends the heave down the released branch, which keeps the
       kerb. It is the honest control for "the shove is not `push: 4`": the
       speed is unchanged and only the floor rule is gone. */
    const off = await relArena("reese", sabotage(
      "    if (this.shoved) {\n      this.x += this.vx;",
      "    if (false) {\n      this.x += this.vx;"));
    expectToFail(() => checkShoveLedge(off.run(SHOVE_LEDGE)),
      "a heaved deck that still stops at the kerb should fail the shove test");
  });

/* --------------------------------------------------------------------
   10. THE ONLY HITBOX HE HAS ON A FLOOR HE IS NOT STANDING ON
   -------------------------------------------------------------------- */

function checkOtherFloor(r) {
  assert.equal(r.mow, 0,
    "precondition: the plain mow cannot touch a man on the floor below -- " +
    "it stopped at the lip and dealt " + r.mow);
  assert.equal(r.release, 0,
    "precondition: nor can the plain release, for the same reason: " + r.release);
  assert.ok(r.shove > 0,
    "and the shove has to reach him, which is the whole case for it being a " +
    "second follow-up rather than a bigger number on the first: the air cast " +
    "descends WITH him and the release stops at his own edge. It dealt " +
    r.shove);
}

const OTHER_FLOOR = "(function (bits) {\n" +
  /* Deep Space's left side platform, with the victim on the main floor
     below and out past its lip -- a place nothing else in his kit reaches. */
  "  restage(0); seat();\n" +
  "  var shelf = null;\n" +
  "  for (var i = 0; i < STAGE.platforms.length; i++) {\n" +
  "    var p = STAGE.platforms[i];\n" +
  "    if (!p.main && p.y < MAIN.y && p.x < MAIN.x + MAIN.w / 2) { shelf = p; break; }\n" +
  "  }\n" +
  "  if (!shelf) return { noShelf: true };\n" +
  "  fighters[0].x = shelf.x + shelf.w - 20; fighters[0].y = shelf.y;\n" +
  "  fighters[0].grounded = true; fighters[0].vy = 0; fighters[0].facing = 1;\n" +
  "  var fx = shelf.x + shelf.w + 50;\n" +
  "  fighters[1].x = fx; fighters[1].y = MAIN.y; fighters[1].facing = -1;\n" +
  "  var A = MOW.startup + MOW.release.after, dealt = 0, guard = 0;\n" +
  "  tick(1024, 0);\n" +
  "  while (fighters[0].attackFrame < A - 1 && guard++ < 300) {\n" +
  "    var h = fighters[1].health; tick(0, 0);\n" +
  "    dealt += Math.max(0, h - fighters[1].health);\n" +
  "    fighters[1].x = fx; fighters[1].y = MAIN.y; fighters[1].vx = 0;\n" +
  "    fighters[1].vy = 0; fighters[1].grounded = true;\n" +
  "    fighters[1].setState('idle'); fighters[1].hitstun = 0;\n" +
  "    fighters[1].health = 100;\n" +
  "  }\n" +
  "  tick(1024 | (bits || 0), 0);\n" +
  "  for (var i = 0; i < 90; i++) {\n" +
  "    var h2 = fighters[1].health; tick(0, 0);\n" +
  "    dealt += Math.max(0, h2 - fighters[1].health);\n" +
  "    fighters[1].x = fx; fighters[1].y = MAIN.y; fighters[1].vx = 0;\n" +
  "    fighters[1].vy = 0; fighters[1].grounded = true;\n" +
  "    fighters[1].setState('idle'); fighters[1].hitstun = 0;\n" +
  "    fighters[1].health = 100;\n" +
  "  }\n" +
  "  return { dealt: dealt };\n" +
  "})";

const NO_PRESS = "(function (bits) {\n" +
  "  restage(0); seat();\n" +
  "  var shelf = null;\n" +
  "  for (var i = 0; i < STAGE.platforms.length; i++) {\n" +
  "    var p = STAGE.platforms[i];\n" +
  "    if (!p.main && p.y < MAIN.y && p.x < MAIN.x + MAIN.w / 2) { shelf = p; break; }\n" +
  "  }\n" +
  "  fighters[0].x = shelf.x + shelf.w - 20; fighters[0].y = shelf.y;\n" +
  "  fighters[0].grounded = true; fighters[0].vy = 0; fighters[0].facing = 1;\n" +
  "  var fx = shelf.x + shelf.w + 50, dealt = 0;\n" +
  "  fighters[1].x = fx; fighters[1].y = MAIN.y; fighters[1].facing = -1;\n" +
  "  tick(1024, 0);\n" +
  "  for (var i = 0; i < 140; i++) {\n" +
  "    var h = fighters[1].health; tick(0, 0);\n" +
  "    dealt += Math.max(0, h - fighters[1].health);\n" +
  "    fighters[1].x = fx; fighters[1].y = MAIN.y; fighters[1].vx = 0;\n" +
  "    fighters[1].vy = 0; fighters[1].grounded = true;\n" +
  "    fighters[1].setState('idle'); fighters[1].hitstun = 0;\n" +
  "    fighters[1].health = 100;\n" +
  "  }\n" +
  "  return { dealt: dealt };\n" +
  "})";

test("the shove is the only thing he has that lands on a floor below him",
  async () => {
    const { run } = await relArena();
    const plain = run(NO_PRESS + "(0)");
    const letGo = run(OTHER_FLOOR + "(0)");
    const heave = run(OTHER_FLOOR + "(" + RIGHT + ")");
    assert.ok(!letGo.noShelf, "precondition: the stage has to have a side shelf");
    checkOtherFloor({ mow: plain.dealt, release: letGo.dealt, shove: heave.dealt });
  });

test("control: at `push` rather than `shove` the machine never gets there",
  async () => {
    /* The honest control for "past 2.8 the deck outruns the frames it has to
       bite with". Give the heave the escorted speed and it falls short of
       the man below: the reach is what the number buys, and it is bought at
       a measured cost in damage on his own floor. */
    const off = await relArena("reese", sabotage(
      "      release: { after: 12, shove: 4.0 },",
      "      release: { after: 12, shove: 1.2 },"));
    const plain = off.run(NO_PRESS + "(0)");
    const letGo = off.run(OTHER_FLOOR + "(0)");
    const heave = off.run(OTHER_FLOOR + "(" + RIGHT + ")");
    expectToFail(
      () => checkOtherFloor({ mow: plain.dealt, release: letGo.dealt, shove: heave.dealt }),
      "a heave too slow to clear the gap should fail the other-floor test");
  });
