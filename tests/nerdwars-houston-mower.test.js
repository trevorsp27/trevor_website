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
