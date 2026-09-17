/* OPEN WIDE -- Cobeus' mouth, which is also his recovery.
 *
 * 2.83 REWROTE HOW LONG IT IS OPEN AND NOT WHAT IT DOES. `active` went from
 * sixty frames to ten and the rest of the open time moved behind a held
 * button that empties his bar -- see nerdwars-cobeus-mouth-hold.test.js, which
 * is entirely about that. Every test in THIS file is the same test it was:
 * the flat heal, the eighth catch, the bed, the stock, the fat, the race and
 * the CPU's recovery. What changed here is that the probes hold the button
 * while they feed him, because ten frames is not long enough for another
 * fighter to get a shot into the box, and `heal` reads eight rather than five.
 *
 * Until 2.81 his up slot was the last move in this file labelled PLACEHOLDER:
 * an invisible hop with a hitbox on it, kept only because every other
 * character's `up` is how they get home and a fighter who cannot get home is
 * not playable. The mouth had to keep doing that job, and the constraint made
 * the move: he inhales, and a fat man full of air floats.
 *
 * Six of these tests exist because the obvious way to build it is wrong.
 *
 *   THE HEAL IS FLAT. Houston's eater heals what the shot was carrying up to
 *   a cap, which is right for an aimed swing. The spread of what enters a
 *   catching box runs from nought to the dragon's 999, so the same rule here
 *   would pay three times as much for catching a Salamence as for catching a
 *   pellet, on a move whose prize is the catch and not the meal.
 *
 *   IT ONLY EATS THINGS THAT COULD HAVE HURT HIM. Without one clause a mouth
 *   opened on an empty stage swallows a banana off the floor, a
 *   stretch of Houston's road and a puddle of milk that has not curdled yet.
 *
 *   THE COUNTER IS A STOCK. Nothing else in this file counts a move's uses
 *   and clears them on death -- chickenEggs is per transformation and
 *   ultMeter is not cleared at all -- so nothing gives you this for free, and
 *   a counter that survived would put him to bed for something he did two
 *   lives ago.
 *
 *   FAT IS NOT A BUFF. `buffStats.sizeMul` is where Simon's jackpot puts his
 *   three times life size and it is the obvious home for this. It is also
 *   taken: Cobeus DRINKS, and the drink writes buffStats, so fat and drunk
 *   would overwrite each other.
 *
 *   AND GROWING MUST NOT LIFT HIS BOXES OFF THE FLOOR. This engine has the
 *   bug written up already -- a tripled Simon's every swing passed over
 *   everybody, because `oy` is the box's CENTRE and scaling it scales the
 *   height the box floats at. relBox holds the bottom edge down. A fat Cobeus
 *   is the second character who can reach a size where that matters, so this
 *   is that regression test again, for him.
 *
 * Every test has a NEGATIVE CONTROL: the same checker run against a copy of
 * the engine with one line changed in memory, and the check is that the same
 * assertions then fail. The mutated copies live in a string and a fresh vm
 * and are never written anywhere.
 *
 * A NOTE ON THE PROBES. Every shot fed to the mouth is a REAL one -- the
 * other fighter casts it through the pad and the probe then walks it into the
 * catching box -- so `spec` is whatever the move actually hands applyHit
 * rather than something assembled here. And ~12 frames after any knockOut()
 * nobody updates at all, which is why the stock test counts against the
 * timer rather than against a frame number.
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

/* TWO lines of the engine, for the one control below that genuinely needs
   two. Both pairs are asserted the same way `sabotage` asserts its one, and
   the second needle is looked for in the already-mutated source so a control
   that edits the same line twice is caught rather than quietly winning. */
function sabotageBoth(n1, r1, n2, r2) {
  let src = sabotage(n1, r1);
  const at = src.indexOf(n2);
  assert.ok(at >= 0, "second sabotage needle not found: " + JSON.stringify(n2));
  assert.equal(src.indexOf(n2, at + 1), -1,
    "second sabotage needle is not unique: " + JSON.stringify(n2));
  return src.slice(0, at) + r2 + src.slice(at + n2.length);
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
/* Positions in ORDER, which is what select.cursor takes. */
const COBEUS = 6, NICK = 0;

/* Two seats, reset, and the rest of the world put where it can be ignored. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  freezeFrames = 0;
  fighters.forEach(function (f) {
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
    f.landLag = 0; f.invuln = 0; f.mana = 999; f.vx = 0; f.vy = 0;
    f.grabbing = -1; f.grabbedBy = -1; f.grounded = true; f.y = main.y;
    f.stocks = 9; f.eliminated = false; f.health = 60; f.hasHit = true;
    f.attackFrame = 0; f.specialSpawned = false;
    f.fat = 0; f.bedTimer = 0; f.buffTimer = 0; f.buffStats = null;
  });
  me.x = main.x + 90; me.facing = 1;
  foe.x = me.x + 90; foe.facing = -1; foe.invuln = 9999;`;

const SP_NEUTRAL = 512, SP_UP = 2048, ATTACK = 32, JUMP = 16, GRAB = 64,
      SHIELD = 128, ULT = 256, RIGHT = 2;
/* THE HOLD LEVELS ARE THEIR OWN BITS, and that is worth knowing before
   reading any probe below: bitsToPad(SP_UP) sets `spUp` and `special` -- a
   PRESS -- and leaves `holdUp` false. A press opens the mouth for the ten
   frames `active` buys. Holding it open is bit 16384, which is what the
   charge gate reads, and it is how the move is actually played. */
const HOLD_UP = 16384;

const mouth = (run) =>
  JSON.parse(run("JSON.stringify(ROSTER.cobeus.specials.up)"));

/* ONE CATCH. He opens AND KEEPS IT OPEN; the other man throws; the shot is
   parked in the catching box until it is swallowed. Parking it is the honest
   way to ask this question: the box is 20 wide with 14 of pad either side and
   a flat shot crosses it in about three frames, so a probe that waited for
   the geometry to line up by itself would be measuring the other man's aim.

   THE BUTTON IS HELD AFTER THE PRESS, and that is not the probe making its
   own life easy. A press buys ten open frames; the other man's throw has its
   own startup and the shot then has to be walked in, which takes longer than
   ten. Holding is what a player does with this move and what the charge gate
   exists for, so it is what every catch below is measured through. The hold
   is capped at `charge.hold` (40), which is well inside this loop. */
const CATCH = `
  var caught = -1, h0 = me.health;
  netplay.active = true;
  netplay.framePads = [bitsToPad(SP_UP_BITS | HOLD_BITS), bitsToPad(0)];
  step();
  for (var i = 0; i < 6; i++) {
    netplay.framePads = [bitsToPad(HOLD_BITS), bitsToPad(0)]; step();
  }
  netplay.framePads = [bitsToPad(HOLD_BITS), bitsToPad(THROW_BITS)]; step();
  for (var i = 0; i < 44; i++) {
    me.hitstop = 0; foe.hitstop = 0; foe.invuln = 9999;
    var L = projectiles.filter(function (q) {
      return !q.dead && q.owner === foe;
    });
    if (L.length) { L[0].x = me.x + 4; L[0].y = me.y - 13;
                    L[0].vx = 0; L[0].vy = 0; }
    var f0 = me.fat;
    netplay.framePads = [bitsToPad(HOLD_BITS), bitsToPad(0)]; step();
    if (me.fat > f0) { caught = i; break; }
  }`;

const oneCatch = (run, opts) => {
  const o = opts || {};
  return JSON.parse(run(`(function () {
  ${SETUP}
  me.fat = ${o.fat || 0};
  me.health = ${o.health === undefined ? 40 : o.health};
  ${CATCH.replace("SP_UP_BITS", String(SP_UP))
         .replace(/HOLD_BITS/g, String(HOLD_UP))
         .replace("THROW_BITS", String(SP_NEUTRAL))}
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ caught: caught, healed: +(me.health - h0).toFixed(3),
    fat: me.fat, bed: me.bedTimer, size: +me.sizeMul.toFixed(4),
    shotDamage: ROSTER.autisnick.specials.neutral.damage });
})()`));
};

/* =====================================================================
   1. IT SWALLOWS A SHOT, AND THE CATCH IS THE PRIZE
   ===================================================================== */

function checkFlatHeal(m, r) {
  assert.equal(m.label, "OPEN WIDE",
    "precondition: his up special is the mouth; it is " + m.label);
  assert.ok(r.caught >= 0,
    "a shot parked in the open mouth should be swallowed; it never was");
  assert.equal(r.fat, 1, "and counted; `fat` read " + r.fat);
  assert.equal(r.healed, m.absorb.heal,
    "and heal exactly `absorb.heal` (" + m.absorb.heal + ") -- FLAT, whatever " +
    "went in. The shot was worth " + r.shotDamage + " and he gained " +
    r.healed + ". Houston's eater heals what the shot was carrying because " +
    "his is an aimed swing; this one is a read, and the spread of what " +
    "enters the box runs from nought to the dragon's 999");
}

test("the mouth swallows a shot and heals a flat eight for it", async () => {
  const run = await arena(COBEUS, NICK);
  checkFlatHeal(mouth(run), oneCatch(run));
});

test("negative control: Houston's cap instead of a flat heal fails the flat test", async () => {
  /* The move built the obvious way: no `heal`, a `cap` of fifteen, and
     sweepFrail's existing branch does the rest. Everything else is identical
     -- same box, same pad, same window, same eighth catch -- and a rainbow is
     now worth twice a bullet. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.0625, bite: 8 },",
    "      absorb: { pad: 14, from: 6, to: 15, cap: 15, fat: 0.0625, bite: 8 },") });
  expectToFail(() => checkFlatHeal(mouth(run), oneCatch(run)),
    "a capped heal should fail the flat test; it passed");
});

/* =====================================================================
   2. IT ONLY EATS THINGS THAT COULD HAVE HURT HIM
   ===================================================================== */

/* `live()` is this file's own word for "is it a hitbox right now", and it is
   the whole of the rule -- one clause in the vocabulary sweepFrail already
   speaks, rather than a list of classes that goes stale the next time
   somebody adds one. A banana lying on the floor answers false. So does a
   fresh puddle of milk,
   Houston's road and an idle bot. */
const notFood = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.health = 40;
  netplay.active = true;
  netplay.framePads = [bitsToPad(${SP_UP} | ${HOLD_UP}), bitsToPad(0)];
  step();
  for (var i = 0; i < 6; i++) { netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step(); }
  /* One of each, put in the middle of the open mouth by hand. Constructed
     rather than cast, because the point is what they ARE and not how they
     got there -- and both of their owners are somebody else. */
  /* A banana, and it is on the FLOOR, which is the state that answers false.
     An airborne one is a real shot and a mouth is entitled to eat it -- that
     is the clause working, not failing. */
  var loaf = new Banana(foe, ROSTER.squalls.specials.down, me.x + 4, me.y - 10, 0, 0);
  loaf.grounded = true; loaf.vy = 0; loaf.numb = 0;
  projectiles.push(loaf);
  var milk = new Puddle(foe, ROSTER.houston.specials.neutral.puddle, me.x + 4, me.y);
  projectiles.push(milk);
  var h0 = me.health;
  for (var i = 0; i < 20; i++) {
    me.hitstop = 0;
    loaf.x = me.x + 4; loaf.y = me.y - 10;
    milk.x = me.x + 4;
    netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(0)]; step();
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ loafAlive: !loaf.dead, milkAlive: !milk.dead,
    loafLive: !!(loaf.live && loaf.live()), milkLive: !!(milk.live && milk.live()),
    fat: me.fat, healed: +(me.health - h0).toFixed(2) });
})()`));

function checkNotFood(r) {
  assert.equal(r.loafLive, false,
    "precondition: a banana on the floor is not a hitbox -- live() says so");
  assert.equal(r.milkLive, false,
    "precondition: a fresh puddle is not a hitbox either");
  assert.ok(r.loafAlive,
    "a banana lying in the open mouth is not food; it was eaten");
  assert.ok(r.milkAlive,
    "and neither is a puddle of milk that has not curdled yet; it was eaten");
  assert.equal(r.fat, 0,
    "neither of them counts toward the eighth; `fat` read " + r.fat);
  assert.equal(r.healed, 0,
    "and neither of them heals him; he gained " + r.healed);
}

test("the mouth only eats things that could have hurt him", async () => {
  const run = await arena(COBEUS, NICK);
  checkNotFood(notFood(run));
});

test("negative control: without the live() clause he eats the bread", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      if (shot.live && !shot.live()) continue;\n" +
    "      /* A frail shot dies to the swing itself;",
    "      /* A frail shot dies to the swing itself;") });
  expectToFail(() => checkNotFood(notFood(run)),
    "a mouth that eats loaves should fail the food test; it passed");
});

/* =====================================================================
   3. THE EIGHTH ONE PUTS HIM TO BED
   ===================================================================== */

/* Three seconds, no `rouse` and no `lethal: false`. He is pinned on the last
   open frame of his own move for the whole of it, every button he owns is
   held down through it, his size eases back over the last twenty frames so he
   gets up a normal man rather than snapping eight blit pixels smaller on one
   frame, and his appetite is cleared on the frame he stands up. At the 0.0625
   step the ramp is 24, 22, 20, 18, 16 drawn pixels where 0.04 gave
   21, 20, 19, 17, 16. */
const theBed = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.fat = 7; me.health = 40;
  var sizeAt7 = +me.sizeMul.toFixed(4);
  ${CATCH.replace("SP_UP_BITS", String(SP_UP))
         .replace(/HOLD_BITS/g, String(HOLD_UP))
         .replace("THROW_BITS", String(SP_NEUTRAL))}
  var bedSet = me.bedTimer, sizeAt8 = +me.sizeMul.toFixed(4);
  var ticks = 0, ramp = [], acted = [], freeAt = -1;
  var mash = ${ATTACK} | ${JUMP} | ${GRAB} | ${SHIELD} | ${ULT} | ${SP_NEUTRAL} | ${RIGHT};
  for (var i = 0; i < 300; i++) {
    foe.setState('idle'); foe.hitstun = 0; foe.hitstop = 0;
    if (me.bedTimer > 0) {
      ticks++;
      if (me.bedTimer <= me.specialsNow.up.shrink) ramp.push(+me.sizeMul.toFixed(4));
      if (me.state !== 'special') acted.push(me.state);
    } else if (freeAt < 0 && i > 0) { freeAt = i; }
    netplay.framePads = [bitsToPad(mash), bitsToPad(0)];
    step();
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ sizeAt7: sizeAt7, sizeAt8: sizeAt8, bedSet: bedSet,
    ticks: ticks, ramp: ramp.join(','), acted: acted.join(','),
    fatAfter: me.fat, sizeAfter: +me.sizeMul.toFixed(4) });
})()`));

function checkTheBed(m, r) {
  assert.equal(r.bedSet, m.bed,
    "the `bite`th catch should put him to bed for `bed` (" + m.bed +
    ") frames; the timer read " + r.bedSet);
  assert.equal(r.ticks, m.bed,
    "and every one of them should be spent -- the pin holds him whatever " +
    "anybody does about it; the timer ran for " + r.ticks + " frames");
  assert.equal(r.acted, "",
    "he cannot act for any of it. Attack, jump, grab, shield, ult, the " +
    "neutral special and a direction were all held down on every frame of " +
    "the bed, and he came out of `special` on: " + r.acted);
  const at7 = +(1 + 7 * m.absorb.fat).toFixed(4);
  const at8 = +(1 + 8 * m.absorb.fat).toFixed(4);
  assert.equal(r.sizeAt7, at7,
    "seven catches is `1 + 7 x absorb.fat` (" + at7 + "); he was " + r.sizeAt7);
  assert.equal(r.sizeAt8, at8,
    "and eight is " + at8 + "; he was " + r.sizeAt8);
  const ramp = r.ramp.split(",").filter((v) => v !== "").map(Number);
  assert.ok(ramp.length >= m.shrink - 1,
    "precondition: the last `shrink` frames of the bed have to be recorded; " +
    ramp.length + " were");
  for (let i = 1; i < ramp.length; i++) {
    assert.ok(ramp[i] < ramp[i - 1],
      "and over them he eases back to normal one step at a time rather than " +
      "popping eight blit pixels smaller on one frame; the ramp read " + r.ramp);
  }
  assert.equal(r.fatAfter, 0,
    "he stands up hungry again -- `fat` is cleared on the frame the timer " +
    "reaches zero, not on the catch, because the swelling is what he is " +
    "being punished for and has to still be on him while he lies there; it " +
    "read " + r.fatAfter);
  assert.equal(r.sizeAfter, 1,
    "and back to life size; he got up at " + r.sizeAfter);
}

test("the eighth catch puts him to bed for three seconds and he gets up thin", async () => {
  const run = await arena(COBEUS, NICK);
  checkTheBed(mouth(run), theBed(run));
});

test("negative control: without the pin he walks out of his own bed", async () => {
  /* The three lines in runSpecial are the only thing holding him there. Take
     the pin away and the move simply runs out under him: he is idle inside
     eighty frames with the timer still full, and because nothing else in the
     file decrements it he never serves the sentence at all. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "          this.attackFrame = s.startup + s.active;\n          this.bedTimer--;",
    "          this.bedTimer--;") });
  expectToFail(() => checkTheBed(mouth(run), theBed(run)),
    "a bed he can stand up out of should fail the bed test; it passed");
});

/* =====================================================================
   4. HITTING A MAN IN BED
   ===================================================================== */

/* applyHit already has forty proven lines for a sleeping man -- damage scaled
   by `guard`, no flinch, no grab, no poison, hitstop zeroed on him and light
   on the attacker, and the KO allowed through. The bed reaches them with one
   `||` rather than a second copy, because two copies is two things that can
   drift apart. */
const jabTheBed = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.fat = 7; me.health = 80;
  ${CATCH.replace("SP_UP_BITS", String(SP_UP))
         .replace(/HOLD_BITS/g, String(HOLD_UP))
         .replace("THROW_BITS", String(SP_NEUTRAL))}
  var state0 = me.state, bed0 = me.bedTimer;
  var hits = [], states = [];
  for (var i = 0; i < 80; i++) {
    foe.hitstop = 0; foe.hitstun = 0; foe.invuln = 9999;
    foe.x = me.x + 7; foe.facing = -1;
    var h0 = me.health;
    netplay.framePads = [bitsToPad(0), bitsToPad(${ATTACK})];
    step();
    if (me.health < h0) { hits.push(+(h0 - me.health).toFixed(3)); states.push(me.state); }
  }
  var bedRan = bed0 - me.bedTimer;
  /* And he can be killed in it. Not floored at one: the move deliberately
     carries no lethal flag, because a sleep you cannot die in is not a risk.
     (No backticks in this comment -- it lives inside a template literal and
     one of them would end the probe silently.) */
  var s0 = me.stocks;
  me.health = 2;
  for (var i = 0; i < 80 && me.stocks === s0; i++) {
    foe.hitstop = 0; foe.hitstun = 0; foe.invuln = 9999;
    foe.x = me.x + 7; foe.facing = -1;
    netplay.framePads = [bitsToPad(0), bitsToPad(${ATTACK})];
    step();
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ bed0: bed0, state0: state0, hits: hits.join(','),
    states: states.join(','), bedRan: bedRan, stockTaken: me.stocks < s0,
    jab: ROSTER.autisnick.jab.damage });
})()`));

function checkHitInBed(m, r) {
  assert.ok(r.bed0 > 0, "precondition: he is actually in the bed");
  const hits = r.hits.split(",").filter((v) => v !== "").map(Number);
  assert.ok(hits.length >= 3,
    "precondition: he has to be hit more than once; he was hit " +
    hits.length + " times");
  const want = +(r.jab * m.guard).toFixed(3);
  for (const h of hits) {
    assert.ok(Math.abs(h - want) < 1e-6,
      "a jab on a sleeping man is `guard` (" + m.guard + ") of it -- " + want +
      " against the jab's " + r.jab + "; the hits landed for " + r.hits);
  }
  for (const s of r.states.split(",").filter((v) => v !== "")) {
    assert.equal(s, "special",
      "and it does not flinch him out of the move; he went to " + s);
  }
  assert.ok(r.bedRan >= hits.length,
    "the timer keeps running while it happens -- being hit neither shortens " +
    "nor extends the sentence, because there is no `rouse` on this move; it " +
    "ran down " + r.bedRan + " frames across " + hits.length + " hits");
  assert.equal(r.stockTaken, true,
    "and a bar reaching zero still takes his stock. There is no " +
    "`lethal: false` here on purpose: a sleep you cannot die in is not a risk");
}

test("a man in bed does not flinch, and can still be killed", async () => {
  const run = await arena(COBEUS, NICK);
  checkHitInBed(mouth(run), jabTheBed(run));
});

test("negative control: without the bedded() clause the first jab knocks him out of it", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  const nap = defender.slouching() || defender.bedded();",
    "  const nap = defender.slouching();") });
  expectToFail(() => checkHitInBed(mouth(run), jabTheBed(run)),
    "a sleeping man who flinches should fail the bed-hit test; it passed");
});

/* =====================================================================
   4b. AND SHOOTING A SLEEPING MAN IS NOT A REWARD FOR SHOOTING HIM

   This is the worst bug 2.81 shipped and it was invisible on an empty
   stage -- which is why test 3 above, which measures the bed with nothing
   in the air, passed while the move was broken.

   The bed pins `attackFrame` at `startup + active`, which is 66, and the
   absorb window is `from: 7, to: 66`. The pin therefore parked him on the
   last frame the catching box is open. So every shot thrown at a sleeping
   Cobeus was SWALLOWED instead of landing: it healed him five, it counted
   another fat, and because `fat` was already past `bite` it re-armed the
   whole hundred and eighty. Shooting a helpless man was the single worst
   thing you could do to yourself, and in unassisted CPU play nine of twelve
   beds ran long -- the worst 968 frames instead of 180, at `fat` 78, drawn
   sixty-six pixels tall on a stage a hundred and eighty pixels high.

   The feeder was in the same release: Ladeane's shower is a hundred and
   sixty-two notes, and an open mouth under it is unbounded.

   One line at the top of absorbBox answers it. This is its regression
   test, and the control is that line.                                    */

const bedUnderFire = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.fat = 7; me.health = 60;
  ${CATCH.replace("SP_UP_BITS", String(SP_UP))
         .replace(/HOLD_BITS/g, String(HOLD_UP))
         .replace("THROW_BITS", String(SP_NEUTRAL))}
  var bed0 = me.bedTimer, fat0 = me.fat;
  /* A shot every forty frames for six hundred, each one walked into the
     catching box the same way the single-catch probe walks one in. His
     health is held up so the run is not cut short by a knockout -- the
     question here is the counter and the timer, not whether he survives. */
  var maxFat = me.fat, maxBed = me.bedTimer, rose = 0, prevBed = me.bedTimer;
  var fed = 0;
  for (var i = 0; i < 600; i++) {
    me.hitstop = 0; me.invuln = 0; me.health = 60;
    foe.hitstop = 0; foe.hitstun = 0; foe.invuln = 9999;
    var pads = [bitsToPad(0), bitsToPad(i % 40 === 0 ? ${SP_NEUTRAL} : 0)];
    var L = projectiles.filter(function (q) { return !q.dead && q.owner === foe; });
    if (L.length) { L[0].x = me.x + 4; L[0].y = me.y - 13;
                    L[0].vx = 0; L[0].vy = 0; fed++; }
    netplay.framePads = pads;
    step();
    if (me.fat > maxFat) maxFat = me.fat;
    if (me.bedTimer > prevBed) rose++;
    if (me.bedTimer > maxBed) maxBed = me.bedTimer;
    prevBed = me.bedTimer;
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ bed0: bed0, fat0: fat0, fed: fed, rose: rose,
    maxFat: maxFat, maxBed: maxBed, bed: me.bedTimer, fat: me.fat,
    state: me.state, size: +me.sizeMul.toFixed(4) });
})()`));

function checkBedUnderFire(m, r) {
  assert.equal(r.bed0, m.bed,
    "precondition: the eighth catch put him to bed for " + m.bed +
    "; the timer read " + r.bed0);
  /* A shot lands the frame it is parked -- it is either swallowed or it hits
     him -- so this counts arrivals, not frames. Fifteen casts go out over the
     six hundred frames and this is how many of them reached the box. */
  assert.ok(r.fed >= 10,
    "precondition: shots really did arrive in the box while he slept; only " +
    r.fed + " of them did");
  assert.equal(r.rose, 0,
    "the sentence can only ever count DOWN. A shot swallowed in bed re-arms " +
    "`bed` because `fat` is already past `bite`, so the timer climbing even " +
    "once means a sleeping man is still eating; it climbed " + r.rose +
    " times, to " + r.maxBed);
  assert.equal(r.maxFat, m.absorb.bite,
    "and he does not get any fatter lying down. He went to bed on `bite` (" +
    m.absorb.bite + ") and the counter reached " + r.maxFat);
  assert.equal(r.bed, 0,
    "so the hundred and eighty frames are a hundred and eighty frames and he " +
    "is up inside six hundred; the timer still read " + r.bed);
  assert.equal(r.fat, 0,
    "with his appetite handed back on the frame he stands up; `fat` was " + r.fat);
  assert.equal(r.size, 1,
    "at his own size again; `sizeMul` was " + r.size);
}

test("a sleeping man is not catching, and cannot be fed back to sleep", async () => {
  const run = await arena(COBEUS, NICK);
  checkBedUnderFire(mouth(run), bedUnderFire(run));
});

/* AND THE HALF THAT SAYS WHY THE GUARD IS A GUARD AND NOT ARITHMETIC.

   At 2.81 `absorb.to` was 66 and the bed pinned him on 66, so the window
   covered the pin frame and the bug was live. 2.83's window shuts at 15 and
   the pin is 16, so the two no longer touch -- which means removing the guard
   on its own reproduces NOTHING, and a control that did only that would be
   green for a reason that has nothing to do with the guard.

   So: put the coincidence back, one character of `absorb.to`, and leave the
   guard alone. The whole test still passes, and that is the assertion. The
   rule is "a man asleep is not catching", and the next person to retune
   `active` must not be able to reopen this by arithmetic. */
test("the window put back over the pin frame is still not a way to feed a sleeping man", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.0625, bite: 8 },",
    "      absorb: { pad: 14, from: 6, to: 16, heal: 8, fat: 0.0625, bite: 8 },") });
  checkBedUnderFire(mouth(run), bedUnderFire(run));
});

test("negative control: the window over the pin frame and no bedded() line, and the bed never ends", async () => {
  /* The exact 2.81 bug, restored, and it takes both halves: the window back
     over the pin frame AND the guard gone. Then every parked shot is eaten
     off the pin frame, each one re-arms the full `bed`, and the timer walks
     back UP -- which is the assertion above and is what makes this a control
     rather than a second way of saying the same thing. */
  const run = await arena(COBEUS, NICK, { engine: sabotageBoth(
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.0625, bite: 8 },",
    "      absorb: { pad: 14, from: 6, to: 16, heal: 8, fat: 0.0625, bite: 8 },",
    "    if (f.bedded()) return null;", "") });
  expectToFail(() => checkBedUnderFire(mouth(run), bedUnderFire(run)),
    "a bed that a thrown shot extends should fail the under-fire test; it passed");
});

/* =====================================================================
   5. FAT DOES NOT LIFT HIS BOXES OFF THE FLOOR
   ===================================================================== */

/* THE GIANT-SIMON REGRESSION, for Cobeus. `oy` is a box's CENTRE, so scaling
   a fighter scales the height his boxes float at -- and a tripled Simon's
   every swing passed cleanly over everybody's head, which on screen read as
   the move simply not working while he was big. relBox holds the bottom edge
   at the lower of the scaled and unscaled values, so a bigger body reaches
   further up and further out and never loses anything it could reach before.
   A fat Cobeus is the second character in this file who can reach a size
   where that matters. */
const boxesAtEverySize = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  var out = {};
  var moves = { jab: me.def.jab, mouth: me.specialsNow.up,
                neutral: me.specialsNow.neutral, down: me.specialsNow.down };
  [0, 1, 4, 7, 8].forEach(function (n) {
    me.fat = n;
    var row = { size: +me.sizeMul.toFixed(4) };
    Object.keys(moves).forEach(function (k) {
      var b = me.relBox(moves[k]);
      row[k] = +(b.y + b.h - me.y).toFixed(4);
    });
    var h = me.hurtbox();
    row.hurt = [+h.w.toFixed(3), +h.h.toFixed(3)];
    row.hurtBottom = +(h.y + h.h - me.y).toFixed(4);
    out[n] = row;
  });
  me.fat = 0;
  return JSON.stringify(out);
})()`));

function checkBoxesStayDown(m, r) {
  const base = r[0];
  assert.equal(base.size, 1, "precondition: fat 0 is life size");
  assert.equal(r[8].size, +(1 + 8 * m.absorb.fat).toFixed(4),
    "precondition: eight catches really does swell him");
  for (const n of [1, 4, 7, 8]) {
    for (const k of ["jab", "mouth", "neutral", "down"]) {
      assert.equal(r[n][k], base[k],
        "a fat man's " + k + " box has to keep its bottom edge exactly where " +
        "a thin man's is (" + base[k] + ") -- see relBox, and see what " +
        "scaling one did to a giant Simon; at fat " + n + " it sat at " +
        r[n][k]);
    }
    assert.equal(r[n].hurtBottom, base.hurtBottom,
      "and his own hurtbox stands on the same floor; at fat " + n +
      " its bottom was " + r[n].hurtBottom + " against " + base.hurtBottom);
    assert.ok(r[n].hurt[0] > base.hurt[0] && r[n].hurt[1] > base.hurt[1],
      "while genuinely getting bigger to be hit -- that is the cost of the " +
      "move and it has to be real; at fat " + n + " he was " +
      r[n].hurt.join(" x ") + " against " + base.hurt.join(" x "));
  }
}

test("fat does not lift his boxes off the floor", async () => {
  const run = await arena(COBEUS, NICK);
  checkBoxesStayDown(mouth(run), boxesAtEverySize(run));
});

test("negative control: relBox without the clamp fails the floor test", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "    const bottom = this.y + Math.max(m.oy * k + h / 2, m.oy + m.h / 2);",
    "    const bottom = this.y + (m.oy * k + h / 2);") });
  expectToFail(() => checkBoxesStayDown(mouth(run), boxesAtEverySize(run)),
    "a scaled bottom edge should fail the floor test; it passed");
});

/* =====================================================================
   6. THE COUNTER IS A STOCK, NOT A MATCH
   ===================================================================== */

const acrossAStock = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.fat = 4;
  var before = me.fat, sizeBefore = +me.sizeMul.toFixed(4);
  netplay.active = true;
  me.knockOut();
  /* Long enough for the twelve-frame freeze after a knockOut, the KO
     animation and the respawn to have all happened. Counted generously
     rather than exactly, because the frame he comes back on is the KO
     timer's business and not this test's. */
  for (var i = 0; i < 240; i++) {
    netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step();
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ before: before, sizeBefore: sizeBefore,
    after: me.fat, bed: me.bedTimer, size: +me.sizeMul.toFixed(4),
    state: me.state });
})()`));

function checkPerStock(r) {
  assert.equal(r.before, 4, "precondition: he went into the stock fat");
  assert.ok(r.sizeBefore > 1, "precondition: and visibly so");
  assert.ok(r.state !== "ko",
    "precondition: the probe has to run past the respawn; he is still " + r.state);
  assert.equal(r.after, 0,
    "a fresh stock arrives hungry. Nothing else in this file counts a move's " +
    "uses and clears them on death, so nothing gives this for free -- it is " +
    "written out in respawn() by hand; `fat` came back as " + r.after);
  assert.equal(r.bed, 0, "and awake; `bedTimer` came back as " + r.bed);
  assert.equal(r.size, 1, "and life size; he came back at " + r.size);
}

test("the catch counter is a stock, not a match", async () => {
  const run = await arena(COBEUS, NICK);
  checkPerStock(acrossAStock(run));
});

test("negative control: a respawn that forgets the appetite fails the stock test", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "    this.fat = 0;\n    this.bedTimer = 0;\n    this.evadeCd = 0;",
    "    this.evadeCd = 0;") });
  expectToFail(() => checkPerStock(acrossAStock(run)),
    "a stock that keeps last life's dinner should fail the stock test; it passed");
});

/* =====================================================================
   7. A CHICKEN IS NEVER FAT
   ===================================================================== */

/* One rule, two behaviours, no second field: fatMul asks `specialsNow`, and a
   chicken's moveset is CHICKEN.specials with no mouth in it. So a bird is
   life size however much its owner ate, and un-chickening hands him his belly
   straight back, because `this.fat` was never touched. */
const asABird = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  me.fat = 6;
  var man = +me.sizeMul.toFixed(4);
  me.becomeChicken();
  var bird = +me.sizeMul.toFixed(4), birdFat = me.fat;
  me.chicken = false; me.chickenSince = -1;
  return JSON.stringify({ man: man, bird: bird, birdFat: birdFat,
    again: +me.sizeMul.toFixed(4) });
})()`));

function checkNotFatAsABird(m, r) {
  const want = +(1 + 6 * m.absorb.fat).toFixed(4);
  assert.equal(r.man, want,
    "precondition: six catches leaves him at " + want + "; he was " + r.man);
  assert.equal(r.bird, 1,
    "a chicken is life size whatever its owner ate -- it has no mouth to " +
    "have eaten with; the bird was " + r.bird);
  assert.equal(r.birdFat, 6,
    "and the count is not thrown away, because being run over is not a diet; " +
    "`fat` read " + r.birdFat);
  assert.equal(r.again, want,
    "so he gets his belly back the moment he is a man again; he came back " +
    "at " + r.again);
}

test("a chicken is never fat, and gets its belly back afterwards", async () => {
  const run = await arena(COBEUS, NICK);
  checkNotFatAsABird(mouth(run), asABird(run));
});

test("negative control: fat read off def.specials makes a chicken fat", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "    const m = this.specialsNow && this.specialsNow.up;\n" +
    "    const e = m && m.kind === 'mouth' ? m.absorb : null;",
    "    const m = this.def.specials && this.def.specials.up;\n" +
    "    const e = m && m.kind === 'mouth' ? m.absorb : null;") });
  expectToFail(() => checkNotFatAsABird(mouth(run), asABird(run)),
    "a fat chicken should fail the bird test; it passed");
});

/* =====================================================================
   8. TWO MOUTHS, ONE SHOT
   ===================================================================== */

/* Four players, two of them Cobeus, both open, one shot between them. It has
   to go to exactly one of them and it has to be the same one on both
   machines -- sweepFrail walks `fighters` in slot order and the first box it
   lands in kills the shot, so the lower slot wins. That is a rule rather than
   an accident and it is worth pinning: a version that let both of them count
   it would hand two men a meal for one bullet, and a version that picked by
   distance would be reading a float. */
const raceForIt = (run) => JSON.parse(run(`(function () {
  netplay.active = false; netplay.framePads = null;
  select.cursor = [${COBEUS}, ${COBEUS}, ${NICK}, ${NICK}];
  twoPlayer = false; playerCount = 4; humanCount = 0; stagePick = 0;
  startBattle();
  for (var i = 0; i < 130; i++) step();
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0; freezeFrames = 0;
  fighters.forEach(function (f) {
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
    f.landLag = 0; f.invuln = 9999; f.mana = 999; f.vx = 0; f.vy = 0;
    f.grounded = true; f.y = main.y; f.stocks = 9; f.health = 60;
    f.hasHit = true; f.fat = 0; f.bedTimer = 0;
  });
  /* On the same pixel, so neither of them is nearer. */
  fighters[0].x = main.x + 80; fighters[1].x = main.x + 80;
  fighters[2].x = main.x + 180; fighters[3].x = main.x + 200;
  netplay.active = true;
  var none = [bitsToPad(0), bitsToPad(0), bitsToPad(0), bitsToPad(0)];
  var hold = [bitsToPad(${HOLD_UP}), bitsToPad(${HOLD_UP}), bitsToPad(0), bitsToPad(0)];
  netplay.framePads = [bitsToPad(${SP_UP} | ${HOLD_UP}), bitsToPad(${SP_UP} | ${HOLD_UP}),
                       bitsToPad(0), bitsToPad(0)];
  step();
  for (var i = 0; i < 6; i++) { netplay.framePads = hold; step(); }
  netplay.framePads = [bitsToPad(${HOLD_UP}), bitsToPad(${HOLD_UP}),
                       bitsToPad(${SP_NEUTRAL}), bitsToPad(0)];
  step();
  var h0 = fighters[0].health, h1 = fighters[1].health;
  for (var i = 0; i < 30; i++) {
    var L = projectiles.filter(function (q) {
      return !q.dead && q.owner === fighters[2];
    });
    if (L.length) { L[0].x = fighters[0].x + 4; L[0].y = fighters[0].y - 13;
                    L[0].vx = 0; L[0].vy = 0; }
    fighters.forEach(function (f) { f.hitstop = 0; });
    netplay.framePads = hold; step();
    if (fighters[0].fat || fighters[1].fat) break;
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ fat0: fighters[0].fat, fat1: fighters[1].fat,
    gained0: +(fighters[0].health - h0).toFixed(2),
    gained1: +(fighters[1].health - h1).toFixed(2) });
})()`));

function checkRace(m, r) {
  assert.equal(r.fat0 + r.fat1, 1,
    "one shot is one meal: exactly one of the two open mouths may count it; " +
    "they counted " + r.fat0 + " and " + r.fat1);
  assert.equal(r.fat0, 1,
    "and it is the LOWER slot, because sweepFrail walks `fighters` in slot " +
    "order and the first box the shot is inside kills it. Slot 0 got " +
    r.fat0 + " and slot 1 got " + r.fat1);
  assert.equal(r.gained0, m.absorb.heal,
    "the man who ate it heals; he gained " + r.gained0);
  assert.equal(r.gained1, 0,
    "and the man who did not, does not; he gained " + r.gained1);
}

test("two open mouths race for one shot and the lower slot wins", async () => {
  const run = await arena(COBEUS, NICK);
  checkRace(mouth(run), raceForIt(run));
});

test("negative control: walking the fighters backwards hands it to the other man", async () => {
  /* The order is the rule. Reversed, the same shot goes to slot 1 and the
     answer depends on which way the list happened to be walked -- which is
     the shape of every desync this file has ever had. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  for (const a of fighters) {\n    if (!any && !absorbing) break;",
    "  for (const a of fighters.slice().reverse()) {\n    if (!any && !absorbing) break;") });
  expectToFail(() => checkRace(mouth(run), raceForIt(run)),
    "a backwards sweep should fail the race test; it passed");
});

/* =====================================================================
   9. IT IS NOT A HITBOX
   ===================================================================== */

/* THE DEFECT THIS TEST EXISTS FOR, found by a ladder run and not by reading.

   hitbox() grows a melee box out of `ox/oy/w/h` for every move whose `kind`
   is NOT in its opt-out list, and that list is a list of moves whose reach is
   somewhere else -- a thrown carton, a mower's deck, an egg, a road. The
   mouth belongs on it and was not on it, so OPEN WIDE shipped a 20 by 14
   swing on Cobeus' chest, live for every open frame of the move -- sixty of
   them at the time -- dealing nought damage and nought knockback off the same
   four numbers sweepFrail uses as the CATCHING box.

   Nought damage is what made it invisible. Measured over 120 CPU matches an
   arm on the same seed: with the box, 80% of his matches ran to the time cap,
   the two fighters sat at a mean gap of 0.0 pixels and he was idle 73% of
   every match -- because a free connecting hit on every cast keeps resetting
   the starve clock both AIs use to break a stalemate. Without it: 33% timed
   out, mean gap 23 pixels, idle 23.5%. A move that deals no damage can still
   decide a match. */
const standOnHim = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  var M = me.specialsNow.up;
  var total = M.startup + M.active + M.recovery;
  foe.x = me.x + 4; foe.invuln = 0; foe.health = 80;
  var hp0 = foe.health, boxes = 0, states = {}, stun = 0;
  netplay.active = true;
  netplay.framePads = [bitsToPad(${SP_UP}), bitsToPad(0)];
  step();
  for (var i = 0; i < total + 6; i++) {
    /* Pinned on top of him and kept awake, so the only thing that can reach
       him is the move itself. */
    foe.x = me.x + 4; foe.vx = 0; foe.vy = 0; foe.invuln = 0;
    foe.grounded = true; foe.hitstop = 0;
    me.hitstop = 0;
    var h = me.hitbox();
    if (h) boxes++;
    netplay.framePads = [bitsToPad(0), bitsToPad(0)];
    step();
    states[foe.state] = (states[foe.state] || 0) + 1;
    if (foe.hitstun > 0) stun++;
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ boxes: boxes, dealt: +(hp0 - foe.health).toFixed(3),
    stunFrames: stun, states: Object.keys(states).join(',') });
})()`));

function checkNotAHitbox(r) {
  assert.equal(r.boxes, 0,
    "OPEN WIDE must have no melee hitbox on any frame -- its ox/oy/w/h are " +
    "the CATCHING box sweepFrail pads, and a swing grown out of the same " +
    "four numbers is a second hitbox nobody authored; hitbox() answered on " +
    r.boxes + " frames");
  assert.equal(r.dealt, 0,
    "a man standing inside the open mouth takes nothing from it; he lost " +
    r.dealt);
  assert.equal(r.stunFrames, 0,
    "and is never put in hitstun by it -- which is the half that hides, " +
    "because a nought-damage hit still flinches you and still resets the " +
    "starve clock the CPU uses to break a stalemate; he was stunned for " +
    r.stunFrames + " frames");
}

test("the open mouth is not a hitbox", async () => {
  const run = await arena(COBEUS, NICK);
  checkNotAHitbox(standOnHim(run));
});

test("negative control: a mouth left out of hitbox's opt-out list swings", async () => {
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "          s.kind === 'mouth' ||\n          s.kind === 'newdeal') return null;",
    "          s.kind === 'newdeal') return null;") });
  expectToFail(() => checkNotAHitbox(standOnHim(run)),
    "a mouth that swings should fail the no-hitbox test; it passed");
});

/* =====================================================================
  10. AND NOTHING IS LABELLED PLACEHOLDER ANY MORE
   ===================================================================== */

/* Read off the SOURCE, in the style of the "REM SLEEP, the yawn and the nap
   are gone from the engine entirely" test beside it. A label nobody reads is
   wreckage, and this one was the last of it: 24,000 lines and exactly one
   move still calling itself unfinished. The tag lines that describe a
   character as a placeholder are a different thing and are left alone -- this
   is about a MOVE advertising itself as not real. */
/* =====================================================================
   8b. THE CPU CAN STILL PRESS IT TO GET HOME

   The mouth is his recovery, and reworking the slot very nearly deleted
   that. There is exactly one branch in the whole engine where the AI
   reaches for a special to get back to the stage, and until close-out it
   asked `kind === 'uppercut'` -- a string. The moment this slot stopped
   being an uppercut a falling CPU Cobeus had no button at all: measured,
   86 of 90 stocks thrown off the lip, against 54 with the same probe on
   2.80. A human still had it; the machine did not.

   The gate reads `up.recovers` now, which is the same question asked of
   the DATA, so the next rework either keeps the flag or drops it on
   purpose. This test is what makes that true rather than intended, and it
   is here rather than in an AI file because the flag lives on this move.  */

/* THE GRID MOVED IN, and the reason is measurement rather than taste. The
   twelve drops this used to make -- twelve to sixty pixels out, level to
   forty down -- are recovered from about one cell of, so "he kept a stock on
   at least one of the twelve" was a coin flip riding on one seeded stream.
   Measured over 432 falls (six seeds, six stages) it reads 22.0% home after
   2.83's rework and 19.7% before it, which is the right direction and no
   margin at all for a twelve-trial tripwire. Six to thirty-six out and level
   to twenty down reads 42.8% against 29.4% on the same 432, which is the same
   claim with room in it.

   `mouthLift` is reset with the rest of the state because it is state: one
   lift per trip through the air, and each of these drops is a fresh trip. */
const fallsHome = (run) => JSON.parse(run(`(function () {
  var MAIN = STAGE.platforms.find(function (p) { return p.main; });
  var presses = 0, lost = 0, n = 0;
  for (var d = 0; d < 4; d++) {
    for (var dy = 0; dy <= 20; dy += 10) {
      projectiles.length = 0; effects.length = 0; freezeFrames = 0;
      fighters.forEach(function (f) {
        f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
        f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;
        f.stocks = 9; f.eliminated = false; f.health = 100;
        f.mouthLift = false; f.chargeTimer = 0;
      });
      var me = fighters[0];
      me.x = MAIN.x - (6 + d * 10); me.y = MAIN.y + dy;
      me.grounded = false; me.vy = 0.5; me.jumpsLeft = 0; me.facing = 1;
      fighters[1].x = MAIN.x + MAIN.w / 2; fighters[1].invuln = 99999;
      netplay.active = true;
      var s0 = me.stocks;
      for (var i = 0; i < 240; i++) {
        var p = aiPad(fighters[0], fighters[1]);
        if (p.spUp && p.special) presses++;
        netplay.framePads = [p, bitsToPad(0)];
        step();
        if (me.grounded && me.x > MAIN.x && me.x < MAIN.x + MAIN.w) break;
      }
      lost += s0 - me.stocks; n++;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ presses: presses, lost: lost, n: n });
})()`));

function checkFallsHome(m, r) {
  assert.equal(m.recovers, true,
    "precondition: the move carries the flag aiDecide's recovery branch " +
    "reads; `recovers` was " + m.recovers);
  assert.ok(r.presses > 0,
    "a CPU Cobeus falling below the stage with his jumps spent has to reach " +
    "for his up special. Over " + r.n + " falls he pressed it " + r.presses +
    " times. Zero means the one branch in this engine that goes home is " +
    "blind to him -- which is exactly what a kind-string gate did to him " +
    "when this slot stopped being an uppercut");
  assert.ok(r.lost < r.n,
    "and it has to be worth pressing: he kept a stock on at least one of " +
    "the " + r.n + " falls and lost " + r.lost + ". On this grid, over 432 " +
    "falls across six seeds and six stages, he gets home 42.8% of the time " +
    "at 2.83 against 29.4% at 2.82 -- so nought out of twelve is not a hard " +
    "grid, it is a broken recovery");
}

test("a falling CPU still reaches for the mouth to get home", async () => {
  const run = await arena(COBEUS, NICK);
  checkFallsHome(mouth(run), fallsHome(run));
});

test("negative control: the kind-string gate makes the AI blind to him again", async () => {
  /* The literal bug, restored: the gate as it read before close-out, asking
     the move's KIND instead of the flag. This slot is a mouth, so the branch
     -- the only place in the file where the AI presses a button to get back
     to the stage -- stops seeing him entirely and the presses go to zero. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "me.def.specials.up && me.def.specials.up.recovers &&",
    "me.def.specials.up && me.def.specials.up.kind === 'uppercut' &&") });
  expectToFail(() => checkFallsHome(mouth(run), fallsHome(run)),
    "a recovery the CPU cannot press should fail the falling test; it passed");
});

test("nothing in the engine is labelled PLACEHOLDER any more", async () => {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const hits = src.split("label: 'PLACEHOLDER'").length - 1;
  assert.equal(hits, 0,
    "no move may ship with a PLACEHOLDER label; " + hits + " still do");
  const run = await arena(COBEUS, NICK);
  const labels = JSON.parse(run(`JSON.stringify((function () {
    var out = [];
    Object.keys(ROSTER).forEach(function (k) {
      var s = ROSTER[k].specials || {};
      ['neutral', 'down', 'up'].forEach(function (slot) {
        if (s[slot] && s[slot].label === 'PLACEHOLDER') out.push(k + '.' + slot);
      });
      if (ROSTER[k].ult && ROSTER[k].ult.label === 'PLACEHOLDER') out.push(k + '.ult');
    });
    return out;
  })())`));
  assert.deepEqual(labels, [],
    "and the loaded ROSTER agrees: " + labels.join(", "));
});

test("negative control: one PLACEHOLDER label fails the label test", async () => {
  /* Put back exactly the one that 2.81 removed. */
  const engine = sabotage("      kind: 'mouth', label: 'OPEN WIDE',",
                          "      kind: 'mouth', label: 'PLACEHOLDER',");
  const hits = engine.split("label: 'PLACEHOLDER'").length - 1;
  assert.equal(hits, 1, "precondition: the control really put one back");
  const run = await arena(COBEUS, NICK, { engine });
  const labels = JSON.parse(run(`JSON.stringify((function () {
    var out = [];
    Object.keys(ROSTER).forEach(function (k) {
      var s = ROSTER[k].specials || {};
      ['neutral', 'down', 'up'].forEach(function (slot) {
        if (s[slot] && s[slot].label === 'PLACEHOLDER') out.push(k + '.' + slot);
      });
    });
    return out;
  })())`));
  expectToFail(() => assert.deepEqual(labels, []),
    "a PLACEHOLDER label should fail the label test; it passed");
});
