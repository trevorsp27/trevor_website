/* BUILD-A-BOT -- the aim, as 2.80 made it read.
 *
 * The robot was never short of damage. Built in three presses for 66 mana it
 * punches for 2, 4 and 5 and the finished one carries a gun, and a tournament
 * of 60 CPU matches settled those numbers at 52.8 against 53.2 -- which is
 * inside the noise, and is what the roster's prose has always said.
 *
 * What it was short of was JUDGEMENT about when to swing. `notice` was thirty
 * and `noticeY` twenty against an arm that reaches fifteen and a box that
 * climbs eleven, so the machine spent its cooldown on people it could see and
 * could not touch. And a whiff is not free: punch() charges a full `every` --
 * thirty-six frames at best and fifty-four at worst -- for a swing that misses,
 * and only six for looking and finding nobody. So a notice wider than the arm
 * did not make the robot swing more, it made it swing EARLY and then be on
 * cooldown when somebody finally stepped in.
 *
 * Three things are pinned here, and all three are the buff:
 *
 *   THE TWO WINDOWS AGREE. What it swings at and what it can touch are now
 *   the same distance, measured off the engine's own box() and hurtbox()
 *   rather than off the roster numbers.
 *
 *   A MAN STEPPING INTO THE ARM IS PUNCHED ALMOST AT ONCE, because the
 *   machine was re-checking every six frames instead of recovering from a
 *   swing at somebody it could never have reached.
 *
 *   AND THE OUTPUT DID NOT MOVE except where it was aimed at. `hitEvery` is
 *   untouched at all three tiers, which is what makes better aim safe: no
 *   amount of it produces a stunlock. The one number that did go up is
 *   `fireEvery`, 66 to 60, and it went up to make an existing claim true --
 *   the roster has always said a battery is seven bolts and 66 delivered six.
 *
 * Every assertion has a NEGATIVE CONTROL beside it: the same checker, run
 * against a copy of the engine with the old number put back in memory,
 * asserting that the check then fails.
 *
 * The engine source is loaded directly rather than through NerdWars.fighters,
 * because none of this is reachable from outside: the Bot class, `projectiles`
 * and overlap() are all internals.
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

/* The other half of a negative control: the SAME checker, and it has to throw
   an assertion. Anything else is a broken checker rather than a failed test,
   and is let through so it shows up as itself. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

/* The old numbers, put back one at a time. Written out here rather than
   inline so that every control is demonstrably undoing THIS change and not
   some other edit that happened to land in the same object. */
const WIDE_NOTICE = () => sabotage("        notice: 16, noticeY: 12,",
                                   "        notice: 30, noticeY: 20,");

/* Ladeane in seat 0, Reese in seat 1, both parked on the main floor with
   every timer that could eat an input cleared -- `freezeFrames` especially,
   since a measurement that begins inside somebody else's freeze spends its
   frames on nothing.
 *
 * `build` makes a robot at a chosen tier directly rather than pressing the
 * button three times, because the three presses are 73 frames of Ladeane
 * standing still and none of these tests are about the build. `boot` and
 * `flinch` are zeroed for the same reason: they are the sixteen and nine
 * frames of dead time after a bolt-on, which are real and are somebody else's
 * test. */
async function arena(engineSrc) {
  const booted = await bootEngine(engineSrc);
  const { run } = booted;
  const O = JSON.parse(run("JSON.stringify(ORDER)"));
  const L = O.indexOf("ladeane"), R = O.indexOf("reese");
  assert.ok(L >= 0 && R >= 0, "precondition: both fighters should be in ORDER");
  run("select.cursor=[" + L + ", " + R + "]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; practice=false; startBattle();");
  run("for (var i=0;i<90;i++) step();");
  assert.equal(run("fighters[0].key"), "ladeane",
    "precondition: ladeane should be in seat 0");
  run(`
    var MAIN, SPEC;
    SPEC = ROSTER.ladeane.specials.down;
    function seat() {
      MAIN = STAGE.platforms.find(function (p) { return p.main; });
      projectiles.length = 0; effects.length = 0; freezeFrames = 0;
      fighters.forEach(function (f) {
        f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
        f.landLag = 0; f.invuln = 0; f.mana = 999; f.vx = 0; f.vy = 0;
        f.grounded = true; f.y = MAIN.y; f.stocks = 99; f.health = 100;
        f.hasHit = false; f.attackFrame = 0; f.specialSpawned = false;
      });
      fighters[0].x = MAIN.x + 80; fighters[0].facing = 1;
      fighters[1].x = MAIN.x + 180; fighters[1].facing = -1;
      netplay.active = true;
    }
    function tick() { netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step(); }
    function build(tier, raw) {
      var b = new Bot(fighters[0], SPEC);
      for (var i = 1; i < tier; i++) b.upgrade();
      /* Unless the caller asks for it RAW, the dead frames after the last
         bolt-on are cleared: sixteen of boot and nine of flinch are real and
         they are somebody else's test. The bolt count is the one measurement
         that wants them, because they are half of why the old cadence never
         paid what it claimed. */
      if (!raw) { b.boot = 0; b.flinch = 0; }
      projectiles.push(b);
      return b;
    }
    // The other man held still and whole, so a sweep measures the MACHINE
    // rather than a fight.
    function pin(at) {
      var f = fighters[1];
      f.setState('idle'); f.hitstun = 0; f.hitstop = 0; f.invuln = 0;
      f.x = at; f.vx = 0; f.vy = 0; f.grounded = true; f.y = MAIN.y;
      f.health = 100;
    }
  `);
  return booted;
}

/* =====================================================================
   1. IT SWINGS AT WHAT IT CAN REACH
   ===================================================================== */

/* Measured off box() and hurtbox(), not off the roster: `reach` is the
   furthest a foe's CENTER can be and still be inside the extended arm, and
   `swing` is the furthest it will decide to throw one. The claim is that they
   are the same distance now -- the arm is the notice. */
function checkWindows(w) {
  for (const t of w) {
    /* Two pixels of slack, and it is exactly the first tier's shorter claw:
       `notice` is ONE number for all three parts and it is drawn to the
       finished arm, so the chassis on its own overshoots by the pixel its
       `boxW` is narrower. Anything more than that is a robot deciding to
       swing at somebody it has never been able to touch. */
    assert.ok(t.swing - t.reach <= 2,
      "tier " + t.tier + " must not swing at anybody it cannot touch: it " +
      "swings out to " + t.swing + " and reaches " + t.reach + ", which is " +
      (t.swing - t.reach) + " pixels of decided-on air");
    assert.ok(t.swingY - t.reachY <= 7,
      "and the same vertically, within the tier-1 claw's own shortness: " +
      "tier " + t.tier + " swings up to " + t.swingY + " and reaches " +
      t.reachY);
  }
  /* The floor under all of it. A notice narrower than the arm would pass the
     assertions above and be a nerf, so the useful half of the window is
     asserted too. */
  const top = w[w.length - 1];
  assert.ok(top.reach >= 15,
    "the finished arm still reaches fifteen -- `reach` 3 plus `boxW` 8 " +
    "forward against a hurtbox 9 across -- and this change may not have " +
    "shortened it. It reached " + top.reach);
  assert.ok(top.swing >= top.reach,
    "and it has to be willing to swing that far: it swings " + top.swing);
}

const WINDOWS = `(function () {
  var out = [];
  for (var t = 1; t <= 3; t++) {
    seat();
    var b = build(t);
    var swing = -99, reach = -99;
    for (var dx = 0; dx <= 60; dx++) {
      pin(b.x + dx);
      if (b.target(SPEC.notice, SPEC.noticeY)) swing = dx;
      b.swing = b.spec.swing; b.dir = 1;
      if (overlap(b.box(), fighters[1].hurtbox())) reach = dx;
      b.swing = 0;
    }
    var swingY = -99, reachY = -99;
    for (var dy = 0; dy <= 40; dy++) {
      pin(b.x + 6);
      fighters[1].y = b.y - dy; fighters[1].grounded = false;
      if (b.target(SPEC.notice, SPEC.noticeY)) swingY = dy;
      b.swing = b.spec.swing; b.dir = 1;
      if (overlap(b.box(), fighters[1].hurtbox())) reachY = dy;
      b.swing = 0;
    }
    out.push({ tier: t, swing: swing, reach: reach, swingY: swingY, reachY: reachY });
  }
  return out;
})()`;

test("the two windows agree: it swings at what the arm can touch", async () => {
  const { run } = await arena();
  checkWindows(run(WINDOWS));
});

test("control: the old notice swings at twice the arm", async () => {
  const { run } = await arena(WIDE_NOTICE());
  expectToFail(() => checkWindows(run(WINDOWS)),
    "a notice of thirty against an arm of fifteen should fail checkWindows");
});

/* =====================================================================
   2. AND THAT IS WHY IT IS A BUFF
   ===================================================================== */

/* The mechanism, measured rather than argued. A man stands twenty-two pixels
   away -- inside the old notice, outside the arm at every tier -- for two
   seconds, and then steps in.
 *
 * `swings` is what the machine threw at him while he was out of reach, and it
 * is what a whole `every` gets spent on. `wait` is how long he then had to
 * stand inside the arm before the swing came, averaged over every phase of
 * the clock, because one phase measures the scheduler rather than the move. */
function checkStepIn(s) {
  for (const t of s) {
    assert.equal(t.swings, 0,
      "tier " + t.tier + " must not throw a punch at a man it cannot reach: " +
      "each one of those costs a full `every` of cooldown, and he threw " +
      t.swings + " over a battery");
    assert.equal(t.dealt, 0,
      "and it is not as if they landed -- they cannot, which is the point. " +
      "Tier " + t.tier + " punches did " + t.dealt);
    assert.ok(t.worst <= 10,
      "so a man stepping into tier " + t.tier + "'s arm waits for a " +
      "six-frame re-check and not for a cooldown: the worst phase of the " +
      "clock made him wait " + t.worst + " frames");
    assert.ok(t.mean <= 5,
      "and " + t.mean + " frames on average, across every phase of it");
  }
}

/* Two things share one probe because they are one measurement: the swings
   thrown at somebody out of reach and the wait of the man who then steps in
   are the same fact counted from either end. */
const STEP_IN = `(function () {
  var out = [];
  for (var t = 1; t <= 3; t++) {
    var every = SPEC.tiers[t - 1].every;

    // (a) a whole battery aimed at a man parked just outside the arm.
    seat();
    var b = build(t);
    var swings = 0, was = 0, dealt = 0;
    for (var f = 0; f < SPEC.life; f++) {
      pin(b.x + 22);
      tick();
      if (b.swing > 0 && was === 0) swings++;
      was = b.swing;
    }
    /* Punch damage only. The finished tier's BOLT reaches him at twenty-two
       and is supposed to -- its sight is a hundred and fifty and that is the
       whole point of the third press -- so it is excluded by reading the arm
       rather than the health bar. */
    dealt = 0;
    seat();
    b = build(t);
    for (var f = 0; f < SPEC.life; f++) {
      pin(b.x + 22);
      var before = fighters[1].health;
      var armed = b.swing > 0;
      tick();
      if (armed && fighters[1].health < before) dealt += before - fighters[1].health;
    }

    // (b) and then he steps in, from every phase of the clock there is.
    var worst = 0, sum = 0, n = 0;
    for (var phase = 0; phase < every; phase++) {
      seat();
      var c = build(t);
      /* Long enough to be in the machine's STEADY state. A robot is born
         with a full punch interval on the clock, so the first forty frames of
         its life measure the build rather than the aim. */
      for (var f = 0; f < 120 + phase; f++) { pin(c.x + 22); tick(); }
      var w = -1;
      for (var f = 0; f < 300 && w < 0; f++) {
        pin(c.x + 8);
        tick();
        if (c.swing > 0) w = f;
      }
      if (w < 0) w = 300;
      if (w > worst) worst = w;
      sum += w; n++;
    }
    out.push({ tier: t, swings: swings, dealt: +dealt.toFixed(2),
               worst: worst, mean: +(sum / n).toFixed(1) });
  }
  return out;
})()`;

test("nothing is thrown at a man out of reach, and the man who steps in is punched at once",
  async () => {
    const { run } = await arena();
    checkStepIn(run(STEP_IN));
  });

test("control: the old notice throws the swing early and is on cooldown when he arrives",
  async () => {
    const { run } = await arena(WIDE_NOTICE());
    expectToFail(() => checkStepIn(run(STEP_IN)),
      "a notice wider than the arm should fail checkStepIn");
  });

/* =====================================================================
   3. SEVEN BOLTS, WHICH IS WHAT THE ROSTER ALWAYS SAID
   ===================================================================== */

/* `fire` counts down only on frames the machine is neither booting nor
   flinching, and both upgrade() and strip() re-arm it. So the number is not
   the cadence: a robot that has just had its third part bolted on spends the
   next sixteen frames booting with the gun already armed, and at 66 that was
   enough to keep the seventh shot outside the battery for ever. The robot
   here is RAW -- built and not tidied up -- because those sixteen frames are
   the whole of the difference. */
function checkBolts(b) {
  assert.equal(b.bolts, 7,
    "a full battery is seven bolts, which is what the comment above " +
    "fireEvery has always said it was. It threw " + b.bolts);
  assert.ok(b.bolts * b.fireEvery <= b.life,
    "and seven of them have to FIT inside the battery: " + b.bolts +
    " at one per " + b.fireEvery + " frames against " + b.life);
}

const BOLTS = `(function () {
  seat();
  var b = build(3, true);
  var seen = 0;
  for (var f = 0; f < SPEC.life; f++) {
    /* A hundred away: inside the gun's hundred-and-fifty sight and well
       outside the arm, so the machine is shooting and never punching. */
    pin(b.x + 100);
    var before = projectiles.length;
    tick();
    for (var k = before; k < projectiles.length; k++) {
      if (projectiles[k] && projectiles[k].constructor.name === 'Bolt') seen++;
    }
  }
  return { bolts: seen, fireEvery: SPEC.tiers[2].fireEvery, life: SPEC.life };
})()`;

test("a full battery is seven bolts", async () => {
  const { run } = await arena();
  checkBolts(run(BOLTS));
});

test("control: sixty-six delivers six", async () => {
  /* The old number put back, which is the whole of the evidence for the new
     one: the comment claimed seven at 66 and 66 did not pay it. */
  const { run } = await arena(sabotage("            fireEvery: 60,",
                                       "            fireEvery: 66,"));
  expectToFail(() => checkBolts(run(BOLTS)),
    "sixty-six should fail checkBolts");
});

/* =====================================================================
   4. AND NOTHING ELSE MOVED
   ===================================================================== */

/* The buff is aim. The tournament that settled 2/4/5 against 3/5/6 was a
   DAMAGE argument and it still stands, so the damage may not have moved on
   the back of this; and `hitEvery` is what makes better aim safe, because it
   is the thing that says one hit per thirty frames however well the machine
   aims. A stunlock would be this change going wrong, and it is the only way
   it could. */
function checkUntouched(d) {
  /* Joined rather than deep-compared. These arrays were built inside the vm,
     so they are Arrays of a different realm and deepStrictEqual refuses them
     on the prototype before it ever looks at a number -- which reads as a
     failure that has nothing to do with the robot. */
  assert.equal(d.damage.join(","), "2,4,5",
    "the three punches still do 2, 4 and 5 -- the tournament that chose them " +
    "was about damage and this change is not. They do " + d.damage.join(","));
  assert.equal(d.hitEvery.join(","), "40,34,30",
    "and one hit per 40, 34 and 30 frames, untouched: this is the number " +
    "that makes better aim safe, because no amount of aim beats it. They " +
    "read " + d.hitEvery.join(","));
  assert.equal(d.hp.join(","), "2,2,2",
    "two hits take a part off, at every tier: the stated counterplay is walk " +
    "up and swing six times, and it still is. They read " + d.hp.join(","));
  assert.equal(d.life, 480, "the battery is still eight seconds: " + d.life);
  assert.equal(d.mana, 22, "and a press is still 22 mana: " + d.mana);
  assert.equal(d.boot, 16, "and sixteen dead frames after every bolt-on: " + d.boot);
  assert.equal(d.flinch, 9, "and a stagger of nine on every hit: " + d.flinch);
}

const UNTOUCHED = `(function () {
  return { damage: SPEC.tiers.map(function (t) { return t.damage; }),
           hitEvery: SPEC.tiers.map(function (t) { return t.hitEvery; }),
           hp: SPEC.tiers.map(function (t) { return t.hp; }),
           life: SPEC.life, mana: SPEC.mana, boot: SPEC.boot,
           flinch: SPEC.flinch };
})()`;

test("the damage, the hit rate and the durability are exactly where they were",
  async () => {
    const { run } = await arena();
    checkUntouched(run(UNTOUCHED));
  });

test("control: a hitEvery taken down with the notice fails the untouched test",
  async () => {
    /* The tempting second half of the change, and the one that would turn a
       robot that aims well into a robot that holds you still. */
    const { run } = await arena(sabotage(
      "          { part: 'ONLINE', hp: 2, every: 36, swing: 7, hitEvery: 30,",
      "          { part: 'ONLINE', hp: 2, every: 36, swing: 7, hitEvery: 12,"));
    expectToFail(() => checkUntouched(run(UNTOUCHED)),
      "a shortened hitEvery should fail checkUntouched");
  });
