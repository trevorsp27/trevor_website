/* What 2.55 put in the game, and the trap that came with each piece of it.
 *
 * Six things arrived at once -- a tenth character, a training dummy, a ghost
 * that climbs out of a sleeping man, a detonator on the rainbow, a stage
 * everybody had been asking for, and two damage numbers that moved -- and
 * every one of them is the kind of change that can ship half-working and
 * look fine. A frog that hops the wrong way is still a frog. A cookie that
 * lands and stops is still a cookie. A dummy that quietly loses stocks still
 * stands there. So each of these drives the thing through the real input
 * path and reads what actually happened, rather than asking the spec what it
 * intended.
 *
 * Inputs go through netplay, one pad per seat, the same way a rollback
 * replays a frame. The buttons are edge-triggered, so a bit is set on the
 * press frame only -- holding it down is not a second press.
 *
 * Every test here has a NEGATIVE CONTROL beside it: the same measurement run
 * against a copy of the engine with ONE line changed in memory, and the check
 * is that the same assertions then fail. A test whose sabotage does not fail
 * it is measuring nothing. The mutated copies live in a string and a fresh vm
 * and are never written anywhere.
 *
 * These load the engine source, as nerdwars-kel-buff.test.js does, because
 * almost none of it is reachable through NerdWars.fighters: projectiles,
 * ROSTER, MODES, the trapdoor's two counters and the mana pricing loop are
 * all internals.
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

/* Copied from nerdwars-kel-buff.test.js with one addition: it takes the
   engine SOURCE rather than always reading it off disk, so a negative control
   can boot a mutated copy in a fresh vm without that copy ever touching the
   filesystem. nerdwars-simon.test.js takes the same argument for the same
   reason. */
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

const tapKey = (run, code) => run(`(function () {
  held.clear(); prevHeld.clear(); held.add(${JSON.stringify(code)});
  step();
  held.clear(); prevHeld.clear();
  return scene;
})()`);

/* ------------------------------------------------------------------ */

/* One line of the engine, changed in memory. Never written to disk, and
   never applied to the copy the real tests run against: each sabotage
   produces a string that one fresh vm is booted from and then thrown away.

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
   nothing here: every measurement below hands both of them pads of its own,
   and a pad from netplay is what the fighter reads. */
async function arena(a, b, opts) {
  const o = opts || {};
  const run = await bootEngine(o.engine);
  run(`select.cursor=[${a},${b}]; twoPlayer=true; playerCount=2; humanCount=0;` +
      ` stagePick=${o.stage || 0}; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  return run;
}

/* The world put somewhere known, at the top of every measurement: seat 0
   grounded and free with a full bar, seat 1 a target down at the far end.
   Written as a string rather than as a helper because it runs INSIDE the vm,
   where the test has no functions of its own. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
  me.grabbing = -1; me.grounded = true; me.facing = 1; me.ultMeter = 999;
  me.x = main.x + 30; me.y = main.y; me.specialSpawned = false;
  foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
  foe.stocks = 99; foe.eliminated = false; foe.health = 100; foe.hasHit = true;
  foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y;
  foe.burn = 0; foe.poison = 0; foe.confused = 0; foe.mana = 100;
  foe.x = main.x + main.w - 12;`;

// The pad bits, as netplay packs them.
const ATTACK = 32, ULT = 256;
const SP_NEUTRAL = 512, SP_DOWN = 1024, SP_UP = 2048;

// Where each fighter sits in ORDER. Positions, not names, because that is
// what select.cursor takes.
const NICK = 0, KEL = 2, REESE = 4, COBEUS = 6, SIMON = 7, CHRISTIAN = 9;

/* =====================================================================
   THE TWO NUMBERS THAT MOVED
   ===================================================================== */

/* Press one button, hold the target still, and report the first damage it
   takes. The target is re-pinned every frame -- position, hitstun, i-frames --
   because what is being measured is the size of ONE hit, and a target that
   is allowed to fly away takes the second one somewhere else entirely. */
const firstHit = (run, bits, atX, frames) => run(`(function () {
  ${SETUP}
  foe.invuln = 0; foe.x = me.x + ${atX};
  var took = 0, at = -1;
  netplay.active = true;
  for (var i = 0; i < ${frames}; i++) {
    me.hitstop = 0; me.mana = 999;
    foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.x = me.x + ${atX}; foe.y = main.y; foe.vx = 0; foe.vy = 0;
    netplay.framePads = [bitsToPad(i === 0 ? ${bits} : 0), bitsToPad(0)];
    step();
    if (foe.health < 100) { took = +(100 - foe.health).toFixed(3); at = i; break; }
  }
  netplay.active = false; netplay.framePads = null;
  return { took: took, at: at };
})()`);

function checkBone(run, hit) {
  assert.equal(run("ROSTER.kel.specials.neutral.label"), "BONE",
    "precondition: Kel's neutral special is the bone");
  assert.equal(run("ROSTER.kel.specials.neutral.damage"), 6,
    "the bone is 6 on paper -- 15, then 12, now 6, because it comes back to " +
    "him and skitters afterwards, so it lands more often than one throw's " +
    "worth of damage was ever set for");
  assert.ok(hit.at >= 0, "the bone should have caught him at all");
  assert.equal(hit.took, 6,
    "and 6 on the stage, not just in the table; he lost " + hit.took);
}

test("Kel's bone is 6, in the table and on the stage", async () => {
  const run = await arena(KEL, REESE);
  checkBone(run, firstHit(run, SP_NEUTRAL, 30, 80));
});

test("negative control: a bone worth half of that fails the bone test", async () => {
  const run = await arena(KEL, REESE, { engine: sabotage(
    "damage: 6, base: 3.6, scale: 6.8, angle: 38,",
    "damage: 3, base: 3.6, scale: 6.8, angle: 38,") });
  const hit = firstHit(run, SP_NEUTRAL, 30, 80);
  expectToFail(() => checkBone(run, hit),
    "with the bone halved the bone test should fail; it passed");
});

/* The glass is not one hit, so the measurement is not one number: it is a
   floor tax, re-arming on `hitEvery`, and the thing that changed in 2.55 is
   what one careless step costs. Standing in it is simulated by parking the
   foe on the pane every frame and collecting each time his health drops. */
const glassTicks = (run) => run(`(function () {
  ${SETUP}
  var ticks = [], gaps = [], hp = 100, last = -1, sawGlass = false;
  netplay.active = true;
  for (var i = 0; i < 220; i++) {
    me.hitstop = 0; me.mana = 999;
    foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0; foe.vx = 0; foe.vy = 0;
    var g = projectiles.filter(function (q) {
      return q.constructor.name === 'Glass';
    })[0];
    // Stand in it, whatever it took off the bottle to get there.
    if (g) { sawGlass = true; foe.x = g.x; foe.y = main.y; foe.grounded = true; }
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_NEUTRAL} : 0), bitsToPad(0)];
    step();
    if (g && foe.health < hp) {
      ticks.push(+(hp - foe.health).toFixed(3));
      if (last >= 0) gaps.push(i - last);
      last = i; hp = foe.health;
    }
    if (ticks.length >= 3) break;
  }
  netplay.active = false; netplay.framePads = null;
  return { sawGlass: sawGlass, ticks: ticks.join(','), gaps: gaps.join(',') };
})()`);

function checkGlass(run, g) {
  const spec = run("JSON.stringify(ROSTER.cobeus.specials.neutral.glass)");
  const glass = JSON.parse(spec);
  assert.equal(glass.damage, 2.5,
    "the glass is 2.5 a step on paper -- halved from 5 in 2.55, with nothing " +
    "else about it touched: same four seconds, same 22 pixels, same re-arm");
  assert.equal(glass.life, 240, "and it still lasts four seconds");
  assert.equal(glass.hitEvery, 26,
    "and still re-arms rather than costing once -- it is glass, not a trap");
  assert.ok(g.sawGlass, "the bottle should have broken and left glass");
  assert.equal(g.ticks, "2.5,2.5,2.5",
    "every step in it should cost 2.5, again and again; it cost " + g.ticks);
  for (const gap of g.gaps.split(",")) {
    assert.ok(Number(gap) >= glass.hitEvery,
      "and never faster than hitEvery (" + glass.hitEvery + " frames); the " +
      "gaps between ticks were " + g.gaps);
  }
}

test("Cobeus's broken glass takes 2.5 a step, over and over", async () => {
  const run = await arena(COBEUS, REESE);
  checkGlass(run, glassTicks(run));
});

test("negative control: glass back at its old price fails the glass test", async () => {
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "glass: { life: 240, w: 22, h: 5, hitEvery: 26,\n               damage: 2.5,",
    "glass: { life: 240, w: 22, h: 5, hitEvery: 26,\n               damage: 5,") });
  const g = glassTicks(run);
  expectToFail(() => checkGlass(run, g),
    "with the glass back at 5 the glass test should fail; it passed");
});

/* =====================================================================
   THE RAINBOW'S SECOND PRESS
   ===================================================================== */

/* Cast one rainbow, let it fly, force it onto a chosen color, put the foe
   on top of it and press the button again.

   The color is set by hand rather than waited for. It cycles every seven
   frames, so waiting for PURPLE means waiting 35 frames further into a
   flight that is also falling -- which measures the arc, not the burst. Both
   fields are written because the shot carries the hue AND the spec it will
   hand to applyHit, and setting one without the other is a shot that claims
   to be one color and pays out as another. */
/* Frame 30 of the cast, not frame 22. The throw's own recovery runs to
   frame 23, and a fighter in recovery cannot cast anything -- so bursting at
   22 would have proved the mana untouched for the wrong reason, and the
   negative control below is what caught that. */
const BURST_AT = 30;
const burstAt = (run, hue) => run(`(function () {
  ${SETUP}
  var res = { hue: -1, manaBefore: 0, manaAfter: 0, damage: 0,
              shotsBefore: 0, shotsAfter: 0, burn: 0, poison: 0,
              confused: 0, hitstun: 0, foeManaBefore: 0, foeManaAfter: 0 };
  netplay.active = true;
  for (var i = 0; i < 40; i++) {
    me.hitstop = 0; foe.hitstop = 0; foe.invuln = 0;
    var press = (i === 0) ? ${SP_UP} : 0;
    if (i === ${BURST_AT}) {
      var b = projectiles.filter(function (q) {
        return q.constructor.name === 'Rainbow';
      })[0];
      if (b) {
        b.hue = ${hue}; b.spec = b.base.tints[${hue}];
        // Standing in the ball, not merely near where it is going.
        foe.x = b.x; foe.y = b.y + 8; foe.grounded = false;
        foe.vx = 0; foe.vy = 0; foe.hitstun = 0;
        foe.burn = 0; foe.poison = 0; foe.confused = 0; foe.mana = 100;
        res.hue = b.hue;
      }
      res.manaBefore = me.mana;
      res.foeManaBefore = foe.mana;
      res.shotsBefore = projectiles.filter(function (q) {
        return q.constructor.name === 'Rainbow';
      }).length;
      press = ${SP_UP};
    }
    netplay.framePads = [bitsToPad(press), bitsToPad(0)];
    step();
    if (i === ${BURST_AT}) {
      res.manaAfter = me.mana;
      res.foeManaAfter = foe.mana;
      res.damage = +(100 - foe.health).toFixed(3);
      res.shotsAfter = projectiles.filter(function (q) {
        return q.constructor.name === 'Rainbow';
      }).length;
      res.burn = foe.burn; res.poison = foe.poison;
      res.confused = foe.confused; res.hitstun = foe.hitstun;
      break;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return res;
})()`);

function checkBurst(run, r) {
  assert.equal(run("ROSTER.autisnick.specials.up.label"), "RAINBOW",
    "precondition: Nick's up special is the rainbow");
  assert.equal(r.hue, 0, "precondition: there was a shot in the air to recolor");
  assert.equal(r.shotsBefore, 1, "precondition: exactly one rainbow was up");
  assert.equal(r.shotsAfter, 0,
    "the second press should take the shot out of the air; " + r.shotsAfter +
    " still flying");
  assert.ok(r.damage > 0,
    "and pay out where it went off; the foe standing in it lost " + r.damage);
  /* The half that is easy to get wrong. `maxAlive` is 2, so a press that did
     not find the first shot would legitimately throw a second one -- and the
     bug is the press doing BOTH: bursting the old shot and paying 30 for a
     new one on the same frame. The mana is the only place that shows. */
  const cost = run("ROSTER.autisnick.specials.up.mana");
  assert.ok(cost > 0, "precondition: a rainbow costs something to throw (" + cost + ")");
  /* Not equality: the bar refills half a point a frame while he is standing
     there, so the honest claim is that it did not go DOWN. A cast would take
     `cost` off it on this very frame, which no amount of regen hides. */
  assert.ok(r.manaAfter >= r.manaBefore,
    "bursting costs nothing -- the press that detonates must not also pay " +
    cost + " for a second shot; the bar went " + r.manaBefore + " -> " +
    r.manaAfter);
}

test("a second rainbow press bursts the one in the air, and pays for nothing", async () => {
  const run = await arena(NICK, REESE);
  checkBurst(run, burstAt(run, 0));
});

test("negative control: a press that casts as well as bursts fails the burst test", async () => {
  /* updateFree's cast branch bows out when the press was spent on a burst.
     Without that, the same press does both -- which is precisely the bug the
     mana assertion above is there for. */
  const run = await arena(NICK, REESE, { engine: sabotage(
    "if (intent && intent.kind === 'rainbow' && this.rainbowBurst) return;",
    "if (false) return;") });
  const r = burstAt(run, 0);
  expectToFail(() => checkBurst(run, r),
    "with the press both bursting and casting the burst test should fail; it passed");
});

/* ROYGBP, and what each of them does inside the ball. The statuses are read
   off the foe rather than off the spec: six finished specs built at load is
   an implementation detail, and what the move promises is that the color
   you burst on is the color that lands. */
const COLORS = [
  { hue: 0, tint: "RED", status: "burn", frames: 110 },
  { hue: 1, tint: "ORANGE", status: null, frames: 0 },
  { hue: 2, tint: "YELLOW", status: null, frames: 0 },
  { hue: 3, tint: "GREEN", status: "poison", frames: 150 },
  { hue: 4, tint: "BLUE", status: "confused", frames: 140 },
  { hue: 5, tint: "PURPLE", status: null, frames: 0 },
];

function checkTints(run, rows) {
  const up = JSON.parse(run(`JSON.stringify({
    mul: ROSTER.autisnick.specials.up.burst.damageMul,
    tints: ROSTER.autisnick.specials.up.tints.map(function (t) {
      return { tint: t.tint, damage: t.damage };
    }),
    bursts: ROSTER.autisnick.specials.up.burstTints.map(function (t) {
      return { tint: t.tint, damage: t.damage };
    }),
  })`));
  assert.equal(up.tints.length, 6, "six colors, one per press of the wheel");
  assert.equal(up.bursts.length, 6, "and six explosions to match, built at load");
  assert.equal(up.mul, 1.2,
    "a burst is worth a fifth more than the shot it came from -- a multiplier " +
    "rather than a flat number, so ORANGE still hits hardest inside the ball " +
    "exactly as it does outside it");
  for (let i = 0; i < 6; i++) {
    assert.equal(up.bursts[i].tint, up.tints[i].tint,
      "burst " + i + " should carry color " + up.tints[i].tint);
    assert.ok(Math.abs(up.bursts[i].damage - up.tints[i].damage * up.mul) < 1e-9,
      up.tints[i].tint + " should burst for " + (up.tints[i].damage * up.mul) +
      " (" + up.tints[i].damage + " times " + up.mul + "); the spec says " +
      up.bursts[i].damage);
  }
  for (const row of rows) {
    const want = up.bursts[row.hue].damage;
    assert.equal(row.r.hue, row.hue,
      "precondition: the shot was actually put on " + row.tint);
    assert.ok(Math.abs(row.r.damage - want) < 1e-9,
      row.tint + " should take " + want + " off somebody standing in the " +
      "ball; it took " + row.r.damage);
    if (row.status) {
      assert.equal(row.r[row.status], row.frames,
        row.tint + " should leave its own status on them (" + row.status +
        " for " + row.frames + " frames); it left " + row.r[row.status]);
    }
  }
  // PURPLE's payload is not a timer on the victim, it is their bar.
  const purple = rows.find((row) => row.tint === "PURPLE");
  const drain = run("ROSTER.autisnick.specials.up.colors[5].drain");
  assert.equal(purple.r.foeManaBefore - purple.r.foeManaAfter, drain,
    "PURPLE should still drain " + drain + " of their mana inside the ball; " +
    "it took " + (purple.r.foeManaBefore - purple.r.foeManaAfter));
}

test("six burst colors, each keeping its own payload and a fifth more damage", async () => {
  const run = await arena(NICK, REESE);
  const rows = COLORS.map((c) => ({ ...c, r: burstAt(run, c.hue) }));
  checkTints(run, rows);
});

test("negative control: a burst worth the same as the shot fails the tint test", async () => {
  const run = await arena(NICK, REESE, { engine: sabotage(
    "      damage: t.damage * up.burst.damageMul,",
    "      damage: t.damage,") });
  const rows = COLORS.map((c) => ({ ...c, r: burstAt(run, c.hue) }));
  expectToFail(() => checkTints(run, rows),
    "with the burst no bigger than the shot the tint test should fail; it passed");
});

test("negative control: bursts that all wear one color fail the tint test", async () => {
  /* The tints are patches over the base spec, applied in order. Handing every
     burst the FIRST color's patch leaves six explosions that all burn --
     damage still scaled, statuses all wrong. */
  const run = await arena(NICK, REESE, { engine: sabotage(
    "    up.burstTints = up.tints.map((t) => Object.assign({}, t, up.burst, {",
    "    up.burstTints = up.tints.map((t) => Object.assign({}, up.tints[0], up.burst, {") });
  const rows = COLORS.map((c) => ({ ...c, r: burstAt(run, c.hue) }));
  expectToFail(() => checkTints(run, rows),
    "with every burst wearing RED the tint test should fail; it passed");
});

/* =====================================================================
   SIMON SLOUCH: the free bar, and the part of him that stays awake
   ===================================================================== */

/* The whole ult, frame by frame. He starts on ten mana so a refill would be
   visible as a climb and a SUSPENSION is visible as a jump straight to the
   cap -- which is what 2.55 does: `mana: 100` became `manaFree: 600`, and the
   bar is pinned rather than topped up. */
const slouch = (run, frames) => run(`(function () {
  ${SETUP}
  me.mana = 10;
  var rows = [];
  netplay.active = true;
  for (var i = 0; i < ${frames}; i++) {
    me.hitstop = 0;
    netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    rows.push({ i: i, st: me.state, af: me.attackFrame,
                mana: +me.mana.toFixed(3), free: me.manaFree,
                souls: projectiles.filter(function (q) {
                  return q.constructor.name === 'Soul';
                }).length });
  }
  netplay.active = false; netplay.framePads = null;
  return rows;
})()`);

function checkFreeBar(run, rows) {
  const u = JSON.parse(run(`JSON.stringify({
    startup: ROSTER.simon.ult.startup, active: ROSTER.simon.ult.active,
    manaFree: ROSTER.simon.ult.manaFree, cap: COMBAT.manaMax })`));
  assert.equal(u.manaFree, 600,
    "ten seconds of free specials -- five spent asleep and five his own when " +
    "he wakes up, which is the whole point of the number");
  assert.equal(u.startup + "/" + u.active, "24/300",
    "precondition: 24 frames nodding off, 300 asleep");
  assert.equal(rows[0].st, "ult", "precondition: the press was heard");

  // Armed the frame the move starts, not spread over it.
  assert.equal(rows[1].free, u.manaFree,
    "the whole ten seconds should be on the clock by the second frame; it " +
    "read " + rows[1].free);

  // And then it runs down exactly one frame per frame.
  for (let i = 2; i < Math.min(rows.length, u.manaFree); i++) {
    assert.equal(rows[i].free, rows[i - 1].free - 1,
      "the free window should tick down one a frame; it went " +
      rows[i - 1].free + " -> " + rows[i].free + " on frame " + i);
  }

  /* Pinned full, not refilled. He began on 10, and a refill spread over the
     sleep would climb through the forties around here; a suspension is at
     the cap on every frame it covers. */
  /* From frame 2, not frame 1. The window is armed inside runSpecial, which
     runs after the pin in update(), so the frame it is set on is the one
     frame it cannot have covered yet -- 10.5 there, and the cap from then on. */
  for (let i = 2; i < rows.length; i++) {
    if (rows[i].free <= 0) continue;
    assert.equal(rows[i].mana, u.cap,
      "while the free window runs the bar is simply pinned at " + u.cap +
      "; on frame " + i + " (" + rows[i].free + " left) it read " + rows[i].mana);
  }
  // Long enough to outlive the sleep, which is what makes it a setup rather
  // than something to survive.
  assert.ok(u.manaFree > u.startup + u.active,
    "the free window has to outlast the sleep (" + u.manaFree + " against " +
    (u.startup + u.active) + "), or none of it is ever his to use");
}

test("the slouch buys 600 free frames, and pins the bar full while they run", async () => {
  const run = await arena(SIMON, REESE);
  checkFreeBar(run, slouch(run, 360));
});

test("negative control: a window that refills instead of pinning fails the free-bar test", async () => {
  const run = await arena(SIMON, REESE, { engine: sabotage(
    "if (this.manaFree > 0) { this.manaFree--; this.mana = COMBAT.manaMax; }",
    "if (this.manaFree > 0) { this.manaFree--; this.mana += COMBAT.manaMax / 600; }") });
  const rows = slouch(run, 360);
  expectToFail(() => checkFreeBar(run, rows),
    "with the bar trickling back rather than pinned the free-bar test should fail; it passed");
});

function checkSoul(run, rows) {
  const u = JSON.parse(run(`JSON.stringify({
    startup: ROSTER.simon.ult.startup, active: ROSTER.simon.ult.active })`));
  const wake = u.startup + u.active;
  const out = rows.filter((r) => r.souls > 0).map((r) => r.i);
  assert.ok(out.length > 0, "a soul should climb out at all");
  assert.equal(out[0], u.startup,
    "it should be out the frame he is asleep, not before -- the body has to " +
    "be down first; it appeared on frame " + out[0]);
  assert.equal(out[out.length - 1], wake - 1,
    "and gone the frame he wakes; it was still out on frame " +
    out[out.length - 1] + " of a sleep that ends at " + wake);
  assert.equal(out.length, u.active,
    "which is every sleeping frame and no others: " + out.length + " of " +
    u.active);
  for (const r of rows) {
    assert.ok(r.souls <= 1,
      "one soul, not a queue of them -- frame " + r.i + " had " + r.souls);
  }
  const afterWake = rows.filter((r) => r.i >= wake && r.souls > 0);
  assert.equal(afterWake.length, 0,
    "nothing of his should still be flying once he is up; " +
    afterWake.length + " frames after the wake still had one");
}

test("a soul climbs out while he sleeps, and is gone when he wakes", async () => {
  const run = await arena(SIMON, REESE);
  checkSoul(run, slouch(run, 360));
});

test("negative control: a sleep with nobody climbing out fails the soul test", async () => {
  const run = await arena(SIMON, REESE, { engine: sabotage(
    "          projectiles.push(new Soul(this, s.soul));",
    "          void new Soul(this, s.soul);") });
  const rows = slouch(run, 360);
  expectToFail(() => checkSoul(run, rows),
    "with no soul spawned the soul test should fail; it passed");
});

/* The gloves. The soul is steered by the pad the body would have had, so
   ATTACK is held from frame 30 -- well inside the sleep -- and the soul is
   parked on the target each frame, because where it can fly is not what this
   is measuring. The target is re-pinned for the same reason the bone's was:
   the question is what ONE punch costs and how often another can arrive. */
const punches = (run) => run(`(function () {
  ${SETUP}
  me.mana = 10;
  var hits = [], hp = 100;
  netplay.active = true;
  for (var i = 0; i < 200; i++) {
    me.hitstop = 0;
    foe.hitstop = 0; foe.hitstun = 0; foe.invuln = 0;
    foe.x = main.x + 120; foe.y = main.y; foe.vx = 0; foe.vy = 0;
    foe.grounded = true;
    var s = projectiles.filter(function (q) {
      return q.constructor.name === 'Soul';
    })[0];
    if (s) { s.x = foe.x - 10; s.y = foe.y - 8; s.facing = 1; }
    netplay.framePads = [bitsToPad(i >= 30 ? ${ATTACK} : (i === 0 ? ${ULT} : 0)),
                         bitsToPad(0)];
    step();
    if (foe.health < hp) { hits.push([i, +(hp - foe.health).toFixed(3)]); hp = foe.health; }
  }
  netplay.active = false; netplay.framePads = null;
  return hits.map(function (h) { return h.join(':'); }).join(',');
})()`);

function checkPunch(run, raw) {
  const cfg = JSON.parse(run("JSON.stringify(ROSTER.simon.ult.soul)"));
  assert.equal(cfg.punch.damage, 2,
    "two damage a punch, less than any jab in the game -- the fantasy is " +
    "being in two places, not a damage race");
  assert.ok(cfg.punchEvery < cfg.punch.hitEvery,
    "the gloves are meant to move faster than they can hurt (" +
    cfg.punchEvery + " against " + cfg.punch.hitEvery + "), because " +
    "'punches really fast' is a thing you watch rather than read off a bar");
  const hits = raw ? raw.split(",").map((h) => h.split(":").map(Number)) : [];
  assert.ok(hits.length >= 4,
    "the soul should land a flurry, not one punch; it landed " + hits.length);
  for (const [at, took] of hits) {
    assert.equal(took, cfg.punch.damage,
      "every punch is worth " + cfg.punch.damage + "; the one on frame " +
      at + " took " + took);
  }
  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i][0] - hits[i - 1][0];
    assert.ok(gap >= cfg.punch.hitEvery,
      "and nobody can be taken more often than every " + cfg.punch.hitEvery +
      " frames however fast the gloves go; two landed " + gap +
      " frames apart (" + hits[i - 1][0] + " then " + hits[i][0] + ")");
  }
}

test("the soul's punch is 2, and hitEvery is the most anybody can be taken for", async () => {
  const run = await arena(SIMON, REESE);
  checkPunch(run, punches(run));
});

test("negative control: a glove that re-arms as fast as it swings fails the punch test", async () => {
  const run = await arena(SIMON, REESE, { engine: sabotage(
    "        damage: 2, base: 1.1, scale: 1.5, hitEvery: 16,",
    "        damage: 2, base: 1.1, scale: 1.5, hitEvery: 1,") });
  const raw = punches(run);
  expectToFail(() => checkPunch(run, raw),
    "with the damage clock off the punch test should fail; it passed");
});

/* =====================================================================
   CHRISTIAN -- the tenth, and the one whose kit is about the floor
   ===================================================================== */

/* Throw the cookie and follow it: where it lands, whether it rolls, and what
   it does when the platform runs out. */
const cookieRun = (run) => run(`(function () {
  ${SETUP}
  foe.invuln = 9999;
  var trace = [];
  netplay.active = true;
  for (var i = 0; i < 200; i++) {
    me.hitstop = 0; me.mana = 999;
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_NEUTRAL} : 0), bitsToPad(0)];
    step();
    var c = projectiles.filter(function (q) {
      return q.constructor.name === 'Cookie';
    })[0];
    if (c) {
      trace.push({ i: i, x: +c.x.toFixed(2), y: +c.y.toFixed(2),
                   rolling: !!c.rolling });
    }
  }
  netplay.active = false; netplay.framePads = null;
  return { trace: trace, mainX: main.x, mainW: main.w, mainY: main.y };
})()`);

function checkCookie(run, r) {
  const t = r.trace;
  assert.ok(t.length > 0, "the cookie should have been thrown at all");
  const landed = t.findIndex((f) => f.rolling);
  assert.ok(landed > 0,
    "it should come down on the platform and start rolling, not fly off; it " +
    "never rolled in " + t.length + " frames");
  assert.ok(Math.abs(t[landed].y - r.mainY) < 0.001,
    "and roll ON the floor it landed on; it is at y " + t[landed].y +
    " against a floor at " + r.mainY);

  // It actually travels while rolling, and always the same way.
  const rolling = t.filter((f) => f.rolling);
  assert.ok(rolling.length >= 20,
    "it should run along the platform for a while, not stop where it fell; " +
    rolling.length + " rolling frames");
  const roll = run("ROSTER.christian.specials.neutral.roll");
  for (let i = 1; i < rolling.length; i++) {
    const step = rolling[i].x - rolling[i - 1].x;
    if (rolling[i].i !== rolling[i - 1].i + 1) continue;
    assert.ok(Math.abs(step - roll) < 1e-9,
      "a rolling cookie covers exactly `roll` (" + roll + ") a frame; it " +
      "moved " + step.toFixed(3) + " on frame " + rolling[i].i);
  }
  assert.ok(rolling[rolling.length - 1].x - rolling[0].x > 40,
    "and it should cross a real distance, not shuffle; it rolled " +
    (rolling[rolling.length - 1].x - rolling[0].x).toFixed(1) + "px");

  /* The end of the platform is the point. It does not stop there and it does
     not vanish -- it goes over the edge and keeps going down, which is how
     one throw threatens two levels of a stage. */
  const last = t[t.length - 1];
  assert.equal(last.rolling, false,
    "off the end it stops rolling and falls; it was still rolling at x " +
    last.x);
  assert.ok(last.x > r.mainX + r.mainW || last.x < r.mainX,
    "and it should be past the end of the floor (" + r.mainX + ".." +
    (r.mainX + r.mainW) + "); it finished at x " + last.x);
  assert.ok(last.y > r.mainY,
    "still going down rather than stopped in the air; it finished at y " +
    last.y + " below a floor at " + r.mainY);
}

test("Christian's cookie lands, rolls the platform, and leaves the end still going", async () => {
  const run = await arena(CHRISTIAN, REESE);
  checkCookie(run, cookieRun(run));
});

test("negative control: a cookie that lands and sits there fails the roll test", async () => {
  const run = await arena(CHRISTIAN, REESE, { engine: sabotage(
    "      this.x += this.dir * s.roll;",
    "      this.x += 0;") });
  const r = cookieRun(run);
  expectToFail(() => checkCookie(run, r),
    "with the roll taken out the roll test should fail; it passed");
});

/* The axe. Thirteen frames of wind-up and knockback pointed down and
   forward: on the floor a slam, in the air a spike, and off the side of the
   Battlefield the end of a stock. */
const axeSwing = (run) => run(`(function () {
  ${SETUP}
  foe.invuln = 0; foe.x = me.x + 14; foe.grounded = false; foe.y = main.y - 8;
  var res = { at: -1, damage: 0, vy: 0, vx: 0 };
  netplay.active = true;
  for (var i = 0; i < 60; i++) {
    me.hitstop = 0; me.mana = 999;
    if (foe.health >= 100) {
      foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0;
      foe.x = me.x + 14; foe.y = main.y - 8; foe.vx = 0; foe.vy = 0;
      foe.grounded = false;
    }
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_DOWN} : 0), bitsToPad(0)];
    step();
    if (foe.health < 100) {
      res.at = i; res.damage = +(100 - foe.health).toFixed(3);
      res.vy = +foe.vy.toFixed(3); res.vx = +foe.vx.toFixed(3);
      break;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return res;
})()`);

function checkAxe(run, r) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.christian.specials.down)"));
  assert.equal(s.label, "SPLIT IT", "precondition: the down special is the axe");
  assert.equal(s.damage, 17,
    "the axe is 17, the biggest single number in his kit, and it is what " +
    "thirteen frames of telegraph buy");
  assert.ok(s.ky < 0,
    "and it points DOWN: ky is the vertical half of the knockback and up is " +
    "positive, so a spike is negative; it is " + s.ky);
  assert.ok(r.at >= 0, "the swing should have caught him at all");
  assert.equal(r.damage, 17,
    "and take 17 off him on the stage, not only in the table; he lost " +
    r.damage);
  /* And the direction is not merely in the spec: screen y grows downward, so
     a spike leaves the victim with POSITIVE vy. This is the assertion that
     fails if the sign is ever flipped in the table. */
  assert.ok(r.vy > 0,
    "caught in the air he should be driven toward the floor; he left with " +
    "vy " + r.vy + " (positive is down the screen)");
}

test("the axe does 17 and drives them into the floor", async () => {
  const run = await arena(CHRISTIAN, REESE);
  checkAxe(run, axeSwing(run));
});

test("negative control: an axe that launches fails the spike test", async () => {
  const run = await arena(CHRISTIAN, REESE, { engine: sabotage(
    "      kx: 0.5000000000000001, ky: -0.8660254037844386,",
    "      kx: 0.5000000000000001, ky: 0.8660254037844386,") });
  const r = axeSwing(run);
  expectToFail(() => checkAxe(run, r),
    "with the knockback flipped upward the spike test should fail; it passed");
});

/* FROG ARMY is a recovery that leaves things behind. Cast from the air, so
   the lift is measurable at all, and then left alone for long enough that
   where the frogs went is a decision they made rather than where they fell. */
const frogArmy = (run) => run(`(function () {
  ${SETUP}
  me.grounded = false; me.y = main.y - 40; me.vy = 0;
  foe.invuln = 9999; foe.x = main.x + main.w - 12;
  var y0 = me.y, best = me.y, most = 0;
  netplay.active = true;
  for (var i = 0; i < 30; i++) {
    me.hitstop = 0; me.mana = 999;
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_UP} : 0), bitsToPad(0)];
    step();
    if (me.y < best) best = me.y;
    var n = projectiles.filter(function (q) {
      return q.constructor.name === 'Frog';
    }).length;
    if (n > most) most = n;
  }
  // Let them settle, then note where each one is before it has hopped far.
  for (var i = 0; i < 40; i++) {
    netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step();
  }
  var at = projectiles.filter(function (q) {
    return q.constructor.name === 'Frog';
  }).map(function (f) { return f.x; });
  for (var i = 0; i < 90; i++) {
    netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step();
  }
  var later = projectiles.filter(function (q) {
    return q.constructor.name === 'Frog';
  }).map(function (f) { return f.x; });
  netplay.active = false; netplay.framePads = null;
  return { lift: +(y0 - best).toFixed(2), most: most,
           before: at.map(function (v) { return +v.toFixed(2); }).join(','),
           after: later.map(function (v) { return +v.toFixed(2); }).join(','),
           foeX: +foe.x.toFixed(2) };
})()`);

function checkFrogs(run, r) {
  const s = JSON.parse(run("JSON.stringify(ROSTER.christian.specials.up)"));
  assert.equal(s.label, "FROG ARMY", "precondition: the up special is the frogs");
  assert.ok(s.rise < 0, "precondition: `rise` is negative for up (" + s.rise + ")");
  assert.ok(r.lift > 8,
    "his recovery has to actually recover him -- he throws three frogs at the " +
    "floor and goes up off them; he gained " + r.lift + "px");
  assert.equal(r.most, s.count,
    "and leave " + s.count + " of them on the stage; it left " + r.most);

  /* The half that makes them worth having. They are not scenery: each one
     hops toward whoever is nearest, and a frog hopping the WRONG way is
     still a frog on the screen, which is why this measures direction rather
     than movement. */
  const before = r.before.split(",").map(Number);
  const after = r.after.split(",").map(Number);
  assert.equal(before.length, s.count, "precondition: " + s.count + " frogs settled");
  assert.equal(after.length, before.length,
    "and they should still be around ninety frames later; " + after.length +
    " left of " + before.length);
  for (let i = 0; i < before.length; i++) {
    const want = Math.sign(r.foeX - before[i]);
    const went = Math.sign(after[i] - before[i]);
    assert.ok(went === want,
      "frog " + i + " should hop toward the foe at x " + r.foeX + "; it " +
      "started at " + before[i] + " and finished at " + after[i]);
    assert.ok(Math.abs(after[i] - before[i]) > 10,
      "and cover ground doing it; frog " + i + " moved " +
      Math.abs(after[i] - before[i]).toFixed(1) + "px in ninety frames");
  }
}

test("FROG ARMY lifts him, and the frogs it leaves hop toward the nearest foe", async () => {
  const run = await arena(CHRISTIAN, REESE);
  checkFrogs(run, frogArmy(run));
});

test("negative control: frogs that hop away from you fail the frog test", async () => {
  const run = await arena(CHRISTIAN, REESE, { engine: sabotage(
    "        const dir = foe ? (foe.x >= this.x ? 1 : -1) : 1;",
    "        const dir = foe ? (foe.x >= this.x ? -1 : 1) : 1;") });
  const r = frogArmy(run);
  expectToFail(() => checkFrogs(run, r),
    "with the frogs hopping away the frog test should fail; it passed");
});

const plague = (run) => run(`(function () {
  ${SETUP}
  foe.invuln = 9999;
  var most = 0, everSeen = 0;
  netplay.active = true;
  for (var i = 0; i < 200; i++) {
    me.hitstop = 0;
    netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
    step();
    var n = projectiles.filter(function (q) {
      return q.constructor.name === 'Frog';
    }).length;
    if (n > most) most = n;
    if (n > 0) everSeen++;
  }
  netplay.active = false; netplay.framePads = null;
  return { most: most, frames: everSeen };
})()`);

function checkPlague(run, r) {
  const u = JSON.parse(run("JSON.stringify(ROSTER.christian.ult)"));
  assert.equal(u.label, "THE PLAGUE", "precondition: his ult is the rain of frogs");
  assert.ok(r.most > 1,
    "it RAINS: more than one frog on the stage at a time, or it is the " +
    "recovery again with a longer animation; the most at once was " + r.most);
  assert.ok(r.most >= 4,
    "and enough of them to take the floor away from everybody; the most at " +
    "once was " + r.most);
  assert.ok(r.frames > u.active,
    "and they outlast the shower itself -- they hop after you afterwards; " +
    "there were frogs on " + r.frames + " frames against " + u.active +
    " frames of rain");
}

test("THE PLAGUE rains frogs, more than one at a time", async () => {
  const run = await arena(CHRISTIAN, REESE);
  checkPlague(run, plague(run));
});

test("negative control: an ult that drops one frog fails the plague test", async () => {
  const run = await arena(CHRISTIAN, REESE, { engine: sabotage(
    "    every: 6, lanes: 7,",
    "    every: 600, lanes: 7,") });
  const r = plague(run);
  expectToFail(() => checkPlague(run, r),
    "with the rain down to a single frog the plague test should fail; it passed");
});

/* THE LOAD-ORDER TRAP.

   Mana is priced once, at load, by a loop that walks ROSTER. A character
   declared AFTER that loop gets no prices at all -- and nothing complains.
   `canSpecial` compares a bar against undefined, the subtraction that follows
   writes NaN into the bar, and from the first cast onward he can never afford
   anything again. Christian is the tenth entry in a file where he could very
   easily have been appended in the wrong place, so both halves are pinned:
   the numbers exist, and casting each move leaves a bar that is still a
   number. */
const castAll = (run) => run(`(function () {
  ${SETUP}
  foe.invuln = 9999;
  var out = [];
  var presses = [['neutral', ${SP_NEUTRAL}], ['down', ${SP_DOWN}],
                 ['up', ${SP_UP}], ['ult', ${ULT}]];
  netplay.active = true;
  for (var p = 0; p < presses.length; p++) {
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.mana = 100; me.ultMeter = 999; me.grounded = true;
    me.x = main.x + 30; me.y = main.y; me.vx = 0; me.vy = 0;
    me.specialSpawned = false;
    var before = me.mana;
    var cast = false;
    for (var i = 0; i < 40; i++) {
      me.hitstop = 0;
      netplay.framePads = [bitsToPad(i === 0 ? presses[p][1] : 0), bitsToPad(0)];
      step();
      if (me.state === 'special' || me.state === 'ult') cast = true;
    }
    out.push({ slot: presses[p][0], cast: cast, before: before,
               after: me.mana, nan: me.mana !== me.mana });
  }
  netplay.active = false; netplay.framePads = null;
  return out;
})()`);

function checkPricing(run, rows) {
  const priced = JSON.parse(run(`JSON.stringify(
    Object.keys(ROSTER.christian.specials).map(function (k) {
      return { slot: k, label: ROSTER.christian.specials[k].label,
               mana: ROSTER.christian.specials[k].mana };
    }))`));
  assert.equal(priced.length, 3,
    "precondition: three specials plus the ult make his four moves");
  for (const m of priced) {
    assert.equal(typeof m.mana, "number",
      m.label + " has no price at all -- a ROSTER entry declared after the " +
      "pricing loop is never walked by it, and nothing in the engine says so; " +
      "its mana is " + m.mana);
    assert.ok(m.mana > 0 && Number.isFinite(m.mana),
      m.label + " should cost a real number of mana; it costs " + m.mana);
  }
  for (const r of rows) {
    assert.ok(r.cast,
      "his " + r.slot + " should actually come out on the first press; it " +
      "never left the ground");
    assert.equal(r.nan, false,
      "and casting it must not turn the bar into NaN -- that is what an " +
      "unpriced move does on its first cast, and it never recovers; after " +
      r.slot + " the bar read " + r.after);
    assert.ok(Number.isFinite(r.after),
      "the bar after " + r.slot + " should still be a number; it read " + r.after);
  }
  // The ult is free by design; the three specials are not.
  const spent = rows.filter((r) => r.slot !== "ult");
  for (const r of spent) {
    assert.ok(r.after < r.before,
      "his " + r.slot + " should cost something on the way out; the bar went " +
      r.before + " -> " + r.after);
  }
}

test("every one of Christian's moves is priced, and none of them casts for NaN", async () => {
  const run = await arena(CHRISTIAN, REESE);
  checkPricing(run, castAll(run));
});

test("negative control: a character the pricing loop skipped fails the pricing test", async () => {
  /* The trap itself, reproduced without moving anything: the loop still runs,
     it just does not price HIM -- which is what declaring him below it would
     have done. */
  const run = await arena(CHRISTIAN, REESE, { engine: sabotage(
    "    spec.mana = spec.manaOverride || moveCost(spec);",
    "    spec.mana = key === 'christian' ? undefined : (spec.manaOverride || moveCost(spec));") });
  const rows = castAll(run);
  expectToFail(() => checkPricing(run, rows),
    "with Christian left out of the pricing loop the pricing test should fail; it passed");
});

/* =====================================================================
   PRACTICE, AND THE THING THAT DOES NOT HIT BACK
   ===================================================================== */

/* Into a match the way a player gets into one: pick the mode off the title,
   confirm a fighter, confirm a stage. Looked up by label rather than counted,
   because a position in MODES is exactly the thing 2.55 moved. */
function enterMode(run, pattern) {
  const labels = run("MODES.map(function (m) { return m.label; })");
  const i = labels.findIndex((l) => pattern.test(l));
  assert.ok(i >= 0, "no title entry matching " + pattern + "; the title offers: " +
    labels.join(" / "));
  run("scene = 'title'; titleChoice = " + i + ";");
  assert.equal(tapKey(run, "Enter"), "select",
    "confirming '" + labels[i] + "' should open the character select");
  /* One confirm per seat that has somebody choosing. 1 PLAYER asks twice --
     you pick, then you pick the CPU's fighter -- and practice asks once,
     because the other seat is a sandbag and there is nothing to choose for
     it. Pressed until the screen moves rather than counted, so this helper
     does not have to know which mode it is in. */
  let scene = "select";
  for (let n = 0; n < 4 && scene === "select"; n++) scene = tapKey(run, "Enter");
  assert.equal(scene, "stage",
    "confirming a fighter (or both) should reach the stage select; it reached " +
    scene);
  assert.equal(tapKey(run, "Enter"), "battle",
    "and confirming a stage should start the match");
  return labels[i];
}

function checkSeating(run) {
  const label = enterMode(run, /PRACTICE/i);
  assert.match(label, /SANDBAG/i,
    "the practice entry should say what you are fighting; it says '" + label + "'");
  assert.equal(run("practice"), true, "and it should put the game in practice");
  const keys = run("fighters.map(function (f) { return f.key; }).join(',')");
  assert.equal(keys.split(",")[1], "sandbag",
    "the second seat in practice is the dummy; the match seated " + keys);
  assert.equal(run("!!fighters[1].def.dummy"), true,
    "and it has to be marked as one -- koed() and respawn() both branch on it");
  /* Seated BY NAME, because it is deliberately not in ORDER: there is no
     cursor position it could have been picked from, which is what keeps it
     unpickable everywhere else. */
  assert.equal(run("ORDER.indexOf('sandbag')"), -1,
    "the sandbag must stay out of ORDER, or it becomes a pickable fighter " +
    "with no moves");

  // A dummy has nobody driving it: it stands there whatever is going on.
  const stood = run(`(function () {
    var d = fighters[1], x0 = d.x;
    for (var i = 0; i < 200; i++) step();
    return { moved: +Math.abs(d.x - x0).toFixed(3), state: d.state };
  })()`);
  assert.equal(stood.moved, 0,
    "nothing drives it -- aiDecide hands it an empty pad -- so it should not " +
    "have wandered; it moved " + stood.moved + "px");
}

function checkNotInOrdinaryPlay(run) {
  const keys = run("fighters.map(function (f) { return f.key; }).join(',')");
  assert.ok(!keys.split(",").includes("sandbag"),
    "a 1 PLAYER match must never seat the dummy; it seated " + keys);
  assert.equal(run("practice"), false,
    "and the practice flag must not survive into an ordinary match");
}

test("the sandbag sits down in practice, and only in practice", async () => {
  const run = await arena(NICK, REESE);
  checkSeating(run);
  // ...and the same build, walked into 1 PLAYER instead.
  const other = await arena(NICK, REESE);
  enterMode(other, /1 PLAYER/i);
  checkNotInOrdinaryPlay(other);
});

test("negative control: a build that seats the dummy everywhere fails the seating test", async () => {
  const run = await arena(NICK, REESE, { engine: sabotage(
    "    const key = practice && i >= humanCount ? 'sandbag' : ORDER[pick];",
    "    const key = i >= humanCount ? 'sandbag' : ORDER[pick];") });
  enterMode(run, /1 PLAYER/i);
  expectToFail(() => checkNotInOrdinaryPlay(run),
    "with the dummy seated in every match the seating test should fail; it passed");
});

/* Knocked clean out of the blast zone, which for anybody else is a stock.
   For the dummy it is a flight worth watching and then a walk back to the
   middle -- both halves, because a dummy that came back where it went would
   live on the left edge after the fortieth try and the thing you were
   practicing would be the walk over to it. */
const knockOut = (run) => run(`(function () {
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var d = fighters[1];
  var before = d.stocks;
  d.invuln = 0; d.x = STAGE.blast.left - 20; d.y = main.y; d.vx = 0; d.vy = 0;
  var koAt = -1, backAt = -1;
  for (var i = 0; i < 400; i++) {
    step();
    if (koAt < 0 && d.state === 'ko') koAt = i;
    if (koAt >= 0 && backAt < 0 && d.state !== 'ko') backAt = i;
    if (backAt >= 0) break;
  }
  return { before: before, after: d.stocks, koAt: koAt, backAt: backAt,
           x: +d.x.toFixed(3), y: +d.y.toFixed(3), eliminated: d.eliminated,
           mid: main.x + main.w / 2, floor: main.y, scene: scene };
})()`);

function checkDummyKO(r) {
  assert.ok(r.koAt >= 0, "precondition: it left the blast zone and was KO'd");
  assert.equal(r.after, r.before,
    "the dummy pays nothing for going off the edge; its stocks went " +
    r.before + " -> " + r.after);
  assert.equal(r.eliminated, false,
    "and it is never out of anything, so the match cannot end on it");
  assert.equal(r.scene, "battle", "the match should still be running");
  assert.ok(r.backAt > r.koAt, "precondition: it came back at all");
  assert.equal(r.x, r.mid,
    "and it comes back in the MIDDLE of the main platform, not where it went " +
    "or at the respawn point; it came back at x " + r.x + " against a middle " +
    "at " + r.mid);
  assert.equal(r.y, r.floor,
    "standing on the floor; it came back at y " + r.y + " against a floor at " +
    r.floor);
}

test("the dummy never loses a stock, and comes back in the middle", async () => {
  const run = await arena(NICK, REESE);
  enterMode(run, /PRACTICE/i);
  checkDummyKO(knockOut(run));
});

test("negative control: a dummy that pays for the blast zone fails the KO test", async () => {
  const run = await arena(NICK, REESE, { engine: sabotage(
    "    if (this.def.dummy) {\n      this.setState('ko');",
    "    if (false) {\n      this.setState('ko');") });
  enterMode(run, /PRACTICE/i);
  const r = knockOut(run);
  expectToFail(() => checkDummyKO(r),
    "with the dummy taking stocks like anybody else the KO test should fail; it passed");
});

test("negative control: a dummy that respawns where it died fails the KO test", async () => {
  const run = await arena(NICK, REESE, { engine: sabotage(
    "      this.x = main.x + main.w / 2;\n      this.y = main.y;",
    "      this.x = main.x + 4;\n      this.y = main.y;") });
  enterMode(run, /PRACTICE/i);
  const r = knockOut(run);
  expectToFail(() => checkDummyKO(r),
    "with the dummy coming back on the ledge the KO test should fail; it passed");
});

/* =====================================================================
   THE BATTLEFIELD
   ===================================================================== */

const island = (run) => run(`(function () {
  var rows = {};
  STAGE.platforms.forEach(function (p) { rows[p.y] = (rows[p.y] || 0) + 1; });
  var main = STAGE.platforms.find(function (p) { return p.main; });
  return {
    key: STAGE.key,
    count: STAGE.platforms.length,
    rows: Object.keys(rows).map(Number).sort(function (a, b) { return a - b; })
            .map(function (y) { return y + 'x' + rows[y]; }).join(' '),
    mainL: main.x, mainR: main.x + main.w, mainY: main.y,
    offscreen: STAGE.platforms.filter(function (p) {
      return p.x < 0 || p.x + p.w > VW || p.y <= 0 || p.y >= VH;
    }).map(function (p) { return p.x + ',' + p.y + ',' + p.w; }).join(' | '),
    bodyN: STAGE.body.length,
    bodyOut: STAGE.body.filter(function (pt) {
      return pt[0] < 0 || pt[0] > VW || pt[1] < 0 || pt[1] > VH;
    }).map(function (pt) { return pt.join(','); }).join(' | '),
    VW: VW, VH: VH,
  };
})()`);

function checkIsland(g) {
  assert.equal(g.key, "battlefield", "precondition: the match is on the island");
  assert.equal(g.count, 7, "seven platforms; there are " + g.count);
  /* Three rows, in the proportions Deep Space runs at (54 / 94 / 134) rather
     than the numbers it runs at. The stage was drawn low -- eighty pixels of
     unusable sky above the top platform -- and 58 / 92 / 122 is the fix. */
  assert.equal(g.rows, "58x3 92x3 122x1",
    "three above, three in the middle and the floor, at 58 / 92 / 122; the " +
    "rows are " + g.rows);
  /* The one number that is not the honest fifth. A true scaling runs the
     floor to 322 on a 320px screen: no ledge, no edge-guard, and the stage
     stops being an island. Trimmed to leave six pixels clear at each end. */
  assert.equal(g.mainL + ".." + g.mainR, "6..314",
    "the floor is trimmed to leave a ledge at BOTH ends; it runs " +
    g.mainL + ".." + g.mainR + " on a " + g.VW + "px screen");
  assert.ok(g.mainL > 0 && g.mainR < g.VW,
    "which is what makes it an island rather than a ground");
  assert.equal(g.offscreen, "",
    "no platform may hang off the " + g.VW + "x" + g.VH + " screen; these do: " +
    g.offscreen);
  assert.ok(g.bodyN > 10,
    "the island's underside should be a real silhouette, not a box; it has " +
    g.bodyN + " points");
  assert.equal(g.bodyOut, "",
    "and every point of it is on screen -- a coordinate left in the layout's " +
    "own units rather than scaled shows up here and nowhere else; these are " +
    "outside: " + g.bodyOut);
}

test("the Battlefield is seven platforms on three rows, with a ledge at both ends", async () => {
  const run = await arena(KEL, REESE, { stage: 5 });
  checkIsland(island(run));
});

test("negative control: a floor scaled honestly to 322 fails the island test", async () => {
  const run = await arena(KEL, REESE, { stage: 5, engine: sabotage(
    "      { x: 6, y: 122, w: 308, main: true },",
    "      { x: 0, y: 122, w: 320, main: true },") });
  const g = island(run);
  expectToFail(() => checkIsland(g),
    "with the floor running wall to wall the island test should fail; it passed");
});

/* The door, driven by standing on it. Both counters are simulation state --
   they are in saveSim beside freezeFrames -- so this reads them rather than
   inferring the door's state from what fell through it. */
const trapdoor = (run) => run(`(function () {
  var door = STAGE.platforms.find(function (p) { return p.trap; });
  var f = fighters[0];
  f.setState('idle'); f.hitstun = 0; f.hitstop = 0; f.invuln = 9999;
  f.x = door.x + door.w / 2; f.y = door.y; f.vx = 0; f.vy = 0; f.grounded = true;
  var openAt = -1, shutAt = -1, maxArm = 0, droppedAt = -1, wasOnDoor = false;
  for (var i = 0; i < 400; i++) {
    // Held over the door while it is still there; once it opens he falls,
    // and what happens after that is the point.
    if (trapOpen === 0) {
      f.x = door.x + door.w / 2;
      if (f.grounded) f.y = door.y;
    }
    var groundedBefore = f.grounded;
    step();
    if (trapArm > maxArm) maxArm = trapArm;
    if (openAt < 0 && trapOpen > 0) {
      openAt = i;
      wasOnDoor = groundedBefore;
      droppedAt = f.grounded ? -1 : i;
    }
    if (openAt >= 0 && shutAt < 0 && trapOpen === 0) shutAt = i;
    if (shutAt >= 0) break;
  }
  return { openAt: openAt, shutAt: shutAt, maxArm: maxArm,
           droppedAt: droppedAt, wasOnDoor: wasOnDoor,
           arm: STAGE.trap.arm, open: STAGE.trap.open,
           all: STAGE.platforms.length, whileOpen: STAGE.platformsTrapOpen.length };
})()`);

function checkTrap(t) {
  assert.ok(t.openAt >= 0,
    "standing on the door should open it; after 400 frames it never did " +
    "(the arm counter got as high as " + t.maxArm + " of " + t.arm + ")");
  assert.equal(t.openAt + 1, t.arm,
    "and open on the frame the arm counter fills, half a second in; it " +
    "opened on frame " + t.openAt + " with arm at " + t.arm);
  assert.equal(t.wasOnDoor, true, "precondition: he was standing on it when it went");
  assert.equal(t.droppedAt, t.openAt,
    "the man standing on it loses the ground on the same frame; he was still " +
    "grounded at " + t.droppedAt);
  assert.equal(t.shutAt - t.openAt, t.open,
    "and it hangs open for exactly " + t.open + " frames; it was open for " +
    (t.shutAt - t.openAt));
  assert.equal(t.whileOpen, t.all - 1,
    "while it is open the door is the only platform missing: " + t.whileOpen +
    " of " + t.all);
}

test("the Battlefield's trapdoor still arms, opens, and shuts", async () => {
  const run = await arena(KEL, REESE, { stage: 5 });
  checkTrap(trapdoor(run));
});

test("negative control: a door that never arms fails the trapdoor test", async () => {
  const run = await arena(KEL, REESE, { stage: 5, engine: sabotage(
    "    trap: { arm: 30, open: 180 },",
    "    trap: { arm: 30000, open: 180 },") });
  const t = trapdoor(run);
  expectToFail(() => checkTrap(t),
    "with the door never arming the trapdoor test should fail; it passed");
});
