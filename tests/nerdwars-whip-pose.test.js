/* THE WHIP'S POSE TABLE, and nothing else about the whip.
 *
 * 2.81 changed the DRAWING and not one number of the move. The hitbox is
 * still ox 4, w 40, oy -11, h 9 and the sweet spot still starts at 22, so
 * nerdwars-whip.test.js -- which pins the picture against that box from
 * every side -- passes unedited and is the guarantee that this pass was
 * cosmetic. What it cannot see is the thing that was wrong.
 *
 * WHAT WAS WRONG. The `ey` column on rows 14 to 18 read -9, -18, -6, -13, -8
 * inside a box whose band is y -15.5 to -6.5. The tip therefore flicked up
 * and down FOUR times across the six frames the move can hurt you, and left
 * the band twice -- and at sixty frames a second, four reversals in a tenth
 * of a second do not read as a whip cracking, they read as a drawing that
 * cannot decide where it is. A whip is a fold running out of whip, which is
 * one motion in one direction, and that is what the two tests here pin:
 *
 *   The tip walks DOWN the middle of the band, once, with zero sign changes
 *   in its vertical motion and one in its forward motion -- at k16, the frame
 *   it stops travelling and starts laying down, which is the move itself.
 *
 *   And the frame the box goes away looks like the frame the box goes away.
 *   Row 19's `ex` was 41 against the last live frame's 43, so the picture
 *   retreated ONE painted pixel on the frame the whip stopped being
 *   dangerous. It is 35 now, which is seven.
 *
 * Both are read by walking the pose table exactly the way drawWhipArt walks
 * it -- the same cubic, the same fold reflection, the same gap push and the
 * same clamp to `s.reach` -- because the tip is the last point of that walk
 * and there is no other way to ask where it is. The second one is read off a
 * recording canvas instead, because "what was painted" is a question about
 * rectangles.
 *
 * Every test has a NEGATIVE CONTROL: the same checker against a copy of the
 * engine with one line changed in memory, and the check is that the same
 * assertions then fail. The mutated copies live in a string and a fresh vm
 * and are never written anywhere.
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
const SQUALLS = 8, REESE = 4;

const whipSpec = (run) =>
  JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.up)"));

/* WHERE THE TIP IS ON EACH FRAME, walked the way the drawing walks it.

   This is a copy of drawWhipArt's sampler and it has to be, because the tip
   is not in the pose table: `ex, ey` is the NOSE of the lay, and while a fold
   is out the tip is somewhere back down the curve behind it. The last point
   of the walk is the tip, which is also the point drawWhipArt paints the knot
   of halo on. Copying the arithmetic is the only way to read it without
   asking the drawing to hand back a number it has no reason to expose.

   Read at kf + 1, because that is what the drawing does: the pose table is
   consulted a frame ahead so the lash lines up with the box rather than
   trailing it. */
const TIP = `
window.__tip = function (kk, reach) {
  var i = 0;
  while (i < WHIP_POSE.length - 1 && WHIP_POSE[i + 1][0] < kk) i++;
  var a = WHIP_POSE[i], b = WHIP_POSE[Math.min(i + 1, WHIP_POSE.length - 1)];
  var span = b[0] - a[0], q = span > 0 ? (kk - a[0]) / span : 0;
  var c1x = a[1] + (b[1] - a[1]) * q, c1y = a[2] + (b[2] - a[2]) * q;
  var c2x = a[3] + (b[3] - a[3]) * q, c2y = a[4] + (b[4] - a[4]) * q;
  var ex = a[5] + (b[5] - a[5]) * q, ey = a[6] + (b[6] - a[6]) * q;
  var fold = a[7] + (b[7] - a[7]) * q, gap = a[8] + (b[8] - a[8]) * q;
  var X = 0, Y = 0;
  for (var j = 0; j <= WHIP_STEPS; j++) {
    var u = j / WHIP_STEPS;
    var t = (u <= fold ? u : 2 * fold - u) / fold;
    if (t < 0) t = 0;
    var m = 1 - t, m2 = m * m, t2 = t * t;
    var px = m2 * m * 3 + 3 * m2 * t * c1x + 3 * m * t2 * c2x + t2 * t * ex;
    var py = m2 * m * -9 + 3 * m2 * t * c1y + 3 * m * t2 * c2y + t2 * t * ey;
    if (u > fold) { var d = (u - fold) / 0.11; py += gap * (d < 1 ? d : 1); }
    var fwd = Math.round(px);
    if (fwd > reach) fwd = reach;
    X = fwd; Y = Math.round(py);
  }
  return [X, Y];
};`;

const tips = (run) => {
  const s = whipSpec(run);
  run(TIP);
  const reach = s.ox + s.w;
  const total = s.startup + s.active + s.recovery;
  const out = [];
  for (let k = 1; k <= total; k++) {
    const kk = Math.min(k + 1, total);
    out.push({ k, p: JSON.parse(run("JSON.stringify(__tip(" + kk + "," + reach + "))")) });
  }
  return out;
};

/* What was actually PAINTED, per frame, off a recording context. Everything
   in this drawing is fillStyle and fillRect, so this is not an approximation
   of the picture -- it is the picture.

   drawWhipArt rather than drawWhip, so the frame number can be handed over
   directly instead of being driven to through sixty frames of a real cast.
   The spec object is assembled here exactly as drawWhip assembles it, off the
   MOVE, so a retune of the box moves this with it. */
const painted = (run) => {
  const s = whipSpec(run);
  const total = s.startup + s.active + s.recovery;
  return JSON.parse(run(`(function () {
    var S = ROSTER.squalls.specials.up;
    var spec = { startup: S.startup, active: S.active, recovery: S.recovery,
                 near: S.ox, reach: S.ox + S.w, midY: S.oy,
                 sweetFrom: (S.sweet && S.sweet.from) || S.ox + S.w };
    var out = [];
    for (var k = 1; k <= ${total}; k++) {
      var rects = [], sty = '#000';
      var rec = { globalAlpha: 1,
        get fillStyle() { return sty; }, set fillStyle(v) { sty = v; },
        fillRect: function (x, y, w, h) { rects.push([x, y, w, h]); } };
      drawWhipArt(rec, 0, 0, 1, k, spec);
      var far = -9999;
      for (var j = 0; j < rects.length; j++) {
        var hi = rects[j][0] + rects[j][2] - 1;
        if (hi > far) far = hi;
      }
      out.push({ k: k, n: rects.length, far: rects.length ? far : null });
    }
    return JSON.stringify(out);
  })()`));
};

/* =====================================================================
   1. THE TIP DOES NOT WOBBLE
   ===================================================================== */

function checkNoWobble(s, rows) {
  const lo = s.oy - s.h / 2, hi = s.oy + s.h / 2;
  const live = rows.filter((r) => r.k >= s.startup && r.k < s.startup + s.active);
  assert.equal(live.length, s.active,
    "precondition: the move has `active` (" + s.active + ") frames that can " +
    "hurt you; the walk found " + live.length);

  /* (a) One direction, all the way down. A fold running out of whip is one
     motion; the shipping table reversed four times inside a tenth of a
     second. Zero sign changes, not "few". */
  const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  let last = 0, flips = 0;
  const dys = [];
  for (let i = 1; i < live.length; i++) {
    const d = live[i].p[1] - live[i - 1].p[1];
    dys.push(d);
    const sg = sign(d);
    if (sg !== 0) { if (last !== 0 && sg !== last) flips++; last = sg; }
  }
  assert.equal(flips, 0,
    "the tip may not change vertical direction inside the live window -- a " +
    "whip is a fold running out of whip, which is one motion; it went " +
    dys.join(", ") + " and turned round " + flips + " times");
  assert.ok(last > 0,
    "and the direction it goes is DOWN, which is the lash landing; it went " +
    dys.join(", "));

  /* (b) Inside the band on every live frame. The band is the hitbox's own,
     read off the move, so a retune of `oy` or `h` moves this with it. */
  for (const r of live) {
    assert.ok(r.p[1] >= lo && r.p[1] <= hi,
      "every live frame's tip belongs inside the box's own band (" + lo +
      " to " + hi + "); on k" + r.k + " it was at y " + r.p[1]);
  }

  /* (c) It advances, then it stops. One sign change in the forward motion
     and it is the frame it stops travelling and starts laying down; what is
     forbidden is going forward again after stopping, which is a tip that
     bounces. */
  let seenBack = false, bounced = 0;
  const dxs = [];
  for (let i = 1; i < live.length; i++) {
    const d = live[i].p[0] - live[i - 1].p[0];
    dxs.push(d);
    if (d < 0) seenBack = true;
    else if (d > 0 && seenBack) bounced++;
  }
  assert.equal(bounced, 0,
    "and once the tip has stopped advancing it does not advance again; the " +
    "forward steps were " + dxs.join(", "));
}

test("the tip does not wobble", async () => {
  const run = await arena(SQUALLS, REESE);
  checkNoWobble(whipSpec(run), tips(run));
});

test("negative control: the shipping ey column fails the wobble test", async () => {
  /* The six rows as 2.80 shipped them, and nothing else. The box does not
     move, the reach does not move, the sweet spot does not move -- the shipped
     whip test passes against this copy too, which is exactly why it needed a
     second one. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "  [ 13,    16, -22,    33, -21,   45, -17, 0.86,   4, 0.00 ],\n" +
    "  [ 14,    14, -20,    34, -18,   45, -15, 1.00,   3, 0.00 ],\n" +
    "  [ 15,    14, -18,    34, -16,   45, -13, 1.00,   3, 0.00 ],\n" +
    "  [ 16,    14, -17,    34, -14,   44, -11, 1.00,   3, 0.00 ],\n" +
    "  [ 17,    13, -15,    33, -12,   43,  -9, 1.00,   2, 0.00 ],\n" +
    "  [ 18,    13, -14,    32, -11,   42,  -8, 0.98,   2, 0.00 ],",
    "  [ 13,    16, -21,    33, -20,   45, -13, 0.86,   5, 0.00 ],\n" +
    "  [ 14,    11, -20,    31, -18,   44,  -9, 1.00,   3, 0.00 ],\n" +
    "  [ 15,    13, -18,    46, -15,   43, -18, 1.00,   3, 0.00 ],\n" +
    "  [ 16,    13, -16,    46, -12,   44,  -6, 1.00,   3, 0.00 ],\n" +
    "  [ 17,    13, -15,    34, -15,   44, -13, 1.00,   3, 0.00 ],\n" +
    "  [ 18,    12, -12,    33,  -9,   42,  -8, 0.96,   2, 0.00 ],") });
  expectToFail(() => checkNoWobble(whipSpec(run), tips(run)),
    "the zigzag column should fail the wobble test; it passed");
});

/* =====================================================================
   2. THE FRAME THE BOX GOES AWAY LOOKS LIKE IT
   ===================================================================== */

/* The break. `active` is six frames and then the whip cannot touch anybody,
   and a player standing at tip range has to be able to SEE that happen --
   otherwise the picture at its most dangerous and the picture at its most
   harmless are the same picture one frame apart. */
function checkTheBreak(s, rows) {
  const lastLive = rows.find((r) => r.k === s.startup + s.active - 1);
  const firstDead = rows.find((r) => r.k === s.startup + s.active);
  assert.ok(lastLive && lastLive.far !== null,
    "precondition: the last live frame paints something");
  assert.ok(firstDead && firstDead.far !== null,
    "precondition: the first dead frame paints something -- an empty hand is " +
    "its own bug and the shipped whip test owns it");
  const retreat = lastLive.far - firstDead.far;
  assert.ok(retreat >= 5,
    "the frame the box goes away should pull the painted tip back at least " +
    "five pixels, or the whip is drawn at full stretch on a frame it cannot " +
    "reach anybody; it went " + lastLive.far + " -> " + firstDead.far +
    ", a retreat of " + retreat);
}

test("the frame the box goes away looks like it", async () => {
  const run = await arena(SQUALLS, REESE);
  checkTheBreak(whipSpec(run), painted(run));
});

test("negative control: row 19 at ex 41 fails the break test", async () => {
  /* One number on one row -- the first DEAD frame's nose, back where it was.
     Measured: the painted far edge goes 43 -> 42 instead of 43 -> 36, so the
     whip stands at full stretch on the frame it stopped being dangerous. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "  [ 19,    13, -12,    29,  -9,   35,  -6, 0.95,  -2, 0.00 ],",
    "  [ 19,    13, -12,    32,  -8,   41,  -7, 0.95,  -2, 0.00 ],") });
  expectToFail(() => checkTheBreak(whipSpec(run), painted(run)),
    "a whip still at full stretch on the first dead frame should fail the " +
    "break test; it passed");
});

/* =====================================================================
   3. AND THE BOX DID NOT MOVE
   ===================================================================== */

/* The whole claim of this pass, as one assertion. If any of these five
   numbers ever changes, the two tests above are measuring a different move
   and the ladder is no longer allowed to come back byte-identical. */
test("not one number of the move moved", async () => {
  const run = await arena(SQUALLS, REESE);
  const s = whipSpec(run);
  assert.equal(s.kind, "whip");
  assert.deepEqual(
    { startup: s.startup, active: s.active, recovery: s.recovery,
      ox: s.ox, oy: s.oy, w: s.w, h: s.h, sweetFrom: s.sweet.from,
      damage: s.damage, sweetDamage: s.sweet.damage, mana: s.mana },
    { startup: 12, active: 6, recovery: 14,
      ox: 4, oy: -11, w: 40, h: 9, sweetFrom: 22,
      damage: 8, sweetDamage: 16, mana: 20 },
    "2.81's whip pass is ANIMATION ONLY. Every number here is 2.80's, and " +
    "the reason they are written out as literals rather than derived is that " +
    "this is the assertion that says the drawing changed and the move did not");
});
