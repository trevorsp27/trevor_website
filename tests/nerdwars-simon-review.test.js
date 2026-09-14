/* Simon's 2.53 kit, after the review: four confirmed defects, fixed in 2.54.
 *
 * Simon arrived in 2.53 with a hotdog that splits, a slot machine, a choke
 * and a five-second nap, and an adversarial read of the engine found four
 * things wrong with them, each of them the kind that plays fine for a while
 * and then costs somebody a stock they did not owe:
 *
 *   1. Both of the new radial hits -- the JACKPOT ring off three sevens and
 *      the wake ring at the end of the slouch -- called applyHit on anybody
 *      in range, skipping only Simon himself and the eliminated. resolveCombat
 *      skips two more for every other hit in the game: a fighter in KO flight
 *      and a fighter in his i-frames. Without those, a foe who had just been
 *      KO'd beside him was flipped from 'ko' to 'hitstun' by the hit, and
 *      knockOut, no longer seeing 'ko', took a SECOND stock off one death --
 *      and credited Simon ult meter for hitting a corpse.
 *   2. The slouch could be cast in the air. Nothing gated the ult on
 *      `grounded`, and the sleep zeroed vx in runSpecial only for the
 *      generic air-drift branch to add stick input straight back on top: a
 *      fully invulnerable Simon steering through the sky for five seconds,
 *      healing on the way down, until the blast zone took the stock with the
 *      meter already spent.
 *   3. Sleepers were pinned by writing the whole remaining sleep into
 *      hitstun once. If the sleep ended early -- a poison tick, the blast
 *      zone -- runSpecial stopped and everybody he had put down stood there
 *      in hitstun for the rest of the five seconds with no aura around them.
 *   4. The hotdog's second press, the one that splits it, was heard in
 *      exactly two places: free state with no landLag, and the throw's own
 *      recovery. A whole one flies for 220 frames and Simon spends most of
 *      that jabbing, blocking or spinning reels, and a press in any of those
 *      was silently eaten.
 *
 * The fixes are a guard line in each ring, `groundOnly` on the ult with the
 * slouch named in `rooted`, a two-frame pin re-asserted every frame, and a
 * splitHotdogs() call at the top of Fighter.update. Each is small, which is
 * exactly why each needs a test: every one of them is a line somebody could
 * tidy away without a single other test noticing.
 *
 * Every test here therefore comes with a NEGATIVE CONTROL: the same probe and
 * the same assertions run against an in-memory copy of the engine with that
 * one line undone, and the control passes only if the assertions THROW. A
 * test that still passes with its guard removed is not guarding anything.
 * The sabotage never touches disk -- bootEngine takes the source as a
 * string -- and each anchor must match exactly once, so a refactor that moves
 * the line fails loudly here rather than leaving a control that tests
 * nothing.
 *
 * These load the engine source, as nerdwars-kel-buff.test.js does: payout(),
 * knockOut(), the reels, the projectile classes and freezeFrames are all
 * internals. Inputs go through netplay.framePads so the other seat gets an
 * empty pad rather than a CPU with ideas of its own.
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
const LADDER_SRC = readFileSync(path.join(JS_DIR, "ladder.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");
const ENGINE_SRC = readFileSync(ENGINE_PATH, "utf8");

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

/* The one departure from the harness the other files carry: the engine
   source is a parameter, defaulting to the file, so a negative control can
   boot a sabotaged copy that exists only as a string. */
async function bootEngine(source = ENGINE_SRC) {
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
  vm.runInContext(source, sandbox, { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

const tapKey = (run, code) => run(`(function () {
  held.clear(); prevHeld.clear(); held.add(${JSON.stringify(code)});
  step();
  held.clear(); prevHeld.clear();
  return scene;
})()`);

/* The engine with exactly one line undone. The anchor has to occur exactly
   once: zero means the line moved and the control is anchored to nothing,
   two means the replacement might land on the wrong ring. Anchors are
   written with "\n"; the source is normalized first so a checkout that
   turned the file CRLF reads as the same engine, not as a missing guard. */
function sabotaged(from, to) {
  const src = ENGINE_SRC.replace(/\r\n/g, "\n");
  const at = src.indexOf(from);
  assert.notEqual(at, -1,
    "negative control: the engine no longer contains " + JSON.stringify(from) +
    " -- re-anchor this control to wherever that guard went");
  assert.equal(src.indexOf(from, at + 1), -1,
    "negative control: " + JSON.stringify(from) + " occurs more than once");
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/* ------------------------------------------------------------------ */

const RIGHT = 2, ATTACK = 32, SHIELD = 128, ULT = 256, SP_NEUTRAL = 512, SP_DOWN = 1024;

/* Simon in seat 0, Reese in seat 1, on the open arena. No warmup frames: the
   probes reset both fighters by hand and never let a CPU touch a pad. */
async function simonVsReese(source) {
  const run = await bootEngine(source);
  run("select.cursor=[7,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  assert.equal(run("fighters.map(function (f) { return f.key; }).join(',')"),
    "simon,reese", "precondition: ORDER should seat Simon at 7 and Reese at 4");
  return run;
}

/* Both of them clean and standing on the floor, Simon on the left facing in
   and Reese far across the stage, stocks at 99 so a KO is a stock and not an
   elimination. Simon's own machinery -- reels, the split flag, the meter --
   is cleared too, so one probe cannot leave a lever pulled for the next. */
const RESET = `
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var u = ROSTER.simon.ult;
    projectiles.length = 0; effects.length = 0;
    freezeFrames = 0;
    [me, foe].forEach(function (f) {
      f.setState('idle');
      f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
      f.invuln = 0; f.mana = 999; f.vx = 0; f.vy = 0;
      f.grabbing = -1; f.grabbedBy = -1; f.grounded = true;
      f.specialSpawned = false; f.hasHit = false; f.attackFrame = 0;
      f.stocks = 99; f.health = 100; f.combo = 0; f.sinceHitFrames = 999;
      f.poison = 0; f.burn = 0; f.confused = 0; f.drowsy = 0;
      f.swordTimer = 0; f.ultMeter = 0;
      f.reels = [-1, -1, -1]; f.reelStops = 0; f.hotdogSplit = false;
      f.y = main.y;
    });
    me.x = main.x + 40; me.facing = 1;
    foe.x = main.x + main.w - 30; foe.facing = -1;`;

/* ------------------------------------------------------------------ */
/* 1. The JACKPOT ring.                                                 */

/* Three sevens, paid deterministically: the reels are set by hand and
   payout() is called with the SLOTS spec, which is the frame the ring goes
   off. Three foes in turn at the same twenty pixels -- a corpse in KO
   flight, a man in his i-frames, and a plain one to prove the ring reaches
   that spot at all. */
const JACKPOT = `(function () {
  ${RESET}
  var s = ROSTER.simon.specials.down;
  function ring() { me.reels = [0, 0, 0]; me.payout(s); }
  function beside() { foe.x = me.x + 20; foe.y = me.y; foe.vx = 0; foe.vy = 0; }

  beside();
  foe.knockOut();
  var paid = foe.stocks, meter = me.ultMeter;
  beside();
  ring();
  var corpse = { paid: paid, stocks: foe.stocks, state: foe.state,
                 health: foe.health, meterGained: me.ultMeter - meter };

  ${RESET}
  beside(); foe.invuln = 50;
  var wasInvulnerable = foe.invulnerable;
  ring();
  var iframes = { invulnerable: wasInvulnerable, health: foe.health,
                  state: foe.state, stocks: foe.stocks };

  ${RESET}
  beside();
  ring();
  var plain = { health: foe.health, state: foe.state,
                radius: s.jackpot.radius, damage: s.jackpot.damage };
  return { corpse: corpse, iframes: iframes, plain: plain };
})()`;

function checkJackpot(r) {
  assert.equal(r.plain.health, 100 - r.plain.damage,
    "precondition: the ring (radius " + r.plain.radius + ") should reach a plain " +
    "foe 20px away for " + r.plain.damage + "; his health is " + r.plain.health);
  assert.equal(r.corpse.paid, 98, "precondition: the KO itself should have cost one stock");
  assert.equal(r.corpse.stocks, r.corpse.paid,
    "no second stock off a corpse: the foe was already in KO flight and the " +
    "jackpot took his stocks from " + r.corpse.paid + " to " + r.corpse.stocks);
  assert.equal(r.corpse.state, "ko", "and he should still be in KO flight, not " + r.corpse.state);
  assert.equal(r.corpse.meterGained, 0,
    "and Simon must not be credited meter for hitting a corpse; he gained " + r.corpse.meterGained);
  assert.equal(r.iframes.invulnerable, true, "precondition: invuln 50 should read as invulnerable");
  assert.equal(r.iframes.health, 100,
    "no hit through i-frames: a foe with invuln 50 lost " + (100 - r.iframes.health) +
    " health to the jackpot");
  assert.equal(r.iframes.state, "idle", "and he should be left standing, not in " + r.iframes.state);
}

const JACKPOT_GUARD = [
  "             'ko', takes a second one. */\n" +
  "          if (other.state === 'ko' || other.invulnerable) continue;\n",
  "             'ko', takes a second one. */\n",
];

test("the jackpot ring skips a corpse and a man in his i-frames", async () => {
  const run = await simonVsReese();
  checkJackpot(run(JACKPOT));
});

test("control: without its guard the jackpot takes a second stock and hits through i-frames", async (t) => {
  const run = await simonVsReese(sabotaged(...JACKPOT_GUARD));
  const r = run(JACKPOT);
  t.diagnostic("sabotaged jackpot read corpse.stocks=" + r.corpse.stocks +
    " (paid " + r.corpse.paid + "), corpse.meterGained=" + r.corpse.meterGained +
    ", iframes.health=" + r.iframes.health);
  assert.equal(r.corpse.stocks, r.corpse.paid - 1, "the sabotage should cost the corpse a second stock");
  assert.equal(r.iframes.health, 100 - r.plain.damage, "and hit straight through the i-frames");
  assert.throws(() => checkJackpot(r), /no second stock off a corpse/);
});

/* ------------------------------------------------------------------ */
/* 2. The wake ring.                                                    */

/* The whole slouch, driven through the pad: ULT on frame 0, 24 frames of
   nodding off, TEN SECONDS asleep, and the stretch on attackFrame
   startup+active. The foe stands twenty pixels away, dozes off in the aura,
   and on the frame BEFORE the stretch is made into whichever thing the ring
   must skip. The twelve-frame KO freeze is pinned to 0 so the frame count is
   the fighters' own.

   700 frames, not 400. The sleep doubled and a drive that stopped at 400
   never reached the wake frame at all, which showed up as the precondition
   failing rather than as a recording that ran out. */
const WAKE = (mode) => `(function () {
  ${RESET}
  foe.x = me.x + 20; foe.y = me.y;
  me.ultMeter = 999;
  var WAKE_AT = u.startup + u.active;
  var r = { fired: false, dozedAt: -1, armedAt: -1, paid: -1, healthArmed: -1,
            meterArmed: -1, invulnerable: false, wakeAt: -1, stocks: -1,
            state: '', health: -1, meter: -1, radius: u.wake.radius, damage: u.wake.damage };
  netplay.active = true;
  for (var i = 0; i < 700; i++) {
    if (me.state === 'ult' && me.attackFrame === WAKE_AT - 1) {
      if (${JSON.stringify(mode)} === 'ko') foe.knockOut();
      if (${JSON.stringify(mode)} === 'invuln') foe.invuln = 50;
      r.armedAt = i; r.paid = foe.stocks; r.healthArmed = foe.health;
      r.meterArmed = me.ultMeter; r.invulnerable = foe.invulnerable;
    }
    // After the KO above, which sets the freeze this pins away.
    me.hitstop = 0; me.mana = 999; freezeFrames = 0;
    netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    if (me.state === 'ult') r.fired = true;
    if (r.dozedAt < 0 && foe.state === 'hitstun') r.dozedAt = i;
    if (me.state === 'ult' && me.attackFrame === WAKE_AT) {
      r.wakeAt = i; r.stocks = foe.stocks; r.state = foe.state;
      r.health = foe.health; r.meter = me.ultMeter;
      break;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return r;
})()`;

function checkWakeReaches(plain) {
  assert.ok(plain.fired && plain.wakeAt > 0, "precondition: the slouch should run to its wake frame");
  assert.ok(plain.dozedAt > 0 && plain.dozedAt < plain.wakeAt,
    "precondition: the foe should have dozed off in the aura before the wake");
  assert.equal(plain.health, 100 - plain.damage,
    "precondition: the wake ring (radius " + plain.radius + ") should reach a sleeping foe " +
    "20px away for " + plain.damage + "; his health is " + plain.health);
}

/* `armedAt` is written before the step and `wakeAt` after the same step, so
   the two agree when the KO (or the i-frames) went in just ahead of the ring. */
function checkWakeSparesCorpse(r) {
  assert.ok(r.wakeAt > 0 && r.armedAt === r.wakeAt,
    "precondition: the KO should go in on the step that wakes him; armed " + r.armedAt + ", woke " + r.wakeAt);
  assert.equal(r.paid, 98, "precondition: the KO itself should have cost one stock");
  assert.equal(r.stocks, r.paid,
    "no second stock off a corpse: the foe was in KO flight when Simon stretched, " +
    "and the wake ring took his stocks from " + r.paid + " to " + r.stocks);
  assert.equal(r.state, "ko", "and he should still be in KO flight, not " + r.state);
  assert.equal(r.meter, r.meterArmed,
    "and Simon must not be credited meter for it; the meter went " + r.meterArmed + " -> " + r.meter);
}

function checkWakeSparesInvuln(r) {
  assert.ok(r.wakeAt > 0 && r.armedAt === r.wakeAt,
    "precondition: the i-frames should go in on the step that wakes him; armed " + r.armedAt + ", woke " + r.wakeAt);
  assert.equal(r.invulnerable, true, "precondition: invuln 50 should read as invulnerable");
  assert.equal(r.health, r.healthArmed,
    "no hit through i-frames: a foe with invuln 50 lost " + (r.healthArmed - r.health) +
    " health to the wake ring");
  assert.equal(r.stocks, r.paid, "and kept his stocks");
}

const WAKE_GUARD = [
  "            // through i-frames.\n" +
  "            if (other.state === 'ko' || other.invulnerable) continue;\n",
  "            // through i-frames.\n",
];

test("the wake ring skips a corpse and a man in his i-frames", async () => {
  const run = await simonVsReese();
  checkWakeReaches(run(WAKE("plain")));
  checkWakeSparesCorpse(run(WAKE("ko")));
  checkWakeSparesInvuln(run(WAKE("invuln")));
});

test("control: without its guard the wake ring takes a second stock and hits through i-frames", async (t) => {
  const run = await simonVsReese(sabotaged(...WAKE_GUARD));
  checkWakeReaches(run(WAKE("plain")));
  const ko = run(WAKE("ko"));
  const inv = run(WAKE("invuln"));
  t.diagnostic("sabotaged wake read ko.stocks=" + ko.stocks + " (paid " + ko.paid + "), ko.meter " +
    ko.meterArmed + "->" + ko.meter + ", invuln.health=" + inv.health);
  assert.equal(ko.stocks, ko.paid - 1, "the sabotage should cost the corpse a second stock");
  assert.equal(inv.health, inv.healthArmed - inv.damage, "and hit straight through the i-frames");
  assert.throws(() => checkWakeSparesCorpse(ko), /no second stock off a corpse/);
  assert.throws(() => checkWakeSparesInvuln(inv), /no hit through i-frames/);
});

/* ------------------------------------------------------------------ */
/* 3. The slouch is grounded-only.                                      */

/* ULT on frame 0 with exactly a full meter, once from sixty pixels up and
   once from the floor, then thirty frames of nothing -- long enough for the
   airborne Simon to land, so a press that was merely QUEUED for the landing
   would show up too. Sixty rather than forty: forty up from the floor is
   exactly the height of the side platform under his x, and he would be
   standing on it before the press was read. */
const CAST = (airborne) => `(function () {
  ${RESET}
  me.ultMeter = COMBAT.ultMax;
  if (${airborne}) { me.y = main.y - 60; me.grounded = false; me.vy = 0; me.setState('air'); }
  var r = { groundedAtPress: me.grounded, everUlt: false, ultAt: -1, landedAt: -1,
            meter: -1, state: '', full: COMBAT.ultMax };
  netplay.active = true;
  for (var i = 0; i < 30; i++) {
    me.hitstop = 0; me.mana = 999;
    netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    if (me.state === 'ult') { r.everUlt = true; if (r.ultAt < 0) r.ultAt = i; }
    if (r.landedAt < 0 && me.grounded) r.landedAt = i;
  }
  netplay.active = false; netplay.framePads = null;
  r.meter = me.ultMeter; r.state = me.state;
  return r;
})()`;

function checkGroundedOnly(air, ground) {
  assert.equal(air.groundedAtPress, false, "precondition: the first press should be made in the air");
  assert.ok(air.landedAt > 0,
    "precondition: he should still have been airborne on the press frame and landed later; " +
    "landedAt " + air.landedAt);
  assert.equal(air.everUlt, false,
    "an airborne slouch must not cast: Simon went into 'ult' on frame " + air.ultAt +
    " from a press made in the air");
  assert.equal(air.meter, air.full,
    "and the press must not spend the meter; it read " + air.meter + " of " + air.full);
  assert.equal(ground.groundedAtPress, true, "precondition: the second press should be made on the floor");
  assert.equal(ground.everUlt, true, "the same press on the ground should cast; state was " + ground.state);
  assert.equal(ground.ultAt, 0, "on the frame of the press");
  assert.equal(ground.meter, 0, "and spend the whole meter; it read " + ground.meter);
}

const GROUND_ONLY_FLAG = ["    groundOnly: true,\n", "    groundOnly: false,\n"];
const GROUND_ONLY_GATE = [
  "          (this.grounded || !this.def.ult.groundOnly)) {\n",
  "          true) {\n",
];

test("the slouch is grounded-only: the press is dropped in the air and cast on the floor", async () => {
  const run = await simonVsReese();
  checkGroundedOnly(run(CAST(true)), run(CAST(false)));
});

test("control: with groundOnly off, or the cast's grounded gate gone, an airborne press casts", async (t) => {
  for (const [name, edit] of [["flag", GROUND_ONLY_FLAG], ["gate", GROUND_ONLY_GATE]]) {
    const run = await simonVsReese(sabotaged(...edit));
    const air = run(CAST(true)), ground = run(CAST(false));
    t.diagnostic("sabotaged " + name + " read air.everUlt=" + air.everUlt + " at frame " + air.ultAt +
      ", air.meter=" + air.meter);
    assert.equal(air.everUlt, true, "the sabotage (" + name + ") should let the airborne press cast");
    assert.throws(() => checkGroundedOnly(air, ground), /an airborne slouch must not cast/);
  }
});

/* ------------------------------------------------------------------ */
/* 4. No sliding, no steering.                                          */

/* Twelve frames of walking right, then ULT with RIGHT still held for the
   whole move. The press frame itself never moves him -- updateFree returns
   at startAttack before move() -- so his x on that frame is the mark, and it
   must not change through startup, sleep or recovery. For frames 100-199 of
   the move the floor is taken away: he is held in the air each frame rather
   than dropped from a height, so he cannot land and cut the airborne stretch
   short. RIGHT is still held, and he must not steer. */
const ROOTED = `(function () {
  ${RESET}
  me.ultMeter = 999;
  var r = { walk: ROSTER.simon.walk, wake: u.startup + u.active,
            walkVx: 0, x0: 0, fired: false, lastFrame: 0,
            endState: '', groundDx: 0, groundVx: 0, airFrames: 0, airMaxDx: 0, airMaxVx: 0,
            maxDx: 0, maxVx: 0 };
  netplay.active = true;
  for (var i = 0; i < 12; i++) {
    me.hitstop = 0; me.mana = 999;
    netplay.framePads = [bitsToPad(${RIGHT}), bitsToPad(0)];
    step();
  }
  r.walkVx = me.vx; r.x0 = me.x;
  for (var i = 0; i < 700; i++) {
    me.hitstop = 0; me.mana = 999;
    var airborne = me.state === 'ult' && me.attackFrame >= 100 && me.attackFrame < 200;
    if (airborne) { me.y = main.y - 50; me.vy = 0; me.grounded = false; }
    netplay.framePads = [bitsToPad(${RIGHT} | (i === 0 ? ${ULT} : 0)), bitsToPad(0)];
    step();
    if (me.state !== 'ult') { r.endState = me.state; break; }
    r.fired = true; r.lastFrame = me.attackFrame;
    var dx = Math.abs(me.x - r.x0), vx = Math.abs(me.vx);
    if (dx > r.maxDx) r.maxDx = dx;
    // attackFrame 0 is the press frame: startAttack's own damping leaves a
    // remnant there, and nothing reads it before the first slouch frame zeroes it.
    if (me.attackFrame >= 1 && vx > r.maxVx) r.maxVx = vx;
    // Sliding is measured on the floor before it goes; steering while it is gone.
    if (me.attackFrame >= 1 && me.attackFrame < 100) {
      if (dx > r.groundDx) r.groundDx = dx;
      if (vx > r.groundVx) r.groundVx = vx;
    }
    if (airborne) {
      r.airFrames++;
      if (dx > r.airMaxDx) r.airMaxDx = dx;
      if (vx > r.airMaxVx) r.airMaxVx = vx;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return r;
})()`;

function checkRooted(r) {
  assert.ok(Math.abs(r.walkVx - r.walk) < 1e-9,
    "precondition: he should be walking at full speed (" + r.walk + ") when he presses; vx was " + r.walkVx);
  assert.ok(r.fired, "precondition: the slouch should have fired");
  assert.equal(r.groundVx, 0,
    "no sliding: from the first frame of the slouch vx must be 0, but reached " + r.groundVx);
  assert.equal(r.groundDx, 0,
    "no sliding: his x must not change through the startup and into the sleep, but moved " +
    r.groundDx.toFixed(3) + "px");
  assert.ok(r.airFrames >= 90, "precondition: he should have spent the airborne stretch in the air; " + r.airFrames + " frames");
  assert.equal(r.airMaxVx, 0,
    "no steering: with the floor gone and RIGHT held vx must stay 0, but reached " + r.airMaxVx);
  assert.equal(r.airMaxDx, 0,
    "no steering: he must fall straight, but drifted " + r.airMaxDx.toFixed(3) + "px");
  assert.ok(r.maxVx === 0 && r.maxDx === 0,
    "nor at any other point in the move: vx reached " + r.maxVx + ", x moved " + r.maxDx.toFixed(3) + "px");
  /* Read off the spec rather than written down. The sleep went from five
     seconds to ten, and a hard-coded 324 in here would have gone on passing
     against a drive that stopped halfway through the nap. */
  assert.ok(r.lastFrame >= r.wake && r.endState === "idle",
    "precondition: the whole move should have run past its wake frame (" + r.wake +
    "); it ended on attackFrame " + r.lastFrame + " in state " + r.endState);
}

const SLOUCH_VX = [
  "        // reason, so the air-drift branch never touches him either.\n" +
  "        this.vx = 0;\n",
  "        // reason, so the air-drift branch never touches him either.\n",
];
const SLOUCH_ROOTED = [
  "       m.kind === 'knightmove' || m.kind === 'slouch');\n",
  "       m.kind === 'knightmove');\n",
];

test("the slouch neither slides into the sleep nor steers through it", async () => {
  const run = await simonVsReese();
  checkRooted(run(ROOTED));
});

test("control: without the case's vx = 0 he slides; without slouch in `rooted` he steers", async (t) => {
  const slide = (await simonVsReese(sabotaged(...SLOUCH_VX)))(ROOTED);
  t.diagnostic("sabotaged vx=0 read groundVx=" + slide.groundVx.toFixed(3) + ", groundDx=" +
    slide.groundDx.toFixed(3) + ", whole-move maxDx=" + slide.maxDx.toFixed(3));
  assert.ok(slide.groundVx > 0.1 && slide.groundDx > 1, "the sabotage should have him sliding on the floor");
  assert.throws(() => checkRooted(slide), /no sliding/);

  const steer = (await simonVsReese(sabotaged(...SLOUCH_ROOTED)))(ROOTED);
  t.diagnostic("sabotaged rooted read groundDx=" + steer.groundDx.toFixed(3) + ", airMaxVx=" +
    steer.airMaxVx.toFixed(3) + ", airMaxDx=" + steer.airMaxDx.toFixed(3));
  assert.equal(steer.groundDx, 0, "this sabotage leaves the floor alone -- the case still zeroes vx there");
  assert.ok(steer.airMaxVx > 0 && steer.airMaxDx > 1, "but has him steering once the floor is gone");
  assert.throws(() => checkRooted(steer), /no steering/);
});

/* ------------------------------------------------------------------ */
/* 5. Sleepers wake when the sleep ends early.                          */

/* The foe twenty pixels away dozes off in the aura. With koAt >= 0, Simon is
   knocked out by hand on that frame of the drive and the foe has ten frames
   to be standing again; with koAt < 0 the sleep runs to term and the foe has
   to still be under on the frame the ring goes off. Throughout the sleep the
   foe's hitstun is read after every step: the pin is two frames re-asserted
   every frame, so it must never read more than a handful. */
const SLEEPERS = (koAt) => `(function () {
  ${RESET}
  foe.x = me.x + 20; foe.y = me.y;
  me.ultMeter = 999;
  var WAKE_AT = u.startup + u.active;
  var r = { fired: false, doze: u.aura.doze, dozedAt: -1, drowsyAtDoze: -1, maxStun: 0,
            lapses: 0, koState: '', wokeAt: -1, endState: '', endHitstun: -1,
            beforeWake: null, wake: null, wakeDamage: u.wake.damage };
  netplay.active = true;
  for (var i = 0; i < 700; i++) {
    if (i === ${koAt}) { me.knockOut(); r.koState = me.state; }
    // After the KO above, which sets the freeze this pins away.
    me.hitstop = 0; me.mana = 999; freezeFrames = 0;
    var hp = foe.health;
    netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    if (me.state === 'ult') r.fired = true;
    var sleeping = me.state === 'ult' && me.attackFrame >= u.startup && me.attackFrame < WAKE_AT;
    if (${koAt} < 0 || i < ${koAt}) {
      if (sleeping) {
        if (foe.state === 'hitstun') {
          if (r.dozedAt < 0) { r.dozedAt = i; r.drowsyAtDoze = foe.drowsy; }
          if (foe.hitstun > r.maxStun) r.maxStun = foe.hitstun;
        } else if (r.dozedAt >= 0) r.lapses++;
      }
      if (me.state === 'ult' && me.attackFrame === WAKE_AT - 1) {
        r.beforeWake = { state: foe.state, hitstun: foe.hitstun };
      }
      if (me.state === 'ult' && me.attackFrame === WAKE_AT) {
        r.wake = { lost: hp - foe.health, state: foe.state };
        break;
      }
    } else {
      if (r.wokeAt < 0 && foe.state !== 'hitstun') r.wokeAt = i;
      if (i >= ${koAt} + 10) break;
    }
  }
  netplay.active = false; netplay.framePads = null;
  r.endState = foe.state; r.endHitstun = foe.hitstun;
  return r;
})()`;

const KO_AT = 150;

function checkSleepers(cut, term) {
  assert.ok(cut.fired, "precondition: the slouch should have fired");
  assert.ok(cut.dozedAt > 0 && cut.dozedAt <= 120,
    "the foe standing 20px away should have dozed off by frame 120; he went under on " + cut.dozedAt);
  // Read after the foe's own tick, which took one off the aura's +2.
  assert.ok(cut.drowsyAtDoze >= cut.doze - 1,
    "and be fully drowsy when he did (" + cut.doze + "); drowsy was " + cut.drowsyAtDoze);
  assert.ok(cut.maxStun <= 3,
    "the pin is per-frame now: a sleeper's hitstun must never read more than 3, but read " + cut.maxStun);
  assert.equal(cut.lapses, 0, "and he must not surface mid-sleep; he was out of hitstun on " + cut.lapses + " frames");
  assert.equal(cut.koState, "ko", "precondition: Simon should have been knocked out on frame " + KO_AT);
  assert.ok(cut.wokeAt >= KO_AT && cut.wokeAt <= KO_AT + 10,
    "sleepers wake when the sleep ends early: Simon was KO'd on frame " + KO_AT +
    " and the foe was still in hitstun ten frames later (hitstun " + cut.endHitstun + ")");
  assert.equal(cut.endState, "idle", "and should be standing, not in " + cut.endState);

  assert.ok(term.wake, "precondition: the uncut sleep should reach its wake frame");
  assert.ok(term.beforeWake && term.beforeWake.state === "hitstun" && term.beforeWake.hitstun >= 1,
    "run to term, the foe should still be under on the wake frame; the frame before it he was in " +
    (term.beforeWake && term.beforeWake.state) + " with hitstun " + (term.beforeWake && term.beforeWake.hitstun));
  assert.equal(term.wake.lost, term.wakeDamage,
    "and the stretch should land on him for " + term.wakeDamage + "; it took " + term.wake.lost);
  assert.ok(term.maxStun <= 3, "the per-frame pin holds for the whole sleep too; hitstun read " + term.maxStun);
  assert.equal(term.lapses, 0, "with no lapses; he was out of hitstun on " + term.lapses + " frames");
}

const SLEEP_PIN = [
  "              other.hitstun = Math.max(other.hitstun, 2);\n",
  "              other.hitstun = Math.max(other.hitstun, 300);\n",
];

test("sleepers wake when the sleep ends early, and stay under when it does not", async () => {
  const run = await simonVsReese();
  checkSleepers(run(SLEEPERS(KO_AT)), run(SLEEPERS(-1)));
});

test("control: a pin written for the whole sleep keeps them under after his KO", async (t) => {
  const run = await simonVsReese(sabotaged(...SLEEP_PIN));
  const cut = run(SLEEPERS(KO_AT)), term = run(SLEEPERS(-1));
  t.diagnostic("sabotaged pin read maxStun=" + cut.maxStun + ", wokeAt=" + cut.wokeAt +
    ", endState=" + cut.endState + ", endHitstun=" + cut.endHitstun);
  assert.ok(cut.maxStun > 100, "the sabotage should pin hitstun far above 3");
  assert.equal(cut.wokeAt, -1, "and leave the foe in hitstun after Simon's KO");
  assert.throws(() => checkSleepers(cut, term), /pin is per-frame now/);
});

/* ------------------------------------------------------------------ */
/* 6. The split is heard in every state.                                */

/* A whole hotdog thrown on frame 0 flies right; the foe is 170px away and
   the dog does not reach him inside the window. `padAt` puts Simon into the
   state under test, and on `pressAt` SP_NEUTRAL is added to whatever that
   pad holds. Mana is pinned every frame EXCEPT the press frame, so a press
   that also threw would show as 22 mana gone. The census after the press is
   what the split must leave: no whole, one top, one falling bottom bun. */
const SPLIT = (padAt, pressAt, tail) => `(function () {
  function alive(pred) { return projectiles.filter(function (b) { return !b.dead && pred(b); }).length; }
  function census() {
    return { whole: alive(function (b) { return b instanceof Hotdog && b.piece === 'whole'; }),
             top: alive(function (b) { return b instanceof Hotdog && b.piece === 'top'; }),
             half: alive(function (b) { return b instanceof HotdogHalf; }),
             total: alive(function () { return true; }) };
  }
  ${RESET}
  var padAt = ${padAt};
  var r = { before: null, after: null, later: null };
  netplay.active = true;
  for (var i = 0; i <= ${pressAt} + ${tail}; i++) {
    me.hitstop = 0;
    if (i !== ${pressAt}) me.mana = 999;
    var bits = padAt(i);
    if (i === ${pressAt}) {
      bits |= ${SP_NEUTRAL};
      r.before = { state: me.state, landLag: me.landLag, mana: me.mana,
                   spinning: me.state === 'special' && me.specialSpawned && me.reels.indexOf(-1) >= 0,
                   census: census() };
    }
    netplay.framePads = [bitsToPad(bits), bitsToPad(0)];
    step();
    if (i === ${pressAt}) r.after = { state: me.state, mana: me.mana, census: census() };
  }
  r.later = { state: me.state, census: census() };
  netplay.active = false; netplay.framePads = null;
  return r;
})()`;

/* The throw recovers on frame 20 and leaves three frames of landLag, so a
   jab pressed on 21 is eaten until 23; ATTACK is held 21-24 so the jab
   starts the first frame it can and is still running on 30. SLOTS pressed on
   23 spins from 31. */
const IN_A_JAB = [`function (i) { return i === 0 ? ${SP_NEUTRAL} : (i >= 21 && i <= 24 ? ${ATTACK} : 0); }`, 30, 0];
const IN_A_SHIELD = [`function (i) { return i === 0 ? ${SP_NEUTRAL} : (i >= 23 ? ${SHIELD} : 0); }`, 30, 0];
const IN_THE_REELS = [`function (i) { return i === 0 ? ${SP_NEUTRAL} : (i === 23 ? ${SP_DOWN} : 0); }`, 34, 0];
const IN_LANDLAG = [`function (i) { return i === 0 ? ${SP_NEUTRAL} : 0; }`, 21, 0];
const IN_FREE = [`function (i) { return i === 0 ? ${SP_NEUTRAL} : 0; }`, 30, 10];

function checkSplit(where, r, expectState) {
  assert.equal(r.before.census.whole, 1, "precondition (" + where + "): a whole hotdog should be in flight");
  assert.equal(r.before.state, expectState,
    "precondition (" + where + "): Simon should be in '" + expectState + "' on the press; he was in '" + r.before.state + "'");
  assert.equal(r.before.mana, 999, "precondition (" + where + "): mana should start pinned");
  const c = r.after.census;
  assert.ok(c.whole === 0 && c.top === 1 && c.half === 1,
    "the split is heard " + where + ": after the press there should be no whole, one top and one " +
    "bottom bun, but the census read whole " + c.whole + ", top " + c.top + ", half " + c.half);
  assert.equal(r.after.mana, 999,
    "one press never both splits and throws (" + where + "): mana went 999 -> " + r.after.mana);
  assert.equal(r.after.state, r.before.state,
    "and the split must not interrupt what he was doing (" + where + "): " + r.before.state + " -> " + r.after.state);
}

const SPLIT_HOISTED = ["    this.splitHotdogs(pad);\n", ""];
const SPLIT_THEN_THROW = ["&& this.hotdogSplit) return;", "&& false) return;"];

test("the split is heard in a jab, a shield, the reels and landLag", async () => {
  const run = await simonVsReese();
  checkSplit("in a jab", run(SPLIT(...IN_A_JAB)), "attack");
  checkSplit("behind a shield", run(SPLIT(...IN_A_SHIELD)), "shield");
  const reels = run(SPLIT(...IN_THE_REELS));
  assert.equal(reels.before.spinning, true, "precondition: the reels should be spinning on the press");
  checkSplit("with the reels spinning", reels, "special");
  const lag = run(SPLIT(...IN_LANDLAG));
  assert.ok(lag.before.landLag > 0, "precondition: he should be in landLag on the press; landLag " + lag.before.landLag);
  checkSplit("in landLag", lag, "idle");
});

test("one press splits the dog and does not also throw the next one", async () => {
  const run = await simonVsReese();
  const r = run(SPLIT(...IN_FREE));
  assert.equal(r.before.landLag, 0, "precondition: he should be free to cast on the press frame");
  checkSplit("in free state", r, "idle");
  assert.equal(r.later.census.whole, 0,
    "and no second whole should appear in the frames a throw would take to spawn one; " +
    "the census ten frames on read whole " + r.later.census.whole);
});

test("control: without the hoisted splitHotdogs() call the press is eaten in a jab", async (t) => {
  const run = await simonVsReese(sabotaged(...SPLIT_HOISTED));
  const jab = run(SPLIT(...IN_A_JAB));
  const free = run(SPLIT(...IN_FREE));
  t.diagnostic("sabotaged hoist read (jab) whole=" + jab.after.census.whole + ", top=" + jab.after.census.top +
    "; (free) whole=" + free.after.census.whole + ", mana=" + free.after.mana);
  assert.equal(jab.after.census.whole, 1, "the sabotage should leave the dog whole through a jab");
  assert.throws(() => checkSplit("in a jab", jab, "attack"), /the split is heard in a jab/);
  // And in free state, with nothing remembering the split, the press casts again.
  assert.equal(free.after.mana, 999 - 22, "in free state the sabotage spends mana on a second dog instead");
  assert.throws(() => checkSplit("in free state", free, "idle"), /the split is heard in free state/);
});

test("control: without the hotdogSplit gate one press splits AND throws", async (t) => {
  const run = await simonVsReese(sabotaged(...SPLIT_THEN_THROW));
  const r = run(SPLIT(...IN_FREE));
  t.diagnostic("sabotaged gate read after: whole=" + r.after.census.whole + ", top=" + r.after.census.top +
    ", half=" + r.after.census.half + ", mana=" + r.after.mana + ", state=" + r.after.state +
    "; later whole=" + r.later.census.whole);
  assert.ok(r.after.census.top === 1 && r.after.census.half === 1, "the sabotage still splits");
  assert.equal(r.after.mana, 999 - 22, "but the same press also pays for a throw");
  assert.equal(r.later.census.whole, 1, "and a second whole is in the air seven frames later");
  assert.throws(() => checkSplit("in free state", r, "idle"), /one press never both splits and throws/);
});
