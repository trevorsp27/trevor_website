/* THE BURP'S REACH, AS A DERIVATION RATHER THAN AS FOUR NUMBERS.
 *
 * 2.81 gave every aim one more frame of wave life -- `waveLife` 13 -> 14 --
 * and widened the three boxes to match. The numbers themselves are already
 * pinned by nerdwars-platforms.test.js, which asserts that every wave stays
 * inside its own box and that the box never reaches further than the art
 * does. What that file cannot say is WHERE the widths came from.
 *
 * This one says it, by taking the derivation away: put `waveLife` back to 13
 * with the wide boxes left in place and the same claim has to fail, because
 * the box is then writing a cheque of four pixels that the noise no longer
 * honours. A test that only pinned 61 would pass for a build where somebody
 * had typed 61 for a different reason.
 *
 * The two edges that may not move are pinned beside it. `up`'s bottom edge is
 * what makes a man standing on the same floor safe from it; `down`'s box is
 * what makes anything airborne safe from that one. Only the far edge and the
 * TOP of `up` were allowed to move in this release.
 *
 * The engine source is loaded directly, the way the other Reese files do,
 * because BELCH_TINTS, `effects`, drawEffects and hitbox() are all internals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

/* Each vm gets its own Math.random stream -- node --test runs files
   concurrently and a shared sequence makes the interleaving different on
   every run. */
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
    getContext: () => ({
      fillRect() {}, clearRect() {}, drawImage() {}, save() {}, restore() {},
      translate() {}, scale() {}, beginPath() {}, arc() {}, fill() {},
      stroke() {}, ellipse() {}, moveTo() {}, lineTo() {}, closePath() {},
      fillText() {}, setTransform() {}, createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      measureText: () => ({ width: 0 }),
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
  return (src) => vm.runInContext(src, sandbox);
}

/* One line of the engine, changed in memory. Both halves are asserted: a
   needle that is missing, or is there twice, makes a control that silently
   mutates nothing or mutates the wrong thing. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

async function arena(engineSrc) {
  const run = await bootEngine(engineSrc);
  const O = JSON.parse(run("JSON.stringify(ORDER)"));
  const R = O.indexOf("reese");
  assert.ok(R >= 0, "precondition: reese should be in ORDER");
  run("select.cursor=[" + R + "," + ((R + 1) % O.length) + "]; twoPlayer=true;" +
      " playerCount=2; humanCount=0; stagePick=0; startBattle();");
  run("netplay.active = true;" +
      " for (var i = 0; i < 130; i++) { netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step(); }" +
      " netplay.active = false; netplay.framePads = null;");
  assert.equal(run("fighters[0].key"), "reese",
    "precondition: reese should be in seat 0");
  return run;
}

const SP_N = 512;
const BIT = { level: 0, up: 4, down: 8 };

/* One shout, and where its waves actually got to. This is the platforms
   test's own probe with the drawing half taken out: what is being pinned
   here is the arithmetic between `waveLife` and the box, not the bracket. */
const shout = (run, aim, facing) => JSON.parse(run(`(function () {
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
  me.poison = 0; me.burn = 0; me.confused = 0;
  me.grabbing = -1; me.grounded = true; me.facing = ${facing};
  me.x = 160; me.y = main.y; me.specialSpawned = false;
  foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
  foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
  var box = null, most = 0;
  var fwdMin = 1e9, fwdMax = -1e9, dyMin = 1e9, dyMax = -1e9;
  netplay.active = true;
  for (var i = 0; i < 34; i++) {
    me.hitstop = 0; me.mana = 999; me.facing = ${facing};
    var bits = i === 0 ? ${SP_N} : (i <= 8 ? ${BIT[aim]} : 0);
    netplay.framePads = [bitsToPad(bits), bitsToPad(0)];
    step();
    var live = me.hitbox();
    if (live && !box) {
      var e0 = (live.box.x - me.x) * ${facing};
      var e1 = (live.box.x + live.box.w - me.x) * ${facing};
      box = { near: Math.min(e0, e1), far: Math.max(e0, e1),
              top: live.box.y - me.y, bot: live.box.y + live.box.h - me.y };
    }
    var ws = effects.filter(function (e) { return e.kind === 'wave'; });
    if (ws.length > most) most = ws.length;
    for (var j = 0; j < ws.length; j++) {
      var fwd = (ws[j].x - me.x) * ${facing}, dy = ws[j].y - me.y;
      if (fwd < fwdMin) fwdMin = fwd;
      if (fwd > fwdMax) fwdMax = fwd;
      if (dy < dyMin) dyMin = dy;
      if (dy > dyMax) dyMax = dy;
    }
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ aim: me.belchAim, box: box, most: most,
    fwdMin: fwdMin, fwdMax: fwdMax, dyMin: dyMin, dyMax: dyMax });
})()`));

/* The claim, as a function, so the control can run exactly it. */
function checkReach(r, where) {
  assert.ok(r.box, "precondition: the " + where + " burp must put a live box on " +
    "the screen or there is nothing to compare the waves against");
  assert.ok(r.most >= 2, "precondition: a shout should put several waves in the " +
    "air, " + where + "; most alive at once was " + r.most);

  assert.ok(r.fwdMax <= r.box.far + 0.01,
    "every wave has to stay inside its own box, " + where + "; furthest wave " +
    r.fwdMax.toFixed(2) + ", box ends " + r.box.far.toFixed(1));
  assert.ok(r.dyMin >= r.box.top - 0.01 && r.dyMax <= r.box.bot + 0.01,
    "and in y, " + where + "; waves ran " + r.dyMin.toFixed(2) + ".." +
    r.dyMax.toFixed(2) + ", box " + r.box.top.toFixed(1) + ".." + r.box.bot.toFixed(1));

  /* THE HALF THE CONTROL BREAKS. The box may not claim reach the noise does
     not cover, so the width is a FUNCTION of `waveLife` and not a preference.
     Put the frame back and this is what fails. */
  assert.ok(r.box.far - r.fwdMax <= 1.5,
    "and the box must not reach further than the art does, " + where +
    "; furthest wave " + r.fwdMax.toFixed(2) + ", box ends " +
    r.box.far.toFixed(1) + " -- " + (r.box.far - r.fwdMax).toFixed(2) + " of slack");
}

test("the burp's three boxes are derived from `waveLife`", async () => {
  const run = await arena();
  const life = Number(run("ROSTER.reese.specials.neutral.waveLife"));
  assert.equal(life, 14,
    "precondition: 2.81 ships fourteen frames of wave life; the spec says " + life);
  for (const aim of ["level", "up", "down"]) {
    for (const facing of [1, -1]) {
      const r = shout(run, aim, facing);
      assert.equal(r.aim, aim, "precondition: holding the direction should latch " +
        "the " + aim + " burp; it latched " + r.aim);
      checkReach(r, aim + " facing " + (facing > 0 ? "right" : "left"));
    }
  }
});

test("negative control: the wide boxes with thirteen frames of wave fail it", async () => {
  /* The derivation, taken away. The boxes keep the widths 2.81 gave them and
     the noise goes back to twelve steps of 3.9 instead of thirteen, which is
     exactly the build somebody produces by reverting one number and not the
     other four. Every wave is still INSIDE its box -- a shorter shout cannot
     leave one -- so the only assertion that can catch it is the one about the
     box reaching further than the art. */
  const run = await arena(sabotage(
    "spawnX: 9, spawnY: -11, waveSpeed: 3.9, waveLife: 14,",
    "spawnX: 9, spawnY: -11, waveSpeed: 3.9, waveLife: 13,"));
  const r = shout(run, "level", 1);
  expectToFail(() => checkReach(r, "level facing right"),
    "with the frame taken back off the waves and the wide box left in place, " +
    "the box must fail the reach test");
});

test("the two edges the aims are FOR did not move", async () => {
  /* `up` is the anti-air and `down` is the anti-ground, and each of them is
     that because of exactly one edge. This release widened both aims and
     lifted the TOP of `up`; anything else moving here would quietly turn one
     of them into a worse copy of the level burp. */
  const run = await arena();
  const p = JSON.parse(run(`(function () {
    var n = ROSTER.reese.specials.neutral;
    var out = {};
    ['level', 'up', 'down'].forEach(function (k) {
      var a = n.parts[k];
      out[k] = { near: a.ox, far: a.ox + a.w,
                 top: a.oy - a.h / 2, bot: a.oy + a.h / 2,
                 spawnY: a.spawnY, damage: a.damage };
    });
    return JSON.stringify(out);
  })()`));

  assert.equal(p.up.bot, -16,
    "the upward shout's BOTTOM edge is what makes a man standing on the same " +
    "floor completely safe from it -- sixteen above his feet against a " +
    "fourteen-tall hurtbox -- and it is pinned to the pixel. It was " + p.up.bot);
  assert.equal(p.up.top, -49,
    "and the top is the half that was allowed to move, from -47 to -49 with " +
    "the extra frame of climb. It was " + p.up.top);

  assert.equal(p.down.top, -8,
    "the floor-level shout's TOP edge is the mirror of that rule: eight above " +
    "his feet, so anything that has left the ground is untouched. It was " +
    p.down.top);
  assert.ok(p.down.bot >= 3.54 && p.down.bot <= 4.5,
    "and its bottom has to cover the thirteenth step of the wave, which " +
    "lands at +3.54 -- the box was " + p.down.bot + ", which either clips " +
    "the art or reaches past it");

  assert.equal(p.level.near, -1, "and all three still start a pixel behind him");
  assert.equal(p.up.near, -1, "including up");
  assert.equal(p.down.near, -1, "and down");
});

test("the aims are worth more than the default, not less", async () => {
  /* The inversion 2.81 made, written down as an assertion so a later pass
     that re-flattens the three has to argue with something rather than just
     tidy them. `up` cannot touch anybody on his own floor and `down` cannot
     touch anybody off it; the level burp can touch either, and is the
     cheapest of the three to press. */
  const run = await arena();
  const d = JSON.parse(run(`(function () {
    var n = ROSTER.reese.specials.neutral;
    return JSON.stringify({ level: n.parts.level.damage, up: n.parts.up.damage,
                            down: n.parts.down.damage, jab: ROSTER.reese.jab.damage });
  })()`));
  assert.ok(d.down > d.level,
    "the aim that cannot touch anything airborne has to hit hardest, or " +
    "standing still on his floor is not a mistake; down " + d.down +
    " against level " + d.level);
  assert.ok(d.up >= d.level,
    "and the aim that cannot touch anything grounded may not ALSO be his " +
    "weakest hit; up " + d.up + " against level " + d.level);
  assert.equal(d.jab, 5,
    "and the jab did not move. It is 62.6% of his damage and one point on it " +
    "is worth more than everything on the list above put together, which is " +
    "why it is the lever and not a number anybody adjusts in passing. It is " + d.jab);
});
