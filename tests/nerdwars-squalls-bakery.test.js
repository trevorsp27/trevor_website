/* SOMEDAY, A BAKERY, as 2.81 rebuilt it: a button you HOLD.
 *
 * The move it replaces was not balanced badly, it was BROKEN, and broken in
 * the quietest way this engine knows. A sticky `wakeUp` flag was written on
 * any frame jump, attack, shield or grab was down -- including during the
 * startup, before the move was old enough to be cancelled -- and spent the
 * instant the read opened on frame nineteen. So you pressed down-special,
 * kept playing for a third of a second the way anybody would, and the move
 * evaporated with thirteen dream and no bread. It then set `attackFrame` to
 * the END of the window, which is why a cancelled cast read back exactly like
 * a completed one and the first measurement of the move reported 45% running
 * the full eighty when the truth was 3.9%.
 *
 * Every test in here exists because of a different half of that story:
 *
 *   The daydream is as long as you hold it and pays per frame, so what it
 *   banks has to be PROPORTIONAL to the hold rather than a lump on the end.
 *
 *   `active` is 1, and 1 is the number most likely to be read as a typo by
 *   the next person through. It is not the length of the move any more --
 *   `charge.hold` is -- and every frame of `active` past the first is a tail
 *   he has to sit through AFTER letting go. At 80 it was ninety-one frames;
 *   at the two hundred this was nearly shipped as, two hundred and twelve.
 *
 *   The loaves are keyed on `chargeTimer` rather than on `attackFrame`,
 *   because the pin freezes attackFrame and would freeze the oven with it.
 *   That re-keying moved an off-by-one from one end of the move to the
 *   other, so both ends are pinned: nothing at the cast, and the fifth loaf
 *   on the last held frame.
 *
 *   And nothing but the special's own button may end it. That is the direct
 *   replacement for the wake trap and it is the test the move exists for.
 *
 * Everything here drives the move through the real input path -- the press is
 * the edge bit and the hold is the level bit, exactly as netplay packs them
 * -- and reads what actually happened. Every test has a NEGATIVE CONTROL: the
 * same checker run against a copy of the engine with one line changed in
 * memory, and the check is that the same assertions then fail. The mutated
 * copies live in a string and a fresh vm and are never written anywhere.
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

/* Two fighters on a stage, past the 110 frames of spawn invulnerability.
   `a` and `b` are positions in ORDER. Both seats are CPUs, which costs
   nothing: every measurement below hands both of them pads of its own, and a
   pad from netplay is what the fighter reads. */
async function arena(a, b, opts) {
  const o = opts || {};
  const run = await bootEngine(o.engine);
  run(`select.cursor=[${a},${b}]; twoPlayer=true; playerCount=2; humanCount=0;` +
      ` stagePick=${o.stage || 0}; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  return run;
}
/* The world put somewhere known. Deliberately NOT the middle of the floor:
   the bread lands behind him, and one of these tests walks him a hundred and
   thirty pixels to the right while he bakes. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  freezeFrames = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 999; me.mana = 100; me.vx = 0; me.vy = 0;
  me.grabbing = -1; me.grabbedBy = -1; me.grounded = true; me.facing = 1;
  me.ultMeter = 0; me.x = main.x + 30; me.y = main.y; me.specialSpawned = false;
  me.dream = 0; me.health = 100; me.chargeTimer = 0; me.attackFrame = 0;
  foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
  foe.stocks = 3; foe.eliminated = false; foe.health = 100; foe.hasHit = true;
  foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y;
  foe.invuln = 9999; foe.mana = 0;
  foe.grabbing = -1; foe.grabbedBy = -1;
  foe.x = main.x + main.w - 8;`;

// The pad bits, as netplay packs them. The press is an EDGE and the hold is a
// LEVEL, and the whole move is the difference between them.
const JUMP = 16, ATTACK = 32, GRAB = 64, SHIELD = 128;
const SP_NEUTRAL = 512, SP_DOWN = 1024, SP_UP = 2048;
const HOLD_DOWN = 8192;
const LEFT = 1, RIGHT = 2;

const REESE = 4, SQUALLS = 8;

const spec = (run) =>
  JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.down)"));

/* ONE CAST, held for `n` charge frames and then let go, traced to the frame
   he is out of the move.

   `n` is counted in CHARGE frames and not in probe frames, and the difference
   is nine of them: the pin does not engage until attackFrame reaches
   `startup`, so a probe that let the button go after `hold` frames would stop
   nine short of the cap and bank 63.45 of the 67.5 the move advertises. That
   mistake is silent -- everything still works, the number is just wrong --
   which is why the arithmetic is written out here rather than inline.

   `extra` rides on every held frame, which is how the six-button sweep and
   the walk are done: one probe, one press path, and the only variable is
   what else is down. */
const daydream = (run, n, extra) => JSON.parse(run(`(function () {
  ${SETUP}
  var s = me.specialsNow.down;
  var until = s.startup + ${n};
  var loafAt = [], loafX = [], loafAbs = [], known = [];
  var idleAt = -1, lastHeld = -1, manaAtCap = null, timerAtCap = null;
  netplay.active = true;
  for (var i = 0; i < 620; i++) {
    var hold = i > 0 && i < until;
    if (hold) lastHeld = i;
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_DOWN}
                                 : hold ? (${HOLD_DOWN} | ${extra || 0}) : 0),
                         bitsToPad(0)];
    /* The mana bar is NOT topped up. The drain is half the arithmetic this
       move is built on -- ten up front and six tenths a frame against a bar
       that does not refill inside a special -- so a probe that refilled it
       would be measuring a different move. */
    me.hitstop = 0;
    step();
    if (me.chargeTimer === s.charge.hold && manaAtCap === null) {
      manaAtCap = +me.mana.toFixed(6);
      timerAtCap = i;
    }
    var live = projectiles.filter(function (q) {
      return q.constructor.name === 'Loaf';
    });
    for (var k = 0; k < live.length; k++) {
      if (known.indexOf(live[k]) < 0) {
        known.push(live[k]);
        loafAt.push(me.chargeTimer);
        loafX.push(+(live[k].x - me.x).toFixed(2));
        loafAbs.push(+live[k].x.toFixed(2));
      }
    }
    if (idleAt < 0 && i > 0 && me.state !== 'special') { idleAt = i; break; }
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ held: me.chargeTimer, dream: +me.dream.toFixed(4),
           idleAt: idleAt, lastHeld: lastHeld, tail: idleAt - lastHeld,
           loafAt: loafAt.join(','), loafX: loafX.join(','),
           loafAbs: loafAbs.join(','),
           loaves: known.length, mana: +me.mana.toFixed(6),
           manaAtCap: manaAtCap, x: +me.x.toFixed(2) });
})()`));

/* =====================================================================
   1. IT BANKS WHAT IT STOOD FOR
   ===================================================================== */

function checkProportional(s, rows) {
  for (const r of rows) {
    assert.equal(r.held, r.want,
      "precondition: holding for " + r.want + " charge frames should leave " +
      "`chargeTimer` there; it read " + r.held);
    const want = +(s.dream * r.want).toFixed(4);
    assert.ok(Math.abs(r.dream - want) < 1e-6,
      "a hold of " + r.want + " frames should bank `dream` x " + r.want +
      " = " + want + "; it banked " + r.dream);
  }
}

test("a released hold banks what it stood for and no more", async () => {
  const run = await arena(SQUALLS, REESE);
  const s = spec(run);
  const rows = [10, 30, 60, 120, 150].map((n) =>
    Object.assign({ want: n }, daydream(run, n)));
  checkProportional(s, rows);
  /* And the top of it, stated as its own number, because this is the
     assertion the shipped suite used to make the other way round: a FULL
     hold banks 67.5 of the dragon's hundred, not the hundred. No single
     press fills the meter any more and none ever did -- the live figure for
     the move this replaces was 19.2. */
  const u = JSON.parse(run("JSON.stringify(ROSTER.squalls.ult)"));
  const full = rows[rows.length - 1];
  assert.ok(full.dream < u.dreamMax,
    "a full hold must not fill the dragon's meter (" + u.dreamMax +
    "); it banked " + full.dream);
});

test("negative control: a daydream paid as a lump fails the proportional test", async () => {
  /* The version that looks identical on screen: he stands there, the bar
     climbs, the bread lands, and what he gets for a long hold is what he
     gets for a short one. This is what "the meter is paid per dreaming
     frame" is actually worth, and nothing else in the move says it. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "          this.dream = Math.min(100, this.dream + s.dream);",
    "          this.dream = Math.min(100, this.chargeTimer > 1 ? this.dream : this.dream + 19.2);") });
  const s = spec(run);
  const rows = [10, 30, 60, 120, 150].map((n) =>
    Object.assign({ want: n }, daydream(run, n)));
  expectToFail(() => checkProportional(s, rows),
    "a flat payout regardless of hold should fail the proportional test; it passed");
});

/* =====================================================================
   2. THE TAIL AFTER RELEASE -- the correction this rework is built on
   ===================================================================== */

/* `active` is 1. The charge pins attackFrame on `startup` for as long as the
   button is down, so `active` is no longer how long the move runs: it is only
   what keeps napping() true while pinned, which is what carries the knockback
   softener and the sleeping pose. Every frame of it past the first is a tail
   he has to sit through AFTER letting go.

   This was very nearly shipped at 200, which is two hundred and twelve frames
   of standing still after the player has finished with the move -- worse than
   the bug it was rescuing him from. The control is `active: 80`, which is the
   number it shipped as before this pass and is a ninety-one frame tail. */
function checkTail(s, r) {
  assert.equal(s.active, 1,
    "precondition: `active` is 1 -- see the roster. It is not the length of " +
    "the move, it is what keeps napping() true while the pin holds " +
    "attackFrame still; it reads " + s.active);
  assert.equal(r.tail, s.active + s.recovery,
    "letting go should leave `active` + `recovery` (" +
    (s.active + s.recovery) + ") frames of tail and no more; the move ran " +
    r.tail + " frames past the last held one");
  assert.ok(r.tail <= 13,
    "which is thirteen frames. At `active` 80 it is 91 and at 200 it is 212, " +
    "and a move that strands him for two hundred frames after he has " +
    "finished with it is worse than the bug this replaced; it ran " + r.tail);
}

test("the tail after release is thirteen frames, not ninety-one and not two hundred and twelve", async () => {
  const run = await arena(SQUALLS, REESE);
  checkTail(spec(run), daydream(run, 30));
});

test("negative control: active 80 fails the tail test", async () => {
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      startup: 10, active: 1, recovery: 12,\n" +
    "      /* `walk` is what makes it a button rather than a sentence",
    "      startup: 10, active: 80, recovery: 12,\n" +
    "      /* `walk` is what makes it a button rather than a sentence") });
  const s = spec(run);
  assert.equal(s.active, 80, "precondition: the control really is at 80");
  expectToFail(() => checkTail(s, daydream(run, 30)),
    "an eighty-frame active should fail the tail test; it passed");
});

/* =====================================================================
   3. FIVE LOAVES, THE FIFTH ON THE LAST HELD FRAME
   ===================================================================== */

/* The drop is keyed on `chargeTimer` and not on `attackFrame`, because the
   pin holds attackFrame still and counting off it bakes one loaf and then
   nothing. chargeTimer is 0 on the cast and 1..150 while pinned, which is why
   the `t > 0` guard survived the re-keying and is now load-bearing for a
   different reason: without it a loaf drops on the frame of the cast, before
   he has dreamed anything at all.

   Both ends are pinned here, and they have to be. The old move advertised
   four loaves and baked three because the window never REACHED the fourth
   multiple; this one is arranged so the fifth lands exactly on the last held
   frame, which is one frame from not existing. */
function checkLoaves(s, held, tapped) {
  const at = held.loafAt.split(",").filter((v) => v !== "").map(Number);
  assert.equal(at.length, s.loaves,
    "a full hold should bake `loaves` (" + s.loaves + ") of them; it baked " +
    at.length + " at charge frames " + held.loafAt);
  for (let i = 0; i < at.length; i++) {
    assert.equal(at[i], s.every * (i + 1),
      "loaf " + (i + 1) + " belongs on charge frame " + (s.every * (i + 1)) +
      "; they landed on " + held.loafAt);
  }
  assert.equal(at[at.length - 1], s.charge.hold,
    "and the last one lands on the LAST held frame (" + s.charge.hold +
    "), so there is no dead payout time at the end of the hold; it landed " +
    "on " + at[at.length - 1]);
  assert.equal(tapped.loaves, 0,
    "and a press that is never held bakes NOTHING -- the guard against a " +
    "loaf at charge frame zero; the tap left " + tapped.loaves);
}

test("five loaves, the fifth on the last held frame, and none at the cast", async () => {
  const run = await arena(SQUALLS, REESE);
  const s = spec(run);
  checkLoaves(s, daydream(run, s.charge.hold), daydream(run, 0));
});

test("negative control: dropping the t > 0 guard puts a loaf on the cast", async () => {
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "          if (t > 0 && t % s.every === 0 && t / s.every <= s.loaves) {",
    "          if (t % s.every === 0 && t / s.every <= s.loaves) {") });
  const s = spec(run);
  expectToFail(() => checkLoaves(s, daydream(run, s.charge.hold), daydream(run, 0)),
    "without the t > 0 guard a tap should bake a loaf and fail the test; it passed");
});

/* =====================================================================
   4. AND THE BREAD TRAILS HIM
   ===================================================================== */

/* `charge.walk` is the other half of the rework and this is what it is for.
   The loaves land behind him at a growing offset, so he leaves a line of
   bread across the floor rather than a pile at his feet -- and every one of
   them is on the side of him he came from, which is what the "it is not your
   bread until you have eaten it" balance depends on.

   The spacing is not `every` times his walk. Each loaf is dropped seven
   pixels further back than the one before it, so at 1.38 a step and a loaf
   every thirty frames, consecutive loaves are 41.4 - 7 = 34.4 apart. Written
   out because the obvious number is wrong and quietly so. */
function checkTrail(s, r, walk) {
  const off = r.loafX.split(",").filter((v) => v !== "").map(Number);
  const abs = r.loafAbs.split(",").filter((v) => v !== "").map(Number);
  assert.ok(abs.length >= 3,
    "precondition: the walk has to bake at least three loaves to have a " +
    "spacing at all; it baked " + abs.length);
  for (const x of off) {
    assert.ok(x < 0,
      "every loaf lands BEHIND him -- he was walking right, so each one " +
      "belongs at a negative offset from where he was standing when it " +
      "dropped; the offsets were " + r.loafX);
  }
  const spacing = [];
  for (let i = 1; i < abs.length; i++) spacing.push(+(abs[i] - abs[i - 1]).toFixed(2));
  const want = s.every * walk - 7;
  for (const g of spacing) {
    assert.ok(g > 20,
      "and they are spread across the floor rather than stacked at his " +
      "feet; consecutive loaves landed " + spacing.join(", ") + " apart");
    assert.ok(Math.abs(g - want) < 3,
      "about `every` x his walk less the seven the drop point grows by (" +
      want.toFixed(1) + " px); they came " + spacing.join(", ") + " apart");
  }
}

test("the bread trails him", async () => {
  const run = await arena(SQUALLS, REESE);
  const s = spec(run);
  const walk = JSON.parse(run("ROSTER.squalls.walk"));
  /* A hundred charge frames rather than the full hundred and fifty: at his
     walk the full hold carries him two hundred pixels, which is off the end
     of the floor, and a man falling off the world is a real thing this move
     does and useless for measuring a spacing. */
  checkTrail(s, daydream(run, 100, RIGHT), walk);
});

test("negative control: a daydream that pins him still fails the trail test", async () => {
  /* `charge.walk` off, which is exactly the move as it was before this pass:
     a man nailed to the floor. Nothing else changes -- same length, same
     meter, same five loaves -- except that the bread lands in a heap seven
     pixels apart instead of across the stage, which is what the walk is
     worth and the only thing this test is about. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      charge: { hold: 150, walk: true, drain: 0.6 },",
    "      charge: { hold: 150, walk: false, drain: 0.6 },") });
  const s = spec(run);
  const walk = JSON.parse(run("ROSTER.squalls.walk"));
  expectToFail(() => checkTrail(s, daydream(run, 100, RIGHT), walk),
    "a rooted baker should fail the trail test; it passed");
});

/* =====================================================================
   5. HE DOES NOT EAT BREAD HE CANNOT USE
   ===================================================================== */

/* A loaf used to be consumed by whoever walked over it whether or not it
   healed them, so a full bar ate the thing and threw all thirteen away.
   31.7% of live casts are made at 88 health or better, so this is not a
   corner case -- it is a third of them. */
const fullHealth = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.health = 100;
  var s = me.specialsNow.down;
  var until = s.startup + 40;
  netplay.active = true;
  for (var i = 0; i < 260; i++) {
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_DOWN}
                                 : i < until ? ${HOLD_DOWN} : 0), bitsToPad(0)];
    me.hitstop = 0;
    step();
    /* Stand him ON his own loaf, once he is free to be standing anywhere.
       Full health the whole way, which is the case being measured. */
    me.health = 100;
    var L = projectiles.filter(function (q) {
      return q.constructor.name === 'Loaf' && !q.dead;
    });
    if (L.length && i > until) { me.x = L[0].x; me.y = L[0].y; me.vx = 0; me.vy = 0; }
  }
  var live = projectiles.filter(function (q) {
    return q.constructor.name === 'Loaf' && !q.dead;
  });
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ left: live.length, health: +me.health.toFixed(2) });
})()`));

function checkNotHungry(r) {
  assert.ok(r.left > 0,
    "a man at full health should walk over his own bread and leave it there; " +
    r.left + " loaves survived him standing on them");
}

test("he does not eat bread he cannot use", async () => {
  const run = await arena(SQUALLS, REESE);
  checkNotHungry(fullHealth(run));
});

test("negative control: a loaf eaten whether or not it heals fails the full-health test", async () => {
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      if (f.health >= COMBAT.maxHealth) continue;",
    "      if (false) continue;") });
  expectToFail(() => checkNotHungry(fullHealth(run)),
    "bread eaten at a hundred health should fail the full-health test; it passed");
});

/* =====================================================================
   6. NOTHING BUT THE SPECIAL'S OWN BUTTON ENDS IT
   ===================================================================== */

/* THE TEST THIS REWORK EXISTS FOR, and the one nobody had.
   The wake flag is gone entirely. Every other button on the pad is held down
   on every frame of the hold and the daydream is required to be untouched --
   same dream, same bread, same length. */
function checkOnlyItsOwnButton(clean, swept) {
  for (const s of swept) {
    assert.equal(s.r.held, clean.held,
      "holding " + s.name + " through the daydream must not shorten it; " +
      "it ran " + s.r.held + " charge frames against " + clean.held);
    assert.ok(Math.abs(s.r.dream - clean.dream) < 1e-6,
      "nor change what it banks; with " + s.name + " down it banked " +
      s.r.dream + " against " + clean.dream);
    assert.equal(s.r.loaves, clean.loaves,
      "nor how much bread it leaves; with " + s.name + " down it baked " +
      s.r.loaves + " against " + clean.loaves);
  }
}

const SWEEP = [
  { name: "jump", bits: JUMP },
  { name: "attack", bits: ATTACK },
  { name: "grab", bits: GRAB },
  { name: "shield", bits: SHIELD },
  { name: "the neutral special", bits: SP_NEUTRAL },
  { name: "the up special", bits: SP_UP },
];

test("nothing but the special's own button ends the daydream", async () => {
  const run = await arena(SQUALLS, REESE);
  const clean = daydream(run, 150);
  assert.ok(clean.loaves > 0 && clean.held > 0,
    "precondition: the clean hold has to run at all");
  checkOnlyItsOwnButton(clean,
    SWEEP.map((b) => ({ name: b.name, r: daydream(run, 150, b.bits) })));
});

test("negative control: a daydream four other buttons can end fails the sweep", async () => {
  /* The wake trap in its 2.81 shape: the same four buttons, reaching the same
     pin, with everything else about the move left alone. It does not need the
     old sticky flag to do its damage -- one frame of any of them and the
     charge unpins, the move runs out, and the player is given no evidence
     that anything happened. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "        pad && pad[HOLD_FOR_SLOT[this.chargeKey] || 'holdNeutral'] &&",
    "        pad && pad[HOLD_FOR_SLOT[this.chargeKey] || 'holdNeutral'] &&\n" +
    "        !(pad.jump || pad.attack || pad.shield || pad.grab) &&") });
  const clean = daydream(run, 150);
  expectToFail(() => checkOnlyItsOwnButton(clean,
    SWEEP.map((b) => ({ name: b.name, r: daydream(run, 150, b.bits) }))),
    "a daydream jump and attack can end should fail the sweep; it passed");
});

/* =====================================================================
   7. ONE FULL DAYDREAM IS ONE FULL BAR
   ===================================================================== */

/* Two caps that land on the same frame, and the arithmetic is written in two
   places so neither can be retuned alone: `manaOverride` up front plus
   `charge.drain` a frame for `charge.hold` frames is exactly COMBAT.manaMax.
   Mana does not regenerate inside a special -- the refill is in updateFree
   and a fighter in a move never gets there -- so the drain is not slowing a
   rising bar, it is emptying a flat one. */
function checkOneBar(s, max, r) {
  assert.equal(s.mana + s.charge.drain * s.charge.hold, max,
    "the cast price plus the whole drain should be exactly one bar (" + max +
    "); it is " + (s.mana + s.charge.drain * s.charge.hold));
  assert.ok(r.manaAtCap !== null,
    "precondition: the hold has to reach the cap at all");
  assert.ok(Math.abs(r.manaAtCap) < 1e-9,
    "and the bar should be empty on the frame the hold cap is reached, not " +
    "before it and not after; it read " + r.manaAtCap);
  assert.equal(r.held, s.charge.hold,
    "with the counter on the cap at the same moment; it read " + r.held);
}

test("one full daydream is one full mana bar, to the frame", async () => {
  const run = await arena(SQUALLS, REESE);
  const s = spec(run);
  const max = JSON.parse(run("COMBAT.manaMax"));
  checkOneBar(s, max, daydream(run, s.charge.hold));
});

test("negative control: a cheaper drain fails the one-bar test", async () => {
  /* Half the drain and nothing else, which is the shape of every "make it a
     bit more castable" tune: the two caps come apart, the pin outlives the
     bar by seventy-five frames, and the move stops being priced by anything. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      charge: { hold: 150, walk: true, drain: 0.6 },",
    "      charge: { hold: 150, walk: true, drain: 0.3 },") });
  const s = spec(run);
  const max = JSON.parse(run("COMBAT.manaMax"));
  expectToFail(() => checkOneBar(s, max, daydream(run, s.charge.hold)),
    "a drain that does not empty the bar should fail the one-bar test; it passed");
});
