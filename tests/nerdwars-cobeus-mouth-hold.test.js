/* OPEN WIDE, HELD -- the half of the move 2.83 added.
 *
 * The complaint was "kams mouth opening move looks really cool now, but it
 * sucks. make it so he can use it while moving and let go of it at any point.
 * while he is using it he quickly uses up mana though." Three asks, and what
 * they add up to is that the sixty frames of open mouth stopped being spent
 * FOR him. `active` is ten now -- what a press buys -- and everything past
 * ten is a held button that walks, opens on release, and empties his bar at
 * 1.8 a frame.
 *
 * Which makes this the first charge in the file whose payload is a WAY HOME,
 * and that is what every test here is really about. The other three charges
 * -- Reese's crop dust, Trev's pawn, Cobeus' own bottle -- cost you a cloud or
 * a piece if you get them wrong. This one costs you a stock. So the gate
 * learned two words:
 *
 *   `ground`  the hold only runs on the floor. "I held my mouth open and now
 *             I cannot recover" is not a mistake you may make in the air,
 *             because in the air there is nothing to hold.
 *   `floor`   on the floor the drain stops at the price of the next cast, so
 *             it is not a mistake you may make on the ground either.
 *
 * and a third clause that is not a word at all: `!this.bedded()`. The mouth's
 * own bed pins attackFrame past `startup` with `specialSpawned` still false,
 * which satisfies every other clause in the gate, so holding up through the
 * nap re-pinned him and emptied seventy-two mana while he lay there. It is
 * invisible to the shipped bed test, whose probe presses with bitsToPad(2048)
 * -- and that sets `holdUp` FALSE.
 *
 * THE ARITHMETIC THE WHOLE MOVE HANGS ON, and it is four numbers that cannot
 * be retuned one at a time:
 *
 *       manaOverride 14  +  hold 40 x drain 1.8  +  floor 14  =  100
 *       a cast              the longest legal hold              the fare home
 *
 * A full bar is exactly one press, the longest hold the gate allows, and then
 * the press that gets him back to the stage. Test 3 asserts that off the spec
 * rather than off a number written down here.
 *
 * Every test has a NEGATIVE CONTROL: the same checker run against a copy of
 * the engine with one line changed in memory, and the check is that the same
 * assertions then fail. The mutated copies live in a string and a fresh vm
 * and are never written anywhere.
 *
 * A NOTE ON THE PADS. bitsToPad(2048) is a PRESS: it sets `spUp` and
 * `special` and leaves `holdUp` false. The hold levels are their own bits --
 * 4096, 8192, 16384 for neutral, down and up -- and 16384 is what the charge
 * gate reads. A probe that only ever presses cannot see any of this, which is
 * the whole reason the shipped bed test could not.
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
    __on: {},
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

/* Takes the engine SOURCE rather than always reading it off disk, so a
   negative control can boot a mutated copy in a fresh vm without that copy
   ever touching the filesystem. */
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

/* One line of the engine, changed in memory. Never written to disk, and
   never applied to the copy the real tests run against.

   Both halves are asserted. A needle that is not there, or is there twice,
   makes a control that silently mutates nothing or mutates the wrong thing --
   which is exactly the failure a negative control exists to rule out. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker the real test ran,
   and it has to throw an assertion. Anything else thrown is a broken checker
   rather than a failed test, and is let through so it shows up as itself. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

async function arena(a, b, opts) {
  const o = opts || {};
  const run = await bootEngine(o.engine);
  run(`select.cursor=[${a},${b}]; twoPlayer=true; playerCount=2; humanCount=0;` +
      ` stagePick=${o.stage || 0}; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  return run;
}
/* Positions in ORDER, which is what select.cursor takes. */
const COBEUS = 6, NICK = 0;

const SP_UP = 2048, HOLD_UP = 16384, SP_NEUTRAL = 512, RIGHT = 2, ATTACK = 32;
const PRESS_AND_HOLD = SP_UP | HOLD_UP;

/* Two seats, reset, and the rest of the world put where it can be ignored.
   `mouthLift` and `chargeTimer` are reset with everything else because they
   are state: one lift per trip through the air, and each probe below is a
   fresh trip. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0; freezeFrames = 0;
  fighters.forEach(function (f) {
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
    f.landLag = 0; f.invuln = 9999; f.mana = 100; f.vx = 0; f.vy = 0;
    f.grabbing = -1; f.grabbedBy = -1; f.grounded = true; f.y = main.y;
    f.stocks = 9; f.eliminated = false; f.health = 60; f.hasHit = true;
    f.attackFrame = 0; f.specialSpawned = false; f.chargeTimer = 0;
    f.fat = 0; f.bedTimer = 0; f.mouthLift = false;
  });
  me.x = main.x + 70; me.facing = 1;
  foe.x = me.x + 90; foe.facing = -1; foe.invuln = 9999;`;

const mouth = (run) =>
  JSON.parse(run("JSON.stringify(ROSTER.cobeus.specials.up)"));

/* =====================================================================
   1. A HELD MOUTH IS AN OPEN MOUTH

   `absorb.from` IS `startup`, and that one character is the whole move. The
   charge pin parks attackFrame ON startup, and sweepFrail reads attackFrame,
   so a window that began at startup + 1 was a window a HELD mouth never
   entered: held was shut. Holding bought him a walk, an empty bar, and
   nothing at all.
   ===================================================================== */

const heldCatch = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.health = 40;
  netplay.active = true;
  var h0 = me.health;
  netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
  /* Long enough that a press alone would be over: the move is 28 frames and
     active is 10, so by frame 20 an unheld mouth is in its recovery. */
  var pinned = 0, openWhilePinned = 0, s = me.specialsNow.up;
  for (var i = 0; i < 20; i++) {
    netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
    if (me.chargeTimer > 0) {
      pinned++;
      if (me.attackFrame >= s.absorb.from && me.attackFrame <= s.absorb.to) {
        openWhilePinned++;
      }
    }
  }
  /* Now feed him, still holding, well past the ten frames a press buys. */
  netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(${SP_NEUTRAL})]; step();
  var caught = -1, ctAtCatch = -1;
  for (var i = 0; i < 20; i++) {
    me.hitstop = 0; foe.hitstop = 0; foe.invuln = 9999;
    var L = projectiles.filter(function (q) { return !q.dead && q.owner === foe; });
    if (L.length) { L[0].x = me.x + 4; L[0].y = me.y - 13; L[0].vx = 0; L[0].vy = 0; }
    var f0 = me.fat, ct = me.chargeTimer;
    netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
    if (me.fat > f0) { caught = i; ctAtCatch = ct; break; }
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ pinned: pinned, openWhilePinned: openWhilePinned,
    caught: caught, ctAtCatch: ctAtCatch, fat: me.fat,
    healed: +(me.health - h0).toFixed(3) });
})()`));

function checkHeldIsOpen(m, r) {
  assert.equal(m.absorb.from, m.startup,
    "the catching window has to OPEN on `startup`, because that is the frame " +
    "the charge pin parks him on. `from` is " + m.absorb.from + " and " +
    "`startup` is " + m.startup + ": one apart is a held mouth that is shut " +
    "for the whole hold, which is the bug this move shipped with");
  assert.ok(r.pinned >= 15,
    "precondition: he really was pinned -- the probe held the button for " +
    "twenty frames and the counter moved on " + r.pinned + " of them");
  assert.equal(r.openWhilePinned, r.pinned,
    "and EVERY pinned frame is inside `absorb` [" + m.absorb.from + ", " +
    m.absorb.to + "]. It has to be all of them rather than most: the pin is " +
    "one frame repeated, so a single pinned frame outside the window means " +
    "the whole hold is outside it. " + r.openWhilePinned + " of " + r.pinned +
    " were inside");
  assert.ok(r.caught >= 0,
    "and a shot arriving twenty frames into a hold is swallowed -- which is " +
    "the point of holding, and is about twice as long as the ten frames a " +
    "bare press buys. It was never caught");
  assert.ok(r.ctAtCatch > 10,
    "on a genuinely held frame rather than on the tail of the press; the " +
    "charge counter read " + r.ctAtCatch + " when it went in");
  assert.equal(r.healed, m.absorb.heal,
    "and it heals the same flat `absorb.heal` (" + m.absorb.heal + ") a " +
    "pressed catch does -- holding buys TIME and not a bigger meal; he " +
    "gained " + r.healed);
}

test("a held mouth is an open mouth", async () => {
  const run = await arena(COBEUS, NICK);
  checkHeldIsOpen(mouth(run), heldCatch(run));
});

test("negative control: a window that starts one frame after startup is shut for the whole hold", async () => {
  /* The shipped bug, exactly: `from` one past `startup`. Everything else is
     identical -- same pin, same walk, same drain, same ten active frames --
     and the move a player holds open catches nothing while he holds it. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.0625, bite: 8 },",
    "      absorb: { pad: 14, from: 7, to: 15, heal: 8, fat: 0.0625, bite: 8 },") });
  expectToFail(() => checkHeldIsOpen(mouth(run), heldCatch(run)),
    "a mouth that is shut while it is held should fail the held-open test; " +
    "it passed");
});

/* =====================================================================
   2. ONE LIFT PER TRIP THROUGH THE AIR

   `mouthLift` is the only field this whole block adds to a Fighter, and it
   exists because the move got cheap. At fourteen mana a full bar is seven
   presses, and seven times `rise` is a man who never comes down. The float
   still runs on every cast -- a second press still buys hang time -- but the
   pop is once per trip, and the FLOOR is what hands it back.
   ===================================================================== */

/* A LIFT IS A FALL TURNING INTO A CLIMB, which is the only thing in this
   move that can make vy negative. Not "a big change in vy": the FLOAT clamps
   a man at maxFall to `air.hang`, which is a drop of four and a half in one
   frame and is not a lift at all -- it is the second cast doing exactly what
   a second cast is still supposed to do. */
const liftCounts = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  netplay.active = true;

  /* ONE FALL, TWO CASTS. High enough that the first move is long over before
     the second press, and with mana for seven of them. */
  me.x = main.x + 60; me.y = main.y - 130; me.grounded = false;
  me.vy = 0.5; me.jumpsLeft = 0; me.mana = 100; me.mouthLift = false;
  var oneFall = 0, prevVy = me.vy, casts = 0, was = false;
  for (var i = 0; i < 70; i++) {
    var bits = (i === 0 || i === 40) ? ${SP_UP} : 0;
    netplay.framePads = [bitsToPad(bits), bitsToPad(0)]; step();
    if (me.state === 'special' && !was) casts++;
    was = me.state === 'special';
    if (me.vy < 0 && prevVy >= 0) oneFall++;
    prevVy = me.vy;
    if (me.grounded) break;
  }

  /* TWO TRIPS. Cast in the air, put him back on the floor, cast in the air
     again. Driven in two explicit halves rather than by watching for a
     landing, because stage 0 has a thin platform forty pixels up and a probe
     that drops him from there lands him on the frame after the press. */
  ${SETUP}
  netplay.active = true;
  var twoTrips = 0, landed = 0, clearedOnLanding = -1, prev2 = 0;
  for (var trip = 0; trip < 2; trip++) {
    me.x = main.x + 60; me.y = main.y - 120; me.grounded = false;
    me.vy = 0.5; me.jumpsLeft = 0; me.mana = 100;
    /* landLag is what a landing costs, and it gates starting anything --
       so without this the second press is simply refused and the probe
       measures the lag rather than the flag. */
    me.landLag = 0; me.hitstun = 0; me.hitstop = 0;
    me.setState('air'); me.attackFrame = 0; me.specialSpawned = false;
    prev2 = me.vy;
    netplay.framePads = [bitsToPad(${SP_UP}), bitsToPad(0)]; step();
    if (me.vy < 0 && prev2 >= 0) twoTrips++;
    prev2 = me.vy;
    for (var i = 0; i < 30 && me.state === 'special'; i++) {
      netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step();
      if (me.vy < 0 && prev2 >= 0) twoTrips++;
      prev2 = me.vy;
    }
    /* And down onto the main floor, which is the thing that hands it back. */
    me.x = main.x + 60; me.y = main.y - 3; me.vy = 2; me.grounded = false;
    for (var i = 0; i < 20 && !me.grounded; i++) {
      netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step();
      prev2 = me.vy;
    }
    if (trip === 0) {
      landed = me.grounded ? 1 : 0;
      clearedOnLanding = me.mouthLift ? 1 : 0;
    }
  }
  landed = landed && me.grounded ? 2 : landed;

  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ oneFall: oneFall, casts: casts, twoTrips: twoTrips,
    clearedOnLanding: clearedOnLanding, landed: landed });
})()`));

function checkOneLift(r) {
  assert.equal(r.casts, 2,
    "precondition: two separate casts inside one fall; there were " + r.casts);
  assert.equal(r.oneFall, 1,
    "TWO CASTS IN ONE FALL BUY ONE LIFT. The float still runs on the second " +
    "one -- holding a fall up is what a mouthful of air does -- but the POP " +
    "is once per trip through the air, and at fourteen mana a full bar is " +
    "seven presses. It lifted " + r.oneFall + " times");
  assert.equal(r.landed, 2,
    "precondition: the second half of this probe has to actually land him " +
    "between the two casts; it reached stage " + r.landed);
  assert.equal(r.clearedOnLanding, 0,
    "and the FLOOR is what hands it back -- collidePlatforms clears it beside " +
    "the jumps, on the same line and for the same reason. After landing it " +
    "was still " + (r.clearedOnLanding ? "set" : "clear"));
  assert.equal(r.twoTrips, 2,
    "so cast, land, cast is TWO lifts. Anything else and his recovery is " +
    "once a stock rather than once a fall; it lifted " + r.twoTrips + " times");
}

test("the lift fires once a trip through the air", async () => {
  const run = await arena(COBEUS, NICK);
  checkOneLift(liftCounts(run));
});

test("negative control: without the flag one fall buys as many lifts as he can pay for", async () => {
  /* The guard dropped and nothing else touched. Seven presses is seven pops
     of -5.4 with a float under each of them, which is not a recovery, it is
     a ladder. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "          if (!this.grounded && !this.mouthLift) {",
    "          if (!this.grounded) {") });
  expectToFail(() => checkOneLift(liftCounts(run)),
    "a fall that buys two lifts should fail the one-lift test; it passed");
});

/* =====================================================================
   3. A FULL BAR IS A CAST, THE CAP, AND THE FARE HOME
   ===================================================================== */

const capped = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  netplay.active = true;
  netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
  var maxCt = 0, minMana = 999;
  for (var i = 0; i < 200 && me.state === 'special'; i++) {
    netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
    if (me.chargeTimer > maxCt) maxCt = me.chargeTimer;
    if (me.mana < minMana) minMana = me.mana;
  }
  var manaAfter = me.mana;
  /* And then the press that gets him home, off whatever is left. */
  me.grounded = false; me.y = main.y - 40; me.vy = 1.0; me.jumpsLeft = 0;
  me.mouthLift = false;
  var before = me.mana, denied = 0, cast = false, lifted = false, prev = me.vy;
  for (var i = 0; i < 12; i++) {
    netplay.framePads = [bitsToPad(${SP_UP}), bitsToPad(0)]; step();
    if (me.state === 'special') cast = true;
    if (me.manaDenied > 0) denied++;
    if (me.vy < 0 && prev >= 0) lifted = true;
    prev = me.vy;
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ maxCt: maxCt, minMana: +minMana.toFixed(6),
    manaAfter: +manaAfter.toFixed(6), before: +before.toFixed(3),
    denied: denied, cast: cast, lifted: lifted });
})()`));

function checkFullBar(m, r, manaMax) {
  const sum = m.mana + m.charge.hold * m.charge.drain + m.charge.floor;
  assert.ok(Math.abs(sum - manaMax) < 1e-9,
    "A CAST, THE LONGEST LEGAL HOLD, AND THE FARE HOME, and they add to a " +
    "full bar exactly: mana " + m.mana + " + hold " + m.charge.hold + " x " +
    "drain " + m.charge.drain + " + floor " + m.charge.floor + " = " + sum +
    ", against COMBAT.manaMax of " + manaMax + ". None of the four numbers " +
    "can be retuned without the other three");
  assert.equal(r.maxCt, m.charge.hold,
    "a hold held forever stops at `charge.hold` (" + m.charge.hold +
    "); the counter reached " + r.maxCt);
  assert.ok(Math.abs(r.manaAfter - m.mana) < 1e-6,
    "and the bar it leaves him is exactly the price of the next cast (" +
    m.mana + "), which is what `floor` is for -- the drain stops at the fare " +
    "home rather than at nothing. It read " + r.manaAfter);
  assert.ok(r.minMana >= m.charge.floor - 1e-6,
    "and it never dipped below the floor on the way; the lowest was " +
    r.minMana);
  assert.equal(r.cast, true,
    "so the press that follows a maximal hold is NOT refused; he could not " +
    "cast");
  assert.equal(r.denied, 0,
    "and the bar never says no to it; `manaDenied` fired on " + r.denied +
    " frames");
  assert.equal(r.lifted, true,
    "and it lifts him, because a cast he cannot afford is exactly the bug " +
    "the old `rise` was patched for");
}

test("a full bar is one cast, the longest hold, and the fare home", async () => {
  const run = await arena(COBEUS, NICK);
  const manaMax = Number(run("COMBAT.manaMax"));
  checkFullBar(mouth(run), capped(run), manaMax);
});

test("negative control: a longer cap and no floor empties the bar and strands him", async () => {
  /* The two rules that stop a drain being a stock, both taken off at once,
     because they are one decision: a cap you cannot reach and a drain that
     runs to nothing. He holds until the bar is empty and then has no way
     back to the stage. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      charge: { hold: 40, walk: true, ground: true, drain: 1.8, floor: 14 },",
    "      charge: { hold: 60, walk: true, ground: true, drain: 1.8, floor: 0 },") });
  const manaMax = Number(run("COMBAT.manaMax"));
  expectToFail(() => checkFullBar(mouth(run), capped(run), manaMax),
    "a hold that empties the bar should fail the full-bar test; it passed");
});

/* =====================================================================
   4. HE CANNOT DRAIN A BAR HE IS NOT STANDING ON
   ===================================================================== */

const inTheAir = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  netplay.active = true;
  me.x = main.x + 60; me.y = main.y - 120; me.grounded = false;
  me.vy = 0.5; me.jumpsLeft = 0; me.mouthLift = false;
  var m0 = me.mana;
  netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
  /* The counter is read only on frames his feet are off the floor, and the
     run stops the moment they are not. Without the ground rule he pins in the
     air and then lands like anybody else, so "he never touched the ground" is
     not a precondition this probe can hold either way -- what it can hold is
     that nothing was charged while he was in the air.
     (No backticks in this comment: it lives inside a template literal and one
     of them would silently end the probe.) */
  var maxCt = 0, frames = 0, airFrames = 0;
  for (var i = 0; i < 90 && me.state === 'special'; i++) {
    netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
    frames++;
    if (me.grounded) break;
    airFrames++;
    if (me.chargeTimer > maxCt) maxCt = me.chargeTimer;
  }
  var spentInAir = m0 - me.mana;
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ maxCt: maxCt, frames: frames, airFrames: airFrames,
    m0: +m0.toFixed(3), spent: +spentInAir.toFixed(3) });
})()`));

function checkNoAirDrain(m, r) {
  assert.ok(r.airFrames >= 20,
    "precondition: the button is held down for a real stretch of airborne " +
    "move; it was airborne for " + r.airFrames + " frames of it");
  assert.equal(r.maxCt, 0,
    "`charge.ground` says the hold only runs on the FLOOR, so an airborne " +
    "cast with the button held down is an ordinary press: the counter never " +
    "moves. It reached " + r.maxCt + ". This is not tidiness -- the payload " +
    "of this move is a way home, and a man who can empty his bar while " +
    "falling can hold himself out of a stock");
  assert.ok(Math.abs(r.spent - m.mana) < 1e-6,
    "and the bar is spent exactly ONCE, on the press: " + m.mana +
    " mana, no more. He spent " + r.spent);
}

test("he cannot drain a bar he is not standing on", async () => {
  const run = await arena(COBEUS, NICK);
  checkNoAirDrain(mouth(run), inTheAir(run));
});

test("negative control: without charge.ground a falling man can empty his bar", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "        !this.bedded() && !(m.charge.ground && !this.grounded) &&",
    "        !this.bedded() &&") });
  expectToFail(() => checkNoAirDrain(mouth(run), inTheAir(run)),
    "a charge that runs in the air should fail the ground test; it passed");
});

/* =====================================================================
   5. HE CANNOT DRAIN A BAR WHILE ASLEEP

   The shipped bed test presses with bitsToPad(2048), which sets `holdUp`
   false, so it cannot see this at all. The bed pins attackFrame at
   `startup + active` with `specialSpawned` still false and him standing on
   the floor -- which is every clause of the charge gate satisfied except the
   one that was added for it. Measured with the clause gone: 86 mana down to
   14 across a nap he did not choose to be in.
   ===================================================================== */

const bedHoldingIt = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.fat = 7; me.health = 40; me.mana = 100; foe.invuln = 9999;
  netplay.active = true;
  /* Eight catches, the last one through a held mouth, which is how anybody
     would actually reach the bed. */
  netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
  for (var i = 0; i < 5; i++) {
    netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
  }
  netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(${SP_NEUTRAL})]; step();
  for (var i = 0; i < 30 && me.bedTimer === 0; i++) {
    me.hitstop = 0; foe.hitstop = 0; foe.invuln = 9999;
    var L = projectiles.filter(function (q) { return !q.dead && q.owner === foe; });
    if (L.length) { L[0].x = me.x + 4; L[0].y = me.y - 13; L[0].vx = 0; L[0].vy = 0; }
    netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
  }
  var bed0 = me.bedTimer, mana0 = me.mana, ct0 = me.chargeTimer;
  /* Now hold it down for the whole nap. The counter is read as a RISE off
     whatever it arrived with: he reached the bed through a held mouth, so it
     arrives part-wound and frozen, and the question is whether it moves. */
  var ticks = 0, ctRise = 0, manaAtWake = -1, wokeAt = -1;
  for (var i = 0; i < 260; i++) {
    if (me.bedTimer > 0) {
      ticks++;
      if (me.chargeTimer - ct0 > ctRise) ctRise = me.chargeTimer - ct0;
    } else if (ticks > 0 && wokeAt < 0) { wokeAt = i; manaAtWake = me.mana; }
    foe.setState('idle'); foe.hitstun = 0; foe.hitstop = 0;
    netplay.framePads = [bitsToPad(${HOLD_UP} | ${RIGHT}), bitsToPad(0)];
    step();
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ bed0: bed0, ticks: ticks, ctRise: ctRise, ct0: ct0,
    mana0: +mana0.toFixed(3), manaAtWake: +manaAtWake.toFixed(3),
    drained: +(mana0 - manaAtWake).toFixed(3) });
})()`));

function checkNoBedDrain(m, r) {
  assert.equal(r.bed0, m.bed,
    "precondition: the eighth catch put him to bed for " + m.bed +
    "; the timer read " + r.bed0);
  assert.equal(r.ticks, m.bed,
    "precondition: and the whole nap is served with the button held down; " +
    r.ticks + " frames of it were");
  assert.equal(r.ctRise, 0,
    "a sleeping man is not charging. The bed pins attackFrame past `startup` " +
    "with `specialSpawned` still false and him lying on the floor, which is " +
    "every other clause of the charge gate satisfied -- so `!this.bedded()` " +
    "is the only thing standing between a held button and a free re-pin. He " +
    "went to bed with the counter on " + r.ct0 + ", which is where it froze, " +
    "and across " + r.ticks + " frames of nap it climbed " + r.ctRise);
  assert.equal(r.drained, 0,
    "and the nap costs him no mana at all. Without the clause it costs " +
    "`hold` x `drain`, which is seventy-two of a hundred, for something that " +
    "was done TO him. He lost " + r.drained);
}

test("he cannot drain a bar while he is asleep", async () => {
  const run = await arena(COBEUS, NICK);
  checkNoBedDrain(mouth(run), bedHoldingIt(run));
});

test("negative control: without the bedded() clause the nap empties his bar", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "        !this.bedded() && !(m.charge.ground && !this.grounded) &&",
    "        !(m.charge.ground && !this.grounded) &&") });
  expectToFail(() => checkNoBedDrain(mouth(run), bedHoldingIt(run)),
    "a nap that empties his bar should fail the asleep test; it passed");
});

/* =====================================================================
   6. THE FLOAT IS WALL CLOCK

   moveAge() is attackFrame + chargeTimer, and it is the one mechanism that
   makes a pin safe on a window measured in TIME. Held, attackFrame stands
   still and chargeTimer counts the frames it stood still for, so thirty
   frames of hang time are thirty frames whatever he does with the button.

   Keyed to attackFrame instead, a man who held on the floor and then walked
   off it gets the whole float over again -- free altitude bought with a
   button, on the one move in his kit that is a recovery.
   ===================================================================== */

const floatAfterAHold = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  var out = [];
  var holds = [5, 20, 40];
  for (var k = 0; k < holds.length; k++) {
    ${SETUP}
    netplay.active = true;
    netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
    for (var i = 0; i < holds[k]; i++) {
      netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
    }
    var s = me.specialsNow.up;
    /* The floor taken away mid-move, which is a man walking off a ledge with
       his mouth open. */
    me.grounded = false; me.y = main.y - 70; me.vy = 2.0;
    var floated = 0;
    for (var i = 0; i < 60 && me.state === 'special'; i++) {
      netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
      if (me.grounded) break;
      if (Math.abs(me.vy - (s.air.hang + PHYS.gravity)) < 1e-9) floated++;
    }
    out.push({ held: holds[k], ct: me.chargeTimer, floated: floated });
    netplay.active = false; netplay.framePads = null;
  }
  return JSON.stringify(out);
})()`));

function checkFloatIsWallClock(m, rows) {
  const by = {};
  for (const r of rows) by[r.held] = r.floated;
  assert.ok(by[5] > 0,
    "precondition: a short hold still leaves him some float; it left " +
    by[5] + " frames");
  assert.ok(by[20] < by[5],
    "THE FLOAT IS WALL CLOCK. `air.active` is " + m.air.active + " frames " +
    "from the cast, and frames spent holding on the floor are frames of it " +
    "spent: a twenty-frame hold has to leave LESS float than a five-frame " +
    "one. Five left " + by[5] + " and twenty left " + by[20]);
  assert.equal(by[40], 0,
    "and a hold to the cap -- " + m.charge.hold + " frames, which is past " +
    m.air.active + " -- leaves NONE of it. Otherwise holding the button is " +
    "free hang time on the one move in his kit that is a way home; it left " +
    by[40] + " frames");
}

test("the float is thirty frames of wall clock, held or not", async () => {
  const run = await arena(COBEUS, NICK);
  checkFloatIsWallClock(mouth(run), floatAfterAHold(run));
});

test("negative control: keyed to attackFrame the hold buys free hang time", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "        if (air && !this.grounded && this.moveAge() >= s.startup &&\n" +
    "            this.moveAge() < s.startup + (air.active || 0)) {",
    "        if (air && !this.grounded && this.attackFrame >= s.startup &&\n" +
    "            this.attackFrame < s.startup + (air.active || 0)) {") });
  expectToFail(() => checkFloatIsWallClock(mouth(run), floatAfterAHold(run)),
    "a float that starts over after a hold should fail the wall-clock test; " +
    "it passed");
});

/* =====================================================================
   7. LETTING GO OF THE STICK STOPS HIM

   `roots` did one thing: skip updateAttack's friction and air-drift block.
   While he holds, `chargeWalk` supersedes it completely -- so a conditional
   `roots` would be a second flag saying the same thing on the same frames,
   able to disagree with the first. And after release chargeWalk goes false
   while `roots` comes back, which is a tail of frames with no damping at all.

   Measured: a cast entered at a walk with nothing held slid 46.8 pixels, a
   seventh of the stage of uncommanded motion in a move whose stick did
   nothing. Without it, 0.73.
   ===================================================================== */

const glide = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  netplay.active = true;
  for (var i = 0; i < 25; i++) {
    netplay.framePads = [bitsToPad(${RIGHT}), bitsToPad(0)]; step();
  }
  var vxAtCast = me.vx, x0 = me.x;
  netplay.framePads = [bitsToPad(${SP_UP}), bitsToPad(0)]; step();
  var frames = 0;
  for (var i = 0; i < 200 && me.state === 'special'; i++) {
    netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step();
    frames++;
  }
  var loose = me.x - x0;
  /* And the other half: held, with the stick pushed, he WALKS -- which is
     the whole of what the user asked for. */
  ${SETUP}
  for (var i = 0; i < 25; i++) {
    netplay.framePads = [bitsToPad(${RIGHT}), bitsToPad(0)]; step();
  }
  var x1 = me.x;
  netplay.framePads = [bitsToPad(${PRESS_AND_HOLD} | ${RIGHT}), bitsToPad(0)]; step();
  for (var i = 0; i < 60 && me.state === 'special'; i++) {
    netplay.framePads = [bitsToPad(${HOLD_UP} | ${RIGHT}), bitsToPad(0)]; step();
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ vxAtCast: +vxAtCast.toFixed(3),
    loose: +loose.toFixed(2), frames: frames, walked: +(me.x - x1).toFixed(2) });
})()`));

function checkNoGlide(r) {
  assert.ok(r.vxAtCast > 1,
    "precondition: he casts at a full walk; vx was " + r.vxAtCast);
  assert.ok(Math.abs(r.loose) < 2,
    "CAST AT A WALK WITH NOTHING HELD, HE STOPS. `roots` skipped " +
    "updateAttack's friction for the whole move, so whatever speed he walked " +
    "in with was frozen for every frame of it -- 46.8 pixels of uncommanded " +
    "motion, a seventh of the stage, in a move whose stick did nothing. He " +
    "slid " + r.loose + " over " + r.frames + " frames");
  assert.ok(r.walked > 25,
    "and HOLDING it with the stick pushed still walks him, which is the ask " +
    "this move was reworked for: `chargeWalk` writes his vx while the button " +
    "is down. He covered " + r.walked + " pixels");
}

test("letting go of the stick stops him, and holding it walks him", async () => {
  const run = await arena(COBEUS, NICK);
  checkNoGlide(glide(run));
});

test("negative control: roots put back is a forty-six pixel silent glide", async () => {
  /* The flag restored beside the charge, which is the "make it conditional"
     answer at its most generous -- and it still measures 46.8 px of drift on
     a cast with nothing held, because after the hold ends chargeWalk goes
     false and roots does not. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      charge: { hold: 40, walk: true, ground: true, drain: 1.8, floor: 14 },",
    "      charge: { hold: 40, walk: true, ground: true, drain: 1.8, floor: 14 },\n" +
    "      roots: true,") });
  expectToFail(() => checkNoGlide(glide(run)),
    "a rooted cast should fail the glide test; it passed");
});

/* =====================================================================
   8. THE RECOVERY ENVELOPE IS NOT WORSE AT A QUARTER BAR

   This is the gate on the whole block, and it is the one property that was
   never allowed to move: `up` is how Cobeus gets home and there is nothing
   else. A drain on a recovery is a way to lose a stock to a button you were
   holding for a reason that seemed good at the time.

   Thirty-two cells -- eight distances off the lip by four depths below it --
   at a full bar, a quarter bar, and eighteen mana, which is under what the
   move used to COST. 2.82 reads 11 / 11 / 0. This reads 11 / 11 / 11: the
   envelope did not widen and it did not have to, because the thing that was
   broken is that a man with a fifth of a bar had no button at all.
   ===================================================================== */

const envelope = (run, mana0) => JSON.parse(run(`(function () {
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var home = 0, cells = 0;
  var outs = [10, 20, 30, 40, 50, 60, 70, 80];
  for (var oi = 0; oi < outs.length; oi++) {
    for (var down = 0; down <= 30; down += 10) {
      ${SETUP}
      fighters.forEach(function (f) { f.mana = ${mana0}; });
      me.x = main.x - outs[oi]; me.y = main.y + down;
      me.grounded = false; me.jumpsLeft = 0; me.facing = 1; me.vy = 0.8;
      foe.x = main.x + 200; foe.y = main.y; foe.grounded = true;
      netplay.active = true;
      var got = false;
      for (var i = 0; i < 300; i++) {
        var bits = ${RIGHT};
        if (me.state !== 'special' && me.vy > 1.2 && !me.grounded) bits |= ${SP_UP};
        netplay.framePads = [bitsToPad(bits), bitsToPad(0)]; step();
        if (me.eliminated || me.stocks < 9) break;
        if (me.grounded && me.x > main.x - 4) { got = true; break; }
      }
      netplay.active = false; netplay.framePads = null;
      cells++;
      if (got) home++;
    }
  }
  return JSON.stringify({ home: home, cells: cells });
})()`));

function checkEnvelope(m, full, quarter, thin) {
  assert.equal(full.cells, 32, "precondition: the grid is 32 cells");
  assert.ok(full.home >= 9,
    "off a FULL bar he gets home from at least nine of the thirty-two cells; " +
    "he managed " + full.home);
  assert.ok(quarter.home >= 9,
    "off a quarter bar the envelope is the same shape, because the press " +
    "that gets him home costs the same whether he held the last one for " +
    m.charge.hold + " frames or none; he managed " + quarter.home);
  assert.ok(thin.home >= 9,
    "AND OFF EIGHTEEN MANA, which is under what this move used to cost. That " +
    "is the whole of what `manaOverride` 14 and `charge.floor` 14 buy " +
    "between them: 2.82 reads nought of thirty-two here, because a man with " +
    "a fifth of a bar could not press the only button he has. He managed " +
    thin.home);
  assert.ok(m.mana <= 18,
    "and the price is what makes that true; it is " + m.mana);
}

test("the recovery envelope is not worse at a quarter bar", async () => {
  const run = await arena(COBEUS, NICK);
  checkEnvelope(mouth(run), envelope(run, 100), envelope(run, 25), envelope(run, 18));
});

test("negative control: at the old price a thin bar is no recovery at all", async () => {
  /* The price put back where 2.82 had it. Everything else is identical --
     same lift, same float, same drift, same grid -- and eighteen mana is a
     man who cannot press the only button that gets him home. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      bed: 180, guard: 0.6, shrink: 20,\n      manaOverride: 14,",
    "      bed: 180, guard: 0.6, shrink: 20,\n      manaOverride: 24,") });
  expectToFail(
    () => checkEnvelope(mouth(run), envelope(run, 100), envelope(run, 25), envelope(run, 18)),
    "a recovery he cannot afford should fail the envelope test; it passed");
});

/* =====================================================================
   9. A MOUTH SHUTTING STILL HAS A MOUTH -- AND A MAN ASLEEP HAS NONE

   drawMouth refuses to paint an OPEN cell on a frame nothing can be caught
   on, because a mouth held wide when the window has shut is a lie about the
   only thing the player is timing. One of the six open cells is not that lie:
   C0 is the mouth SHUTTING, which says "too late" rather than "now". Until
   2.83 nobody had to say so -- `absorb.to` was 66 and the close ran on 64 to
   66, so all of it was inside the window by arithmetic.

   IT WAS TWO EXEMPTIONS UNTIL 2.85. Z0, a man asleep, was the other, and it
   is gone: he is drawn lying in the bed now rather than standing bolt upright
   in it, his face comes out of SLEEP_ROWS, and drawMouth returns on bedded()
   before it picks a pose at all. So the bed's assertion here flips from "it
   paints" to "it paints nothing", and the frame the pin lands on stops being
   a special case -- with Z0 gone it falls out as the first frame of the close.

   The move is twenty-eight frames. The window shuts at 15, the pin is 16 and
   the close is 16 to 18, so all of them are outside it -- and measured on the
   built engine without MOUTH_EXEMPT, all three frames of the close draw
   nothing at all.
   ===================================================================== */

const everyFrameDraws = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  netplay.active = true;
  netplay.framePads = [bitsToPad(${SP_UP}), bitsToPad(0)]; step();
  netplay.active = false; netplay.framePads = null;
  if (me.state !== 'special') throw new Error('he did not cast: ' + me.state);
  var s = me.specialsNow.up, ops = 0;
  var rec = { globalAlpha: 1, fillStyle: '#000',
              fillRect: function () { ops++; },
              drawImage: function () { ops++; } };
  function draw(af, ct, bed) {
    me.attackFrame = af; me.chargeTimer = ct; me.bedTimer = bed;
    var was = ops;
    drawMouth(rec, me);
    return { af: af, pose: mouthPose(me, mouthArtFrame(me, s)), ops: ops - was };
  }
  var total = s.startup + s.active + s.recovery;
  var move = [], blank = [];
  for (var af = 0; af < total; af++) {
    var d = draw(af, 0, 0);
    move.push(d);
    if (d.ops === 0) blank.push(af);
  }
  var held = [];
  for (var ct = 1; ct <= s.charge.hold; ct++) held.push(draw(s.startup, ct, 0));
  var bedFrame = draw(s.startup + s.active, 0, 180);
  return JSON.stringify({ total: total, blank: blank,
    closing: move.filter(function (d) { return d.pose === 'C0'; }),
    heldBlank: held.filter(function (d) { return d.ops === 0; }).length,
    bedPose: bedFrame.pose, bedOps: bedFrame.ops,
    poses: move.map(function (d) { return d.pose; }).join(',') });
})()`));

function checkNothingGoesDark(r) {
  assert.equal(r.blank.join(","), "",
    "EVERY FRAME OF THE MOVE PAINTS SOMETHING. A mouth that vanishes " +
    "mid-move is its own bug, and it is the bug the open-cell gate causes " +
    "the moment the catching window stops covering the frames the closing " +
    "cells run on. These attackFrames drew nothing: " + r.blank.join(", "));
  assert.ok(r.closing.length >= 3,
    "the close is drawn, all three frames of it, on the frames AFTER the " +
    "window has shut -- a mouth swinging closed says 'too late' rather than " +
    "'now', which is not the promise the gate is there to stop. It drew " +
    r.closing.length + " frames of it");
  assert.equal(r.heldBlank, 0,
    "and a held mouth paints on every frame of the hold; " + r.heldBlank +
    " of them were blank");
  assert.equal(r.bedPose, "C0",
    "the frame the bed pins him on is not a special case any more: Z0 is " +
    "gone, so `startup + active` falls out as the first frame of the close. " +
    "It chose " + r.bedPose);
  assert.equal(r.bedOps, 0,
    "and NOTHING is painted on it, whichever pose that is. A bedded Cobeus " +
    "is drawn lying on his back by drawSleeper and his face -- the shut eye, " +
    "the breath, the mouth opening on it -- comes out of SLEEP_ROWS, so a " +
    "mouth built from the STANDING cell's rows 5 to 10 would be a hole in " +
    "the air above him. That is exactly what 2.84 drew. It painted " +
    r.bedOps + " times");
}

test("nothing the mouth draws goes dark, and the bed draws nothing at all", async () => {
  const run = await arena(COBEUS, NICK);
  checkNothingGoesDark(everyFrameDraws(run));
});

test("negative control: without MOUTH_EXEMPT the close draws nothing", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  if (MOUTH_OPEN[pose] && !open && !MOUTH_EXEMPT[pose]) return;",
    "  if (MOUTH_OPEN[pose] && !open) return;") });
  expectToFail(() => checkNothingGoesDark(everyFrameDraws(run)),
    "a move with three blank frames in the middle of it should fail the " +
    "nothing-goes-dark test; it passed");
});

test("negative control: without the bedded() return the bed paints again", async () => {
  /* The other half, and it has to be its own control: the close and the bed
     used to be one clause and they are two rules now. Take the return out and
     drawMouth reaches a pose on the pin frame, C0 is exempt, and a mouth is
     painted in the air above a man lying on his back -- 2.84 exactly. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  if (f.bedded()) return;\n" +
    "  /* TWO CLOCKS, AND THEY ARE DELIBERATELY NOT THE SAME CLOCK.",
    "  /* TWO CLOCKS, AND THEY ARE DELIBERATELY NOT THE SAME CLOCK.") });
  expectToFail(() => checkNothingGoesDark(everyFrameDraws(run)),
    "a mouth still painted over a sleeping man should fail the bed clause; " +
    "it passed");
});

/* =====================================================================
  10. THE ONE NEW FIELD SURVIVES A REWIND

   restoreSim deletes any own key a snapshot does not carry, so a field first
   written outside the constructor works perfectly offline and vanishes on the
   first online rewind. `mouthLift` is the only field this block adds, and
   what it guards is a free second lift -- so a rewind that dropped it would
   hand him one on exactly the frames a rollback is busiest.
   ===================================================================== */

const acrossARewind = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  /* Rebuilt rather than reset, because the failure this asks about is a
     rewind reaching back past his first cast of the match: by the time he has
     cast once the key exists whether or not the constructor wrote it. */
  startBattle();
  /* READ BEFORE HE HAS STOOD ANYWHERE. collidePlatforms clears this field on
     every landing, and a fighter standing on a platform lands on every frame,
     so a hundred and thirty frames of doing nothing creates the key whether
     or not the constructor did. The question is what a fighter has the
     instant he is built. */
  var f = fighters[0];
  var fresh = Object.prototype.hasOwnProperty.call(f, 'mouthLift');
  var freshValue = f.mouthLift;
  var freshSnap = Object.prototype.hasOwnProperty.call(saveSim().fighters[0], 'mouthLift');
  for (var i = 0; i < 130; i++) step();

  var main = STAGE.platforms.find(function (p) { return p.main; });
  f.x = main.x + 60; f.y = main.y - 120; f.grounded = false; f.vy = 0.5;
  f.jumpsLeft = 0; f.mana = 100; f.mouthLift = false;
  fighters[1].invuln = 99999;
  netplay.active = true;
  var snap = saveSim();
  var inSnap = Object.prototype.hasOwnProperty.call(snap.fighters[0], 'mouthLift');
  function play() {
    for (var i = 0; i < 24; i++) {
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_UP} : 0), bitsToPad(0)];
      step();
    }
    return stateHash();
  }
  var h1 = play(), lift1 = f.mouthLift, vy1 = +f.vy.toFixed(9);
  restoreSim(snap);
  var hasAfterRestore = Object.prototype.hasOwnProperty.call(f, 'mouthLift');
  var restored = f.mouthLift;
  var h2 = play(), lift2 = f.mouthLift, vy2 = +f.vy.toFixed(9);
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ fresh: fresh, freshValue: freshValue,
    freshSnap: freshSnap, inSnap: inSnap, hasAfterRestore: hasAfterRestore,
    restored: restored, h1: h1, h2: h2, lift1: lift1, lift2: lift2,
    vy1: vy1, vy2: vy2 });
})()`));

function checkRewind(r) {
  assert.equal(r.fresh, true,
    "`mouthLift` has to be declared in the Fighter CONSTRUCTOR: restoreSim " +
    "deletes any key a snapshot does not carry, so a field first written by " +
    "runSpecial works perfectly offline and vanishes on the first online " +
    "rewind that reaches back past his first cast of the match");
  assert.equal(r.freshValue, false,
    "and it starts false, which is the value that lets a fresh stock recover; " +
    "it started " + r.freshValue);
  assert.equal(r.freshSnap, true,
    "and a snapshot taken before he has acted has to carry it too");
  assert.equal(r.inSnap, true, "and so does one taken mid-fall");
  assert.equal(r.hasAfterRestore, true,
    "and the fighter still has it after a restore");
  assert.equal(r.restored, false,
    "restored to what it was on the frame the snapshot was taken, not to " +
    "what it had become; it came back " + r.restored);
  assert.equal(r.lift1, true,
    "precondition: the replayed stretch really does spend the lift");
  assert.equal(r.lift2, r.lift1,
    "and the replay spends it the same way; it read " + r.lift2);
  assert.equal(r.h2, r.h1,
    "so snapshot, play, restore, play is bit-identical -- which is the whole " +
    "contract. The hashes were " + r.h1 + " and " + r.h2);
  assert.equal(r.vy2, r.vy1,
    "including his vertical speed, which is what the lift actually writes; " +
    r.vy1 + " against " + r.vy2);
}

test("mouthLift survives a rewind", async () => {
  const run = await arena(COBEUS, NICK);
  checkRewind(acrossARewind(run));
});

test("negative control: a mouthLift written only by runSpecial vanishes on a rewind", async () => {
  /* The field taken out of the constructor and left to be created by the
     line that sets it. Offline this is invisible; online, the first rewind
     past his first cast deletes it. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "    this.mouthLift = false;\n    this.state = 'idle';",
    "    this.state = 'idle';") });
  expectToFail(() => checkRewind(acrossARewind(run)),
    "a field the constructor does not declare should fail the rewind test; " +
    "it passed");
});


/* =====================================================================
   11. THE FARE HOME IS THE FARE HOME

   `floor: 14` exists so that a man who holds his mouth open on the floor
   always has the price of one more cast left, because that cast is how he
   gets back onto the stage. The gate refuses to pin once the bar is at or
   below the floor -- but the drain on the last frame it DOES pin was clamped
   at ZERO, so it walked straight through. Swept every starting bar from 30.0
   to 100.0 in tenths, 683 of 701 held casts finished below 14, worst case
   12.2, and the only bar that landed on 14.000 was a full one -- and that
   because the 40-frame hold cap stopped him, not because the floor did.

   Two comments in this file's engine call that number the fare home and one
   of them says the four numbers cannot be retuned without each other. This
   test is what makes that true.
   ===================================================================== */

const theFloor = (run) => JSON.parse(run(`(function () {
  var s = ROSTER.cobeus.specials.up, floor = s.charge.floor;
  var worst = null, below = 0, n = 0;
  for (var k = 300; k <= 1000; k += 5) {
    ${SETUP}
    me.mana = k / 10;
    netplay.active = true;
    netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
    var g = 0;
    while (me.state === 'special' && g < 300) {
      netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step(); g++;
    }
    n++;
    var end = me.mana;
    if (end < floor - 1e-9) below++;
    if (worst === null || end < worst.end) worst = { start: k / 10, end: +end.toFixed(3) };
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ n: n, below: below, worst: worst, floor: floor });
})()`));

function checkTheFloor(r) {
  assert.ok(r.n > 100,
    "precondition: the sweep has to actually run; it played " + r.n + " casts");
  assert.equal(r.below, 0,
    "A HELD CAST MAY NEVER SPEND THE FARE HOME. `floor` is " + r.floor +
    " and it is the price of the press that gets him back onto the stage, so " +
    "no hold from any starting bar may finish below it. " + r.below + " of " +
    r.n + " did, the worst starting at " + (r.worst && r.worst.start) +
    " and finishing at " + (r.worst && r.worst.end) + ". A gate that refuses " +
    "to pin below the floor and then drains past it on the frame it last " +
    "pinned has not got a floor, it has got a suggestion");
}

test("holding the mouth open never spends the fare home", async () => {
  const run = await arena(COBEUS, NICK);
  checkTheFloor(theFloor(run));
});

test("negative control: a drain clamped at zero fails the floor test", async () => {
  /* What shipped. The clamp is the one that keeps a bar off negative, which
     is the right instinct and the wrong number on a move whose payload is a
     recovery: an empty bar IS being stranded, which is what `floor` was
     added to say. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "        this.mana = Math.max(m.charge.floor || 0, this.mana - m.charge.drain);",
    "        this.mana = Math.max(0, this.mana - m.charge.drain);") });
  expectToFail(() => checkTheFloor(theFloor(run)),
    "with the drain clamped at zero the floor test should fail; it passed");
});

/* =====================================================================
   12. LET GO AND IT IS OVER

   "let go of it at any point" is half the ask, and the half nobody checked
   is what happens when you press again. The other three charges close this
   gate with `specialSpawned`: they put a thing in the world and the flag goes
   up with it. The mouth puts NOTHING in the world -- it is a window -- so
   nothing ever closed the gate, and a second press on any frame of the cast,
   the twelve frames of recovery included, pulled attackFrame back to
   `startup` and re-opened the catching box without paying a second cast.

   Measured on the shipped engine: press, release, press again on frame 27 --
   deep inside recovery -- and the move ran 88 frames with 59 open ones,
   against 28 and 10. That is the punish window the recovery is supposed to
   sell, deferred and split at will. The CPU never does it (aiDecide stops
   holding at chargeTimer 24 and never re-grips) so no ladder can see it.
   ===================================================================== */

const theRegrip = (run) => JSON.parse(run(`(function () {
  var s = ROSTER.cobeus.specials.up;
  function play(grip) {
    ${SETUP}
    netplay.active = true;
    netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
    var f = 1, total = 0, open = 0;
    while (me.state === 'special' && total < 400) {
      var bits = f >= grip ? ${PRESS_AND_HOLD} : 0;
      netplay.framePads = [bitsToPad(bits), bitsToPad(0)]; step();
      f++; total++;
      if (me.state === 'special' && me.attackFrame >= s.absorb.from &&
          me.attackFrame <= s.absorb.to) open++;
    }
    return { total: total, open: open };
  }
  var out = { never: play(9999), held: null, grips: {} };
  [12, 16, 18, 20, 24, 27].forEach(function (g) { out.grips[g] = play(g); });
  /* And the hold itself, which must still work: press and never let go. */
  ${SETUP}
  netplay.active = true;
  netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
  var n = 0, peak = 0;
  while (me.state === 'special' && n < 400) {
    netplay.framePads = [bitsToPad(${PRESS_AND_HOLD}), bitsToPad(0)]; step();
    n++; if (me.chargeTimer > peak) peak = me.chargeTimer;
  }
  out.held = { frames: n, peakTimer: peak, endMana: +me.mana.toFixed(3) };
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify(out);
})()`));

function checkTheRegrip(m, r) {
  const bare = m.startup + m.active + m.recovery;
  assert.equal(r.never.total, bare,
    "precondition: a press nobody holds is the move's own length, " + bare +
    " frames; it ran " + r.never.total);
  assert.equal(r.never.open, m.active,
    "precondition: and a press buys exactly `active` open frames");

  for (const g of Object.keys(r.grips)) {
    const p = r.grips[g];
    assert.equal(p.total, r.never.total,
      "PRESSING AGAIN DOES NOT TAKE THE MOVE BACK. Released and then pressed " +
      "again on frame " + g + ", the cast still has to be the same " +
      r.never.total + " frames it was; it ran " + p.total + ". A gate with no " +
      "ceiling lets a second press pull attackFrame back to `startup` for " +
      "free, and the frames it buys back are the recovery -- which is the " +
      "price of opening the mouth at nothing, and the only reason this is a " +
      "guess the other player gets to win");
    assert.equal(p.open, r.never.open,
      "and it buys no extra open frames either; frame " + g + " re-gripped " +
      "bought " + p.open + " against " + r.never.open);
  }

  /* The other side of the same coin: a ceiling tight enough to refuse a
     re-grip must still admit the hold the move is FOR. */
  assert.equal(r.held.peakTimer, m.charge.hold,
    "AND A GENUINE HOLD STILL REACHES THE CAP. The pin writes attackFrame " +
    "back to `startup` and something else advances it, so a charge that is " +
    "holding alternates startup and startup+1 -- a ceiling written at " +
    "`startup` alone lets every charge in the file pin for one frame and then " +
    "quietly abandons it. The cap is " + m.charge.hold + " and he reached " +
    r.held.peakTimer);
  assert.equal(+r.held.endMana.toFixed(3), m.charge.floor,
    "and the longest legal hold off a full bar ends on the fare home exactly: " +
    m.manaOverride + " + " + m.charge.hold + " x " + m.charge.drain + " + " +
    m.charge.floor + " = 100. It ended on " + r.held.endMana);
}

test("letting the mouth go ends the move, and pressing again does not take it back", async () => {
  const run = await arena(COBEUS, NICK);
  checkTheRegrip(mouth(run), theRegrip(run));
});

test("negative control: a charge gate with no ceiling fails the re-grip test", async () => {
  /* What shipped: `attackFrame >= startup` and nothing above it. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "        this.attackFrame <= m.startup + 1 &&\n", "") });
  expectToFail(() => checkTheRegrip(mouth(run), theRegrip(run)),
    "with no ceiling on the charge gate the re-grip test should fail; it passed");
});

test("negative control: a ceiling written at `startup` breaks the hold itself", async () => {
  /* The obvious number, and it is wrong, which is why the test above asserts
     the cap as well as the ceiling. The pin is written in one place and the
     counter advanced in another, so a holding charge alternates between
     `startup` and `startup + 1`: an equality ceiling pins for one frame and
     then lets go, silently, with the move still firing. Measured under this
     arm: Reese's cap falls from 72 to 1, the bottle's from 120 to 1, and the
     mouth's from 40 to 1. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "        this.attackFrame <= m.startup + 1 &&",
    "        this.attackFrame === m.startup &&") });
  expectToFail(() => checkTheRegrip(mouth(run), theRegrip(run)),
    "with the ceiling written as an equality the re-grip test should fail; " +
    "it passed");
});
