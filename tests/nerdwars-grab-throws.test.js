/* BASIC_GRAB's three throws -- "make everyones throw from grab a bit farther".
 *
 * 2.84 put +0.4 on `base` for throwFwd, throwUp and throwDown. This is the
 * ONE object every character's grab reads, so it is all ten of them at once,
 * which is why it gets a file rather than a line somewhere.
 *
 * THE TEST MEASURES PIXELS TRAVELED, not the numbers in the ROSTER. A test
 * that read `base` back would pass on a change that moved the literal and
 * nothing else, and two of the four knobs on these moves turn out to do
 * exactly that:
 *
 *   `scale` IS DEAD ON A THROW. applyHit's own header says `scale` multiplies
 *   the damage and nothing else, and that the `scale` it means is the
 *   FUNCTION PARAMETER rather than `move.scale`. `move.scale` is read in two
 *   places in the engine and both are inside moveCost -- and BASIC_GRAB is a
 *   const OUTSIDE ROSTER, so the pricing loop never walks it. Measured below:
 *   scale 0, 5.6 and 11.2 all throw a 96-weight body exactly 27.458 px.
 *
 *   AND KNOCKBACK DOES NOT SCALE WITH THE VICTIM'S DAMAGE. The formula is
 *   (base + damage x 0.14) x (100 / weight) x kbTakenMul, with no percent
 *   term at all -- this is a 100-down-to-0 health bar and not a Smash
 *   percent. Measured below at 100, 60, 20 and 10 health left: 27.458 px
 *   every time. What varies is WEIGHT, so the sweep is over the roster.
 *
 * So "farther" lives in `base` and only in `base`, and the assertions are
 * distances with the ROSTER numbers used only as preconditions.
 *
 * NO ANGLE MOVED, which is deliberate and is also asserted: kx and ky are
 * baked literals that build.py verifies to 1e-12, and moving an angle would
 * have changed the DIRECTION of a throw rather than its reach.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

let __seedCounter = 0;
function seededMath() {
  let s = (0x31415927 ^ (++__seedCounter * 2654435761)) >>> 0 || 1;
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

/* Trev grabs, throws, and then NOBODY presses anything: no DI, no recovery,
   no second input. What is measured is how far the body went before it was
   standing on a floor again, which is what "farther" means to a player.

   THE MATRIX rather than stage 0, because its main floor is the widest in the
   game -- a throw has to land on the stage for the distance to be a distance
   and not a stock. */
async function arena(engineSrc) {
  const booted = await bootEngine(engineSrc);
  const { run } = booted;
  const ORDER = JSON.parse(run("JSON.stringify(ORDER)"));
  assert.ok(ORDER.indexOf("trev") >= 0, "precondition: trev is on the roster");
  run(`
    var MAIN, ORDER_ = ORDER, MATRIX = 0;
    STAGES.forEach(function (s, i) { if (s.name === 'THE MATRIX') MATRIX = i; });
    function seatPair(victim) {
      select.cursor = [ORDER_.indexOf('trev'), ORDER_.indexOf(victim)];
      twoPlayer = true; playerCount = 2; humanCount = 0; practice = false;
      stagePick = MATRIX; startBattle();
      for (var i = 0; i < 60; i++) step();
      MAIN = STAGE.platforms.find(function (p) { return p.main; });
      projectiles.length = 0; effects.length = 0; freezeFrames = 0;
      fighters.forEach(function (f, i) {
        f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
        f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;
        f.grounded = true; f.y = MAIN.y; f.stocks = 99; f.health = 100;
        f.eliminated = false; f.hasHit = false; f.attackFrame = 0;
      });
      netplay.active = true;
    }
    function tick() { netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step(); }
    /* aim: 0 forward, 1 up, 2 down. \`health\` lets the percent question be
       asked directly rather than reasoned about. */
    function throwIt(victim, aim, health, spec) {
      seatPair(victim);
      var A = fighters[0], V = fighters[1];
      V.health = health === undefined ? 100 : health;
      A.x = MAIN.x + 120; V.x = A.x + 8; A.facing = 1;
      A.grabbing = V; V.grabbedBy = A; V.setState('grabbed');
      A.setState('grabhold'); A.timer = 0; A.throwAim = aim; A.throwDirX = 1;
      var m = spec || (aim === 1 ? BASIC_GRAB.throwUp
                     : aim === 2 ? BASIC_GRAB.throwDown : BASIC_GRAB.throwFwd);
      var x0 = V.x, y0 = V.y, peak = 0;
      releaseGrab(A);
      applyHit(A, V, m, V.x - 40);
      var stun = V.hitstun;
      for (var f = 0; f < 240; f++) {
        tick();
        if (y0 - V.y > peak) peak = y0 - V.y;
        if (f > 2 && V.grounded) break;
      }
      return { dx: Math.abs(V.x - x0), peak: peak, stun: stun,
               weight: ROSTER[victim].weight };
    }
    function sweep(aim) {
      var out = [];
      ORDER_.forEach(function (k) {
        if (k === 'sandbag') return;
        var r = throwIt(k, aim);
        out.push({ who: k, weight: r.weight, dx: r.dx, peak: r.peak, stun: r.stun });
      });
      return out;
    }
  `);
  return booted;
}

/* ===================================================================== */
/* 1. ALL THREE THROWS CARRY FARTHER THAN THEY DID                       */
/* ===================================================================== */

/* Measured on THE MATRIX's main floor across all eleven weights:
 *
 *                      before             after
 *    throwFwd   dx     18.3 - 24.4        22.5 - 29.6      +23%
 *    throwUp    peak   13.2 - 17.0        16.5 - 21.2      +24%
 *    throwDown  dx      9.4 - 13.9        13.5 - 15.5      +24%
 *
 * COMPARED PER CHARACTER, WHICH IS THE ONLY COMPARISON THAT MEANS ANYTHING.
 * The spread across the roster is wider than the change -- Houston at 94
 * already went 24.4 where Christian at 106 went 18.3 -- so a bound like "every
 * throw now beats the old best" is a statement about WEIGHT and not about this
 * release, and the first draft of this test made exactly that mistake. Both
 * engines are booted instead, the shipped one and one with the 2.83 bases
 * restored, and every character is checked against HIMSELF.
 *
 * An up-throw's horizontal drift is 0.2 px before and after, so its "farther"
 * is the peak and that is what is read for it.
 */

const OLD_BASES = [
  ["  throwFwd: { damage: 8, base: 3.2, scale: 5.6, angle: 32,",
   "  throwFwd: { damage: 8, base: 2.8, scale: 5.6, angle: 32,"],
  ["  throwUp: { damage: 7, base: 3.1, scale: 6.0, angle: 84,",
   "  throwUp: { damage: 7, base: 2.7, scale: 6.0, angle: 84,"],
  ["  throwDown: { damage: 9, base: 3.0, scale: 4.6, angle: 12,",
   "  throwDown: { damage: 9, base: 2.6, scale: 4.6, angle: 12,"],
];

/* The 2.83 engine, built by putting the three literals back and touching
   nothing else -- which is what makes this a control on `base` rather than on
   the harness. */
function engine283() {
  let src = readFileSync(ENGINE_PATH, "utf8");
  for (const [a, b] of OLD_BASES) {
    const at = src.indexOf(a);
    assert.ok(at >= 0, "2.83 needle missing from the engine: " + a);
    assert.equal(src.indexOf(a, at + 1), -1, "2.83 needle not unique: " + a);
    src = src.slice(0, at) + b + src.slice(at + a.length);
  }
  return src;
}

const ROWS = { fwd: [0, "dx"], up: [1, "peak"], down: [2, "dx"] };

function measure(run) {
  const out = {};
  for (const [name, [aim, key]] of Object.entries(ROWS)) {
    out[name] = {};
    for (const row of run("sweep(" + aim + ")")) out[name][row.who] = row[key];
  }
  return out;
}

function checkFarther(now, was) {
  for (const name of Object.keys(ROWS)) {
    const who = Object.keys(was[name]);
    assert.equal(who.length, 11,
      "precondition: every drawn character on the roster was thrown; " +
      who.length + " were");
    for (const k of who) {
      assert.ok(now[name][k] > was[name][k],
        "+0.4 on `base` has to carry EVERY character farther on every throw, " +
        "because BASIC_GRAB is the one object all ten grabs read. " + k +
        " went " + was[name][k].toFixed(2) + " px on " + name + " before and " +
        now[name][k].toFixed(2) + " after");
      const gain = now[name][k] / was[name][k] - 1;
      assert.ok(gain > 0.08,
        "and far enough to be visible rather than a rounding artifact: " + k +
        " gained " + (100 * gain).toFixed(1) + "% on " + name);
      assert.ok(gain < 0.60,
        "and 'a bit farther' has an upper bound as well as a lower one -- a " +
        "fifth again, not half again. " + k + " gained " +
        (100 * gain).toFixed(1) + "% on " + name);
    }
  }
}

test("all three throws carry every character farther than they went before",
  async () => {
    const now = measure((await arena()).run);
    const was = measure((await arena(engine283())).run);
    checkFarther(now, was);
  });

test("control: the 2.83 bases fail their own before-and-after", async () => {
  /* The shipped engine compared against ITSELF. Every gain is exactly zero,
     so the test that says "farther" has to fail -- which is what proves it is
     reading distance and not just running. */
  const now = measure((await arena()).run);
  expectToFail(() => checkFarther(now, now),
    "an engine compared against itself should fail the farther test");
});

test("control: with the old bases restored, nothing is farther than 2.83",
  async () => {
    const old = measure((await arena(engine283())).run);
    const was = measure((await arena(engine283())).run);
    assert.equal(JSON.stringify(old), JSON.stringify(was),
      "precondition: two boots of the same engine throw identically");
    expectToFail(() => checkFarther(old, was),
      "the 2.83 bases should fail the farther test -- that is what they are");
  });

/* ===================================================================== */
/* 2. IT IS `base` THAT DOES IT, AND NOTHING ELSE ON THE MOVE            */
/* ===================================================================== */

/* Two negative results, and they are the reason section 1 measures pixels.
   Either of these knobs could be moved by somebody trying to make a throw
   go farther, and neither one would move it at all. */

test("`scale` is dead on a throw: zero and double throw the same distance",
  async () => {
    const { run } = await arena();
    const at = (sc) => {
      run("BASIC_GRAB.throwFwd.scale = " + sc + ";");
      return run("throwIt('ladeane', 0)").dx;
    };
    const zero = at(0), ship = at(5.6), twice = at(11.2);
    assert.equal(zero, ship,
      "`scale` multiplies the damage and nothing else, and the `scale` " +
      "applyHit means is its own parameter rather than move.scale -- which " +
      "is read only inside moveCost, and moveCost never walks BASIC_GRAB " +
      "because it is a const outside ROSTER. scale 0 threw " + zero +
      " and scale 5.6 threw " + ship);
    assert.equal(twice, ship,
      "and doubling it changes nothing either: 11.2 threw " + twice);
    /* The positive half. A test that only showed scale doing nothing would
       pass on an engine where the whole throw did nothing. */
    run("BASIC_GRAB.throwFwd.scale = 5.6;");
    run("BASIC_GRAB.throwFwd.base = 2.8;");
    const low = run("throwIt('ladeane', 0)").dx;
    run("BASIC_GRAB.throwFwd.base = 3.2;");
    const high = run("throwIt('ladeane', 0)").dx;
    assert.ok(high - low > 4,
      "while `base` 2.8 -> 3.2 moves the same body from " + low.toFixed(3) +
      " to " + high.toFixed(3) + " px, which is where 'farther' actually lives");
  });

test("knockback reads no percent term: a throw is the same length at any health",
  async () => {
    const { run } = await arena();
    const d = [100, 60, 20, 10].map((h) => run("throwIt('ladeane', 0, " + h + ")").dx);
    for (const x of d) {
      assert.equal(x, d[0],
        "kb is (base + damage x 0.14) x (100 / weight) x kbTakenMul and there " +
        "is no percent in it -- this is a 100-down-to-0 health bar, not a " +
        "Smash percent. At 100, 60, 20 and 10 health the distances were " +
        d.join(", "));
    }
    /* And the term that IS there, so this is not a test that would pass on a
       throw that never moves anybody. */
    const light = run("throwIt('houston', 0)").dx;
    const heavy = run("throwIt('christian', 0)").dx;
    assert.ok(light > heavy + 3,
      "what DOES vary is weight: Houston at 94 goes " + light.toFixed(2) +
      " and Christian at 106 goes " + heavy.toFixed(2));
  });

/* ===================================================================== */
/* 3. NOTHING ELSE ABOUT A THROW MOVED                                   */
/* ===================================================================== */

test("no angle moved, and the throws still point where they always did",
  async () => {
    const { run } = await arena();
    const g = run("JSON.stringify({ fwd: BASIC_GRAB.throwFwd," +
                  " up: BASIC_GRAB.throwUp, down: BASIC_GRAB.throwDown," +
                  " grab: BASIC_GRAB.grab })");
    const s = JSON.parse(g);
    assert.equal(s.fwd.angle, 32, "forward is still 32 degrees: " + s.fwd.angle);
    assert.equal(s.up.angle, 84, "up is still 84: " + s.up.angle);
    assert.equal(s.down.angle, 12, "down is still 12: " + s.down.angle);
    /* The literals themselves, because build.py verifies these to 1e-12 and a
       hand-typed one is the failure mode the engine's own comments warn about.
       An angle that moved without its pair regenerated would build red; an
       angle that moved WITH them would change the direction of a throw, which
       is not what "farther" was asked for. */
    assert.equal(s.fwd.kx, 0.84804809615642596, "and its baked cosine");
    assert.equal(s.fwd.ky, 0.52991926423320490, "and its baked sine");
    assert.equal(s.up.kx, 0.10452846326765346, "up's cosine");
    assert.equal(s.up.ky, 0.99452189536827329, "up's sine");
    assert.equal(s.down.kx, 0.97814760073380569, "down's cosine");
    assert.equal(s.down.ky, 0.20791169081775934, "down's sine");

    assert.equal(s.fwd.damage, 8, "forward still does 8: " + s.fwd.damage);
    assert.equal(s.up.damage, 7, "up still does 7: " + s.up.damage);
    assert.equal(s.down.damage, 9, "down still does 9: " + s.down.damage);
    assert.equal(s.grab.hold, 26, "and the hold is still 26 frames");
    assert.equal(s.grab.damage, 4, "and the catch still takes 4");
  });

test("control: an angle moved on its own is exactly what this test catches",
  async () => {
    /* The failure mode the engine's own comments warn about: somebody types a
       new angle and leaves the baked cosine and sine alone. build.py would
       reject it -- it verifies every angle/kx/ky triple to 1e-12 -- but this
       file should catch it too, because a throw that points somewhere new is
       not the change that was asked for. */
    const { run } = await arena(sabotage(
      "  throwFwd: { damage: 8, base: 3.2, scale: 5.6, angle: 32,",
      "  throwFwd: { damage: 8, base: 3.2, scale: 5.6, angle: 40,"));
    assert.equal(run("BASIC_GRAB.throwFwd.angle"), 40,
      "precondition: the mutant really does carry a moved angle");
    expectToFail(() => {
      assert.equal(run("BASIC_GRAB.throwFwd.angle"), 32,
        "forward is still 32 degrees");
    }, "a moved angle should fail the angle test");
  });

test("a farther throw is not a longer stun", async () => {
  const { run } = await arena();
  const cap = run("COMBAT.hitstunCap");
  for (const [aim, want] of [[0, 16], [1, 16], [2, 16]]) {
    const rows = run("sweep(" + aim + ")");
    for (const row of rows) {
      assert.ok(row.stun <= want,
        "hitstun goes 15/14/15 to 16/15/16 with the extra base, sixteen at " +
        "the very most, and no further -- a throw that carried farther AND " +
        "held longer would be a different change. " +
        row.who + " took " + row.stun + " on aim " + aim);
      assert.ok(row.stun < cap,
        "and nothing is near the cap of " + cap + ": " + row.stun);
    }
  }
});

test("control: a base big enough to change the stun fails the stun test",
  async () => {
    /* hitstun is derived from the same knockback `base` feeds, so there IS a
       size of throw that lengthens it -- which is the point. +0.4 is not that
       size and +2.8 is, so this control proves the stun assertion can fail
       rather than being true of any throw whatsoever. */
    const { run } = await arena(sabotage(
      "  throwFwd: { damage: 8, base: 3.2, scale: 5.6, angle: 32,",
      "  throwFwd: { damage: 8, base: 6.0, scale: 5.6, angle: 32,"));
    const rows = run("sweep(0)");
    const worst = Math.max(...rows.map((r) => r.stun));
    assert.ok(worst > 16,
      "precondition: a base of 6.0 really does hand out more than sixteen " +
      "frames of hitstun; the worst was " + worst);
    expectToFail(() => {
      for (const row of rows) {
        assert.ok(row.stun <= 16,
          row.who + " took " + row.stun);
      }
    }, "a throw with half again the base should fail the stun test");
  });
