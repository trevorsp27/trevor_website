/* THE CHICKEN -- what FDR'S NEW DEAL leaves behind.
 *
 * A car on Houston's road turns whoever it hits into a chicken, and they stay
 * one until they land a GOLDEN egg on somebody else or lose a stock. While
 * they are one their entire moveset is replaced: two buttons, H to peck and J
 * to lay, ten damage each, and nothing else they own works at all.
 *
 * WHY IT NEEDS ITS OWN FILE. Nothing else in this game replaces a fighter.
 * Buffs change numbers, statuses change how the floor or the stick answers,
 * the sandbag has its AI overridden -- but every one of those leaves the
 * fighter's own moves in place. This takes them away, and every rule it has
 * is a consequence of that one fact rather than a number somebody typed:
 *
 *   THE MOVESET IS SWAPPED IN SIX PLACES AT ONCE. canSpecial, slotFor,
 *   moveFor, the mana subtraction, the out-of-mana tell and the dog/pawn
 *   intent lookup all used to read `def.specials` directly. They read one
 *   accessor now. A seventh reader added later that forgets is a chicken
 *   casting a lawnmower, and nothing on screen would say why.
 *
 *   ONE EGG IN FIVE IS GOLDEN AND IT MAY NOT BE A DIE. This is rollback
 *   netcode: two machines replaying the same frame have to lay the same egg,
 *   or one player turns back into a person on one screen and stays a bird on
 *   the other. It is a hash of the frame and the slot, and a hash that ever
 *   became Math.random would pass every test that only counted the ratio.
 *
 *   EVERY FIELD IT ADDS HAS TO BE CONSTRUCTOR-DECLARED. restoreSim deletes
 *   any Fighter key a snapshot does not carry, so a field first assigned on
 *   the frame a car landed works perfectly offline and vanishes on the first
 *   online rewind -- on ONE machine, which is a desync rather than a bug
 *   anybody can see.
 *
 *   THE CPU HAS TO COPE. aiDecide drives ten of the eleven and is written for
 *   a fighter with three specials and a jab. Left alone it reads the moveset
 *   the victim USED to have, stands off at that character's range, and
 *   presses buttons that no longer exist.
 *
 * Everything below drives it through the real input path -- a pad bit, the
 * same bitsToPad the netcode uses -- so nothing here can pass by calling a
 * method the game never reaches.
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

/* A context that REMEMBERS its draw calls, drawImage included.

   The usual stub in this suite throws every call away, which is fine for a
   test that only wants the engine not to crash. Two tests here are about what
   is painted and in what order -- the road growing, and a far car going down
   before the stage -- so this one keeps them. */
function recordingContext(log) {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "drawImage") {
        return (...a) => {
          const o = { img: a[0] };
          if (a.length === 9) {
            o.sy = a[2]; o.sh = a[4]; o.dy = a[6]; o.dw = a[7]; o.dh = a[8]; o.dx = a[5];
          } else {
            o.sy = 0; o.sh = -1; o.dx = a[1]; o.dy = a[2];
            o.dw = a.length === 5 ? a[3] : -1; o.dh = a.length === 5 ? a[4] : -1;
          }
          log.push(o);
        };
      }
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "measureText") return () => ({ width: 0 });
      if (key === "canvas") return { width: 320, height: 180 };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {},
    getContext: () => recordingContext([]),
    __on: {},
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


/* ---------------------------------------------------------------------
   The arena. Houston in seat 0 so his ult is the one being fired; the
   BEACH, which has no platform over the middle, so nothing here is
   accidentally measuring an occlusion.
   --------------------------------------------------------------------- */
async function arena(foe) {
  const booted = await bootEngine(arena.engine);
  arena.engine = undefined;
  const { run } = booted;
  const O = JSON.parse(run("JSON.stringify(ORDER)"));
  const H = O.indexOf("houston");
  assert.ok(H >= 0, "precondition: houston should be in ORDER");
  run(`select.cursor=[${H}, ${O.indexOf(foe)}]; twoPlayer=true; playerCount=2;` +
      ` humanCount=0; stagePick=3; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].key"), "houston",
    "precondition: houston should be in seat 0");
  run(SETUP_FNS);
  return booted;
}
const withEngine = (src) => { arena.engine = src; };

/* The pad bits, read OFF bitsToPad rather than typed. Bit 9 is spNeutral and
   bit 10 is spDown, and each of them also carries `special` -- which is why
   they cannot be or-ed together: slotFor reads spUp first, then spDown, so a
   pad with all three set asks for the up special every time. */
const B = { attack: 1 << 5, grab: 1 << 6, ult: 1 << 8,
            peck: 1 << 9, lay: 1 << 10, up: 1 << 11 };

/* Both fighters put somewhere known, and a one-line way to make a bird. The
   transformation goes through applyHit in the tests that are ABOUT the
   transformation; everything downstream of it uses becomeChicken directly so
   that a failure says which half is broken. */
const SETUP_FNS = `
var __main = STAGE.platforms.find(function (p) { return p.main; });
function reset(gap) {
  var me = fighters[0], foe = fighters[1];
  projectiles.length = 0; effects.length = 0; freezeFrames = 0; banner = null;
  netplay.active = true;
  [me, foe].forEach(function (f) {
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
    f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;
    f.grabbing = -1; f.grabbedBy = -1; f.grounded = true; f.specialSpawned = false;
    f.stocks = 9; f.eliminated = false; f.health = 100; f.hasHit = true;
    f.y = __main.y; f.attackFrame = 0; f.ultMeter = 0;
    f.chicken = false; f.chickenSince = -1; f.chickenEggs = 0;
    f.buffTimer = 0; f.buffStats = null; f.swordTimer = 0;
  });
  me.x = 140; me.facing = 1;
  foe.x = 140 + (gap === undefined ? 20 : gap); foe.facing = -1;
  return [me, foe];
}
// Hold the target still and healthy, so a sweep measures the MOVE rather
// than a fight. Returns how much it took off them this frame.
function pin(foe, at) {
  foe.setState('idle'); foe.hitstun = 0; foe.invuln = 0; foe.hitstop = 0;
  foe.x = at; foe.vx = 0; foe.vy = 0; foe.grounded = true; foe.y = __main.y;
}
function press(bit) { netplay.framePads = [bitsToPad(bit), bitsToPad(0)]; }
`;

/* Fire one of the chicken's two moves at a target parked `gap` away, and
   report what happened. */
const ONE_MOVE = (bit, gap, frames) => `(function () {
  var p = reset(${gap}), me = p[0], foe = p[1];
  me.becomeChicken();
  var hp0 = foe.health, at = foe.x, eggs = 0, golden = 0, poses = {};
  press(${bit});
  for (var f = 0; f < ${frames}; f++) {
    me.hitstop = 0;
    pin(foe, at); foe.health = 100;
    step();
    press(0);
    if (me.chicken) poses[chickenPose(me)] = 1;
    for (var i = 0; i < projectiles.length; i++) {
      if (projectiles[i].constructor.name !== 'Egg') continue;
      eggs++;
      if (projectiles[i].golden) golden = 1;
    }
    if (foe.health < 100) { hp0 = 100 - foe.health; break; }
  }
  return JSON.stringify({ took: +(hp0 === 100 ? 0 : hp0).toFixed(2),
                          eggs: eggs > 0 ? 1 : 0, golden: golden,
                          laid: me.chickenEggs, poses: Object.keys(poses),
                          kind: me.moveFor('special') && me.moveFor('special').kind });
})()`;

/* =====================================================================
   1. A CAR MAKES A CHICKEN
   ===================================================================== */

/* The whole feature hangs off one line in applyHit, and it is guarded three
   ways: a shielded car does nothing, a car that takes the last of somebody's
   health takes the stock instead, and a second car on a bird already covered
   in feathers must not restart the transformation. */
function checkTransform(r) {
  assert.equal(r.hit, true,
    "precondition: the car should have connected at all");
  assert.equal(r.became, true,
    "a car has to turn whoever it runs over into a chicken -- that is the " +
    "move now, and the damage is the smaller half of it");
  assert.ok(r.sinceAt >= 0,
    "chickenSince should be stamped with the battleFrame it happened on, " +
    "so the drawing can be a function of the frame rather than a countdown " +
    "a rollback would restart; it was " + r.sinceAt);
  assert.equal(r.shielded, false,
    "a car blocked by a shield must not do it: the transformation sits BELOW " +
    "the shield branch in applyHit, beside poison and burn, so blocking a " +
    "car blocks all of it");
  assert.equal(r.fatal, false,
    "the blow that takes the last of somebody's health takes the STOCK -- a " +
    "chicken made out of a corpse is undone by respawn half a second later " +
    "and reads on screen as a flicker of feathers on a dead man");
  assert.equal(r.restarted, false,
    "a second car must not restart the transformation: being run over twice " +
    "is the normal case on a road with six cars, and re-popping every time " +
    "would look like a bug in exactly the situation it is meant for");
}

const TRANSFORM = `(function () {
  var p = reset(), me = p[0], foe = p[1];
  var car = ROSTER.houston.ult.traffic;
  var r = {};
  // A car, through applyHit, which is the only path the real one takes.
  var hp0 = foe.health;
  applyHit(me, foe, car, me.x, 1);
  r.hit = foe.health < hp0;
  r.became = foe.chicken;
  r.sinceAt = foe.chickenSince;
  // A second one, twenty frames later: it must not move chickenSince.
  // (No backticks inside this probe: it is a template literal, so one in
  // a comment ends the string.)
  for (var f = 0; f < 20; f++) step();
  var was = foe.chickenSince;
  foe.hitstop = 0; foe.invuln = 0;
  applyHit(me, foe, car, me.x, 1);
  r.restarted = foe.chickenSince !== was;
  // Behind a shield.
  p = reset(); me = p[0]; foe = p[1];
  foe.setState('shield'); foe.shield = COMBAT.shieldMax; foe.facing = -1;
  applyHit(me, foe, car, me.x + 40, 1);
  r.shielded = foe.chicken;
  // And the blow that finishes them.
  p = reset(); me = p[0]; foe = p[1];
  foe.health = 3; foe.stocks = 3;
  applyHit(me, foe, car, me.x, 1);
  r.fatal = foe.chicken;
  return JSON.stringify(r);
})()`;

test("a car turns whoever it runs over into a chicken", async () => {
  const { run } = await arena("kel");
  checkTransform(JSON.parse(run(TRANSFORM)));
});

test("control: without the flag on the traffic nobody transforms", async () => {
  withEngine(sabotage("      chicken: true,\n", "      chicken: false,\n"));
  const { run } = await arena("kel");
  expectToFail(() => checkTransform(JSON.parse(run(TRANSFORM))),
    "traffic that does not ask for it should fail checkTransform");
});

test("control: a transformation above the KO branch fails the corpse test", async () => {
  withEngine(sabotage(
    "  if (move.chicken && defender.health > 0 && !defender.eliminated) {\n",
    "  if (move.chicken && !defender.eliminated) {\n"));
  const { run } = await arena("kel");
  expectToFail(() => checkTransform(JSON.parse(run(TRANSFORM))),
    "turning a corpse into a chicken should fail checkTransform");
});

/* =====================================================================
   2. TWO BUTTONS, TEN DAMAGE, AND NOTHING ELSE
   ===================================================================== */

function checkMoveset(peck, egg, gates) {
  assert.equal(peck.kind, "peck", "H should be a peck");
  assert.equal(peck.took, 10, "and it should do ten; it did " + peck.took);
  assert.ok(peck.poses.indexOf("peck") >= 0,
    "and the bird should be DRAWN pecking while it does: the head goes out " +
    "on the frame the box opens, and art that ran behind the box would be a " +
    "move that visibly misses what it hits. Poses seen: " + peck.poses);

  assert.equal(egg.kind, "egg", "J should lay an egg");
  assert.equal(egg.eggs, 1, "and there should be an egg in the air");
  assert.equal(egg.took, 10, "and it should do ten; it did " + egg.took);
  assert.equal(egg.laid, 1, "and the bird should have counted it");
  assert.ok(egg.poses.indexOf("lay") >= 0,
    "and the bird should be drawn turned round to lay it -- the rear it lays " +
    "from is the end it points at the target, which is the whole reason the " +
    "egg travels forward. Poses seen: " + egg.poses);

  /* And the other half, which is the half that makes this a punishment. */
  assert.deepEqual(gates.states, ["idle"],
    "a chicken has no jab, no ult and no grab: pressing all three across " +
    "ninety frames should leave it standing there. It reached " + gates.states);
  assert.equal(gates.meter, gates.ultMax,
    "and a refused ult must not SPEND the meter. It keeps filling while they " +
    "are a bird -- applyHit pays it for damage dealt and knows nothing about " +
    "any of this -- so a gate written one line lower, after the meter is " +
    "zeroed, would bank four seconds of pecking and then throw the bar away " +
    "on a press that did nothing. It had " + gates.meter + " of " + gates.ultMax);
}

const GATES = `(function () {
  var p = reset(), me = p[0];
  me.becomeChicken();
  me.ultMeter = COMBAT.ultMax;
  var saw = {};
  for (var f = 0; f < 90; f++) {
    me.hitstop = 0; me.landLag = 0;
    press(f % 30 === 0 ? ${'B.attack'} : f % 30 === 10 ? ${'B.ult'}
        : f % 30 === 20 ? ${'B.grab'} : 0);
    step();
    saw[me.state] = 1;
  }
  return JSON.stringify({ states: Object.keys(saw), meter: me.ultMeter,
                          ultMax: COMBAT.ultMax });
})()`;

const moveset = (run) => [
  JSON.parse(run(ONE_MOVE(B.peck, 12, 30))),
  JSON.parse(run(ONE_MOVE(B.lay, 60, 60))),
  JSON.parse(run(GATES.replace("B.attack", String(B.attack))
                      .replace("B.ult", String(B.ult))
                      .replace("B.grab", String(B.grab)))),
];

test("H pecks, J lays, both do ten, and nothing else works", async () => {
  const { run } = await arena("kel");
  const [peck, egg, gates] = moveset(run);
  checkMoveset(peck, egg, gates);
});

test("control: an ult gate below the meter spend banks nothing", async () => {
  /* The gate moved one line down, which is where anybody would put it: the
     press is still refused, and the meter is thrown away on the way. */
  withEngine(sabotage(
    "    if (pad.ult && this.landLag <= 0 && this.def.ult && !this.chicken) {",
    "    if (pad.ult && this.landLag <= 0 && this.def.ult) {\n" +
    "      if (this.chicken) { this.ultMeter = 0; return; }"));
  const { run } = await arena("kel");
  const [peck, egg, gates] = moveset(run);
  expectToFail(() => checkMoveset(peck, egg, gates),
    "an ult gate that spends the meter should fail checkMoveset");
});

test("control: a chicken that keeps its own specials fails the moveset test", async () => {
  withEngine(sabotage(
    "    return this.chicken ? CHICKEN.specials : this.def.specials;",
    "    return this.def.specials;"));
  const { run } = await arena("kel");
  const [peck, egg, gates] = moveset(run);
  expectToFail(() => checkMoveset(peck, egg, gates),
    "a bird still holding its own moveset should fail checkMoveset");
});

/* =====================================================================
   3. ONE EGG IN FIVE, AND THE SAME ONE ON BOTH MACHINES
   ===================================================================== */

/* The ratio is the easy half. The hard half -- and the one that matters for a
   game with rollback netcode -- is that it is a pure function of the frame and
   the slot, so a rewind lays the same egg it laid the first time and the other
   machine lays it too. A Math.random that came out one in five would pass a
   ratio test and desync the match. */
function checkGolden(g) {
  assert.ok(g.rate > 0.16 && g.rate < 0.24,
    "about one egg in five should be golden; it was " +
    (g.rate * 100).toFixed(1) + "%");
  assert.equal(g.pure, true,
    "and which one has to be a pure function of the frame and the slot: " +
    "asked the same question twice it gave a different answer, which in a " +
    "rollback is one player turning back into a person on one screen only");
  assert.equal(g.slotsDiffer, true,
    "two fighters laying on the SAME frame must not get the same answer, or " +
    "a four-way turns two people back at once off one lucky frame");
  assert.equal(g.framesDiffer, true,
    "and neither must consecutive frames; a hash that only mixed the sum " +
    "would give slot 1 on frame 100 the same egg as slot 0 on frame 101");
  assert.equal(g.rollback, true,
    "a laid egg has to survive a rewind as the egg it was: saved, replayed " +
    "and restored, it was golden " + g.rollbackSaw);
}

const GOLDEN = `(function () {
  var n = 0, g = 0;
  for (var fr = 0; fr < 3000; fr++) for (var sl = 0; sl < 4; sl++) {
    n++; if (eggIsGolden(fr, sl, 5)) g++;
  }
  var r = { rate: g / n, pure: true, slotsDiffer: false, framesDiffer: false };
  for (var i = 0; i < 500; i++) {
    if (eggIsGolden(i, i % 4, 5) !== eggIsGolden(i, i % 4, 5)) r.pure = false;
    if (eggIsGolden(i, 0, 5) !== eggIsGolden(i, 1, 5)) r.slotsDiffer = true;
    if (eggIsGolden(i, 1, 5) !== eggIsGolden(i + 1, 0, 5)) r.framesDiffer = true;
  }
  /* And through the netcode, not just through the function. A bird lays one,
     the frame is snapshotted, the sim runs on, and the snapshot is restored:
     the egg that comes back has to be the egg that was laid. */
  var p = reset(60), me = p[0];
  me.becomeChicken();
  press(${'B.lay'});
  /* Run until the egg is actually IN THE AIR rather than for a fixed count:
     the lay's startup is data and a retune that moved it would leave this
     probe asserting about an egg that has not been laid yet, which reads as
     a netcode failure and is a stale number in a test. */
  for (var f = 0; f < 60 && !projectiles.some(function (q) {
         return q.constructor.name === 'Egg'; }); f++) {
    me.hitstop = 0; step(); press(0);
  }
  var laid = null;
  for (var i = 0; i < projectiles.length; i++) {
    if (projectiles[i].constructor.name === 'Egg') laid = projectiles[i].golden;
  }
  var snap = saveSim();
  for (var f = 0; f < 6; f++) { step(); }
  restoreSim(snap);
  var back = null;
  for (var i = 0; i < projectiles.length; i++) {
    if (projectiles[i].constructor.name === 'Egg') back = projectiles[i].golden;
  }
  r.rollbackSaw = laid + ' then ' + back;
  r.rollback = laid !== null && back === laid;
  return JSON.stringify(r);
})()`;

test("one egg in five is golden, and which one is a hash and not a die", async () => {
  const { run } = await arena("kel");
  checkGolden(JSON.parse(run(GOLDEN.replace("B.lay", String(B.lay)))));
});

test("control: a golden egg drawn from Math.random fails the determinism test", async () => {
  withEngine(sabotage(
    "function eggIsGolden(frame, slot, oneIn) {",
    "function eggIsGolden(frame, slot, oneIn) {\n" +
    "  return Math.random() < 1 / (oneIn || 5);"));
  const { run } = await arena("kel");
  expectToFail(() => checkGolden(JSON.parse(run(GOLDEN.replace("B.lay", String(B.lay))))),
    "a die instead of a hash should fail checkGolden");
});

test("control: a hash that only adds the slot fails the collision test", async () => {
  withEngine(sabotage(
    "  h = Math.imul(h ^ (slot + 1), 0xc2b2ae35);",
    "  h = Math.imul(h, 0xc2b2ae35);"));
  const { run } = await arena("kel");
  expectToFail(() => checkGolden(JSON.parse(run(GOLDEN.replace("B.lay", String(B.lay))))),
    "a hash that ignores the slot should fail checkGolden");
});

/* =====================================================================
   4. THE WAY OUT, AND THE TWO WAYS IT IS NOT
   ===================================================================== */

function checkCure(c) {
  assert.equal(c.cured, true,
    "a GOLDEN egg that reaches an enemy has to turn them back; it did not " +
    "after " + c.lays + " lays");
  assert.equal(c.curedByWhite, false,
    "and a white one must NOT -- one in five is the whole shape of the way " +
    "out, and any egg doing it makes the transformation a formality");
  assert.equal(c.curedBySelf, false,
    "nor may one land on the BIRD ITSELF: resolveCombat skips the owner, " +
    "which is what makes 'an enemy player' a property of the loop rather " +
    "than a check that can drift out of step with it");
  assert.equal(c.stateAfter === "idle" || c.stateAfter === "air", true,
    "and being cured has to put them back on their feet: moveFor answers " +
    "with the other spec from that frame on, so a fighter left part way " +
    "through a chicken's lay would run whatever sits in their own down " +
    "slot for the rest of it. They were in " + c.stateAfter);
  assert.equal(c.respawnCleared, true,
    "losing a stock is the other way out; respawn has to clear all three " +
    "fields, or a fresh stock arrives as a bird with a stale egg count");
}

const CURE = `(function () {
  var c = {};
  // A white egg, forced, on a real enemy.
  var p = reset(60), me = p[0], foe = p[1];
  me.becomeChicken();
  projectiles.length = 0;
  var e = new Egg(me, CHICKEN.specials.down);
  e.golden = false;
  projectiles.push(e);
  for (var f = 0; f < 40 && me.chicken; f++) { pin(foe, 200); foe.health = 100; step(); }
  c.curedByWhite = !me.chicken;

  // A golden one thrown at NOBODY but its own owner.
  p = reset(60); me = p[0]; foe = p[1];
  me.becomeChicken();
  projectiles.length = 0;
  e = new Egg(me, CHICKEN.specials.down);
  e.golden = true; e.x = me.x; e.y = me.y - 6; e.vx = 0; e.vy = -0.2;
  projectiles.push(e);
  for (var f = 0; f < 10 && me.chicken; f++) { foe.x = 300; step(); }
  c.curedBySelf = !me.chicken;

  // And a golden one on an enemy, laid the ordinary way, until one comes up.
  p = reset(60); me = p[0]; foe = p[1];
  me.becomeChicken();
  c.lays = 0;
  for (var tries = 0; tries < 40 && me.chicken; tries++) {
    me.setState('idle'); me.attackFrame = 0; me.hitstop = 0; me.landLag = 0;
    projectiles.length = 0;
    press(${'B.lay'});
    for (var f = 0; f < 40 && me.chicken; f++) {
      pin(foe, 200); foe.health = 100;
      me.hitstop = 0;
      step();
      press(0);
    }
    c.lays++;
  }
  c.cured = !me.chicken;
  c.stateAfter = me.state;

  // A stock.
  p = reset(); me = p[0];
  me.becomeChicken();
  me.chickenEggs = 7;
  me.respawn();
  c.respawnCleared = !me.chicken && me.chickenSince === -1 && me.chickenEggs === 0;
  return JSON.stringify(c);
})()`;

test("a golden egg on an enemy is the way out, and nothing else is", async () => {
  const { run } = await arena("kel");
  checkCure(JSON.parse(run(CURE.replace("B.lay", String(B.lay)))));
});

test("control: an egg that cures whatever its color fails the way-out test", async () => {
  withEngine(sabotage("    if (this.golden) this.owner.unchicken();",
                      "    this.owner.unchicken();"));
  const { run } = await arena("kel");
  expectToFail(() => checkCure(JSON.parse(run(CURE.replace("B.lay", String(B.lay))))),
    "any egg curing should fail checkCure");
});

test("control: a respawn that forgets the feathers fails the stock test", async () => {
  withEngine(sabotage("    this.chicken = false;\n    this.chickenSince = -1;\n" +
                      "    this.chickenEggs = 0;\n    this.evadeCd = 0;",
                      "    this.evadeCd = 0;"));
  const { run } = await arena("kel");
  expectToFail(() => checkCure(JSON.parse(run(CURE.replace("B.lay", String(B.lay))))),
    "a respawn that leaves them a chicken should fail checkCure");
});

/* =====================================================================
   5. THE CPU COPES
   ===================================================================== */

/* aiDecide drives ten of the eleven, and it is written for a fighter with
   three specials and a jab. Handed a bird it reads the moveset the victim
   USED to have: a chicken Houston is `ranged`, because his neutral is a milk
   carton, so the CPU holds 55 pixels and presses a button that is now a peck
   reaching sixteen. It never touches anybody again.
 *
 * So: both buttons actually get pressed, it closes the distance, and it lands
 * damage. The last one is the assertion that matters -- a CPU that pressed
 * both buttons from across the stage would satisfy the first two. */
function checkCPU(c) {
  assert.ok(c.pecks > 0, "a CPU chicken should peck; it pecked " + c.pecks + " times");
  assert.ok(c.lays > 0,
    "and it should lay: one egg in five is the way out, so the bird that " +
    "throws the most eggs is the bird that gets to be a person again. It " +
    "laid " + c.lays);
  assert.ok(c.dealt > 20,
    "and it has to actually CONNECT -- pressing buttons from across the " +
    "stage is the failure this test exists for. It dealt " + c.dealt);
  assert.ok(c.closest < 20,
    "which means walking in: the closest it ever got was " + c.closest +
    " pixels, and its peck reaches sixteen");
}

const CPU = `(function () {
  var p = reset(90), me = p[0], foe = p[1];
  me.becomeChicken();
  humanCount = 0;
  netplay.active = false;
  var c = { pecks: 0, lays: 0, dealt: 0, closest: 999 };
  /* Counted on the frame it ENTERS the state rather than on a particular
     attackFrame: hitstop and freezeFrames both hold a move still, so any one
     value of attackFrame can be sampled twice or skipped, and a count keyed
     on one of them measures the scheduler instead of the CPU. */
  var prev = me.state;
  for (var f = 0; f < 900; f++) {
    foe.health = 100; foe.stocks = 9;
    /* KEPT A CHICKEN for the whole window, on purpose. The CPU is good at
       this -- it lays constantly, so one egg in five comes up golden inside
       a couple of seconds and it cures itself. Left to do that, this probe
       measures how fast it ESCAPED rather than how it played, and a run
       where the first egg was the golden one reports zero pecks and fails
       for the one reason that is not a bug. */
    if (!me.chicken) me.becomeChicken();
    step();
    if (foe.health < 100) c.dealt += 100 - foe.health;
    var d = Math.abs(me.x - foe.x);
    if (d < c.closest) c.closest = Math.round(d);
    if (me.state === 'special' && prev !== 'special') {
      var m = me.moveFor('special');
      if (m && m.kind === 'peck') c.pecks++;
      if (m && m.kind === 'egg') c.lays++;
    }
    prev = me.state;
  }
  return JSON.stringify(c);
})()`;

test("a CPU chicken walks in, pecks, lays, and lands damage", async () => {
  const { run } = await arena("kel");
  checkCPU(JSON.parse(run(CPU)));
});

test("control: without its own branch the CPU chicken stands off and whiffs", async () => {
  /* The branch removed, so aiDecide falls through to the code written for
     the fighter they used to be. */
  withEngine(sabotage("  if (me.chicken) {\n    if (adx > 13)",
                      "  if (false && me.chicken) {\n    if (adx > 13)"));
  const { run } = await arena("kel");
  expectToFail(() => checkCPU(JSON.parse(run(CPU))),
    "a CPU reading the moveset it no longer has should fail checkCPU");
});

/* =====================================================================
   6. THE NETCODE STILL OWNS IT
   ===================================================================== */

/* Three separate promises, and all three are the kind that hold right up
   until somebody plays online:
 *
 *   Every field is constructor-declared, so restoreSim cannot delete one.
 *   CHICKEN is walked by simFrozen, so a snapshot keeps its two specs BY
 *   REFERENCE -- the identity `b.spec === s` that maxAlive and the mana
 *   subtraction both test.
 *   And stateHash covers `chicken`, so two machines that ever disagreed
 *   about it are caught on the frame they disagree rather than several
 *   frames later when the positions have drifted apart.
 */
function checkNetcode(n) {
  assert.deepEqual(n.missing, [],
    "every field the chicken adds has to be in the CONSTRUCTOR: restoreSim " +
    "deletes any Fighter key a snapshot does not carry, so one first " +
    "assigned when a car landed would vanish on the first online rewind -- " +
    "on one machine only. Missing from a fresh fighter: " + n.missing);
  assert.equal(n.frozen, true,
    "simFrozen has to walk CHICKEN. It is deliberately not in ROSTER, so " +
    "without the extra walk every snapshot deep-copies whichever spec a bird " +
    "is mid-move on, and the identity test maxAlive uses stops holding");
  assert.equal(n.specKept, true,
    "which shows up here: a bird's move spec has to come back from a " +
    "rollback as the SAME OBJECT, not a copy of it");
  assert.equal(n.hashed, true,
    "and stateHash has to cover it: the same attackFrame on the same x is a " +
    "lawnmower on one machine and a peck on the other");
  assert.equal(n.survives, true,
    "a bird has to still be a bird after a save and a restore");
}

const NETCODE = `(function () {
  /* BEFORE reset(), and that is the whole of this check. reset() writes all
     three fields itself so every probe in this file starts from a known
     bird-free state -- which means a fighter it has touched has them whether
     the CONSTRUCTOR does or not. Asked afterwards this measures the harness.
     Nothing between startBattle and here assigns them: only becomeChicken and
     respawn do, and neither has run. */
  var n = { missing: [] };
  ['chicken', 'chickenSince', 'chickenEggs'].forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(fighters[0], k)) n.missing.push(k);
  });
  n.frozen = simFrozen().has(CHICKEN.specials.neutral) &&
             simFrozen().has(CHICKEN.specials.down);

  var p = reset(60), me = p[0], foe = p[1];
  me.becomeChicken();
  press(${'B.lay'});
  /* Run until the egg is actually IN THE AIR rather than for a fixed count:
     the lay's startup is data and a retune that moved it would leave this
     probe asserting about an egg that has not been laid yet, which reads as
     a netcode failure and is a stale number in a test. */
  for (var f = 0; f < 60 && !projectiles.some(function (q) {
         return q.constructor.name === 'Egg'; }); f++) {
    me.hitstop = 0; step(); press(0);
  }
  var spec = null;
  for (var i = 0; i < projectiles.length; i++) {
    if (projectiles[i].constructor.name === 'Egg') spec = projectiles[i].spec;
  }
  var snap = saveSim();
  var hashChicken = stateHash(snap);
  for (var f = 0; f < 5; f++) step();
  restoreSim(snap);
  n.survives = me.chicken === true;
  var back = null;
  for (var i = 0; i < projectiles.length; i++) {
    if (projectiles[i].constructor.name === 'Egg') back = projectiles[i].spec;
  }
  n.specKept = spec !== null && back === spec && back === CHICKEN.specials.down;

  /* The same snapshot with ONE bit changed -- whether he is a chicken -- has
     to hash differently, or the desync check cannot see the one field that
     changes what every other field means. */
  var flipped = saveSim();
  flipped.fighters[0].chicken = !flipped.fighters[0].chicken;
  n.hashed = stateHash(flipped) !== stateHash(snap);
  return JSON.stringify(n);
})()`;

test("the chicken is snapshotted, frozen, hashed and survives a rollback", async () => {
  const { run } = await arena("kel");
  checkNetcode(JSON.parse(run(NETCODE.replace("B.lay", String(B.lay)))));
});

test("control: a field assigned outside the constructor fails the snapshot test", async () => {
  withEngine(sabotage("    this.chicken = false;\n    this.chickenSince = -1;\n" +
                      "    this.chickenEggs = 0;\n\n    this.ai = {",
                      "\n    this.ai = {"));
  const { run } = await arena("kel");
  expectToFail(() => checkNetcode(JSON.parse(run(NETCODE.replace("B.lay", String(B.lay))))),
    "undeclared fields should fail checkNetcode");
});

test("control: a CHICKEN simFrozen never walked fails the by-reference test", async () => {
  withEngine(sabotage(
    "walk(ROSTER); walk(STAGES); walk(COMBAT); walk(PHYS); walk(CHICKEN);",
    "walk(ROSTER); walk(STAGES); walk(COMBAT); walk(PHYS);"));
  const { run } = await arena("kel");
  expectToFail(() => checkNetcode(JSON.parse(run(NETCODE.replace("B.lay", String(B.lay))))),
    "a spec deep-copied into every snapshot should fail checkNetcode");
});

test("control: a hash blind to the chicken fails the desync test", async () => {
  withEngine(sabotage("    h = mixNumber(h, f.chicken ? 1 : 0);\n", ""));
  const { run } = await arena("kel");
  expectToFail(() => checkNetcode(JSON.parse(run(NETCODE.replace("B.lay", String(B.lay))))),
    "a hash that cannot see it should fail checkNetcode");
});

/* =====================================================================
   7. THE SHAPE OF IT, in the data
   ===================================================================== */

test("the chicken's moveset is two free moves and no third", async () => {
  const { run } = await arena("kel");
  const c = JSON.parse(run("JSON.stringify(CHICKEN)"));
  assert.deepEqual(Object.keys(c.specials).sort(), ["down", "neutral"],
    "two buttons and no more: an `up` slot here would be a third attack the " +
    "request did not ask for and the drawing has no pose for");
  assert.equal(c.specials.neutral.kind, "peck");
  assert.equal(c.specials.down.kind, "egg");
  for (const k of ["neutral", "down"]) {
    assert.equal(c.specials[k].damage, 10, k + " should do ten");
    /* FREE, and it has to be written down. The mana loop under ROSTER prices
       every move in the game and CHICKEN is deliberately not in ROSTER, so an
       absent `mana` is undefined: canSpecial waves it through and the
       subtraction turns the bar into NaN for the rest of the match. */
    assert.equal(c.specials[k].mana, 0,
      k + " should be priced at zero by hand; it was " + c.specials[k].mana);
  }
  assert.equal(c.specials.down.goldenOneIn, 5, "one egg in five");
  assert.ok(c.transform > 0 && c.transform < 40,
    "the pop should be a few tenths of a second: " + c.transform);
  // Not on the roster, so nobody can pick it and the load-time loops under
  // ROSTER do not walk it.
  assert.equal(run("ORDER.indexOf('chicken')"), -1,
    "the chicken must not be a pickable character");
});

test("every chicken pose is a 16x16 grid with feet on the bottom row", async () => {
  const { run } = await arena("kel");
  const poses = JSON.parse(run("JSON.stringify(CHICKEN_POSES)"));
  const names = Object.keys(poses);
  assert.deepEqual(names.sort(), ["flap", "lay", "peck", "stand", "step"],
    "five poses: standing, the walk's other foot, airborne, pecking, laying");
  for (const k of names) {
    const rows = poses[k];
    assert.equal(rows.length, 16,
      k + " should be 16 rows -- the same cell every other fighter's sprite " +
      "sheet uses, so drawFighter puts a bird exactly where it puts a man");
    for (let i = 0; i < rows.length; i++) {
      assert.equal(rows[i].length, 16,
        k + " row " + i + " is " + rows[i].length + " wide, not 16: a ragged " +
        "grid rasterises into a bird with a bite out of it");
    }
    const ink = rows.join("").split("").filter((ch) => ch !== ".").length;
    assert.ok(ink > 60, k + " should actually be drawn; it has " + ink + " pixels");
  }
  // And every character in every pose has paint behind it, or it silently
  // rasterises as a hole.
  const paint = JSON.parse(run("JSON.stringify(CHICKEN_PAINT)"));
  for (const k of names) {
    for (const ch of new Set(poses[k].join("").split(""))) {
      if (ch === ".") continue;
      assert.ok(paint[ch],
        "pose " + k + " uses '" + ch + "', which CHICKEN_PAINT has no color " +
        "for -- pixelArt skips it, so it comes out as a hole in the bird");
    }
  }
});
