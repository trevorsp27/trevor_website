/* COBEUS 2.85 -- THE TWO THINGS THAT WERE REPORTED BROKEN, AS ASSERTIONS.
 *
 * Both of them were reported as "it does not work", and in both cases the
 * simulation was already right and only the PICTURE was wrong. That is what
 * makes them one file: neither can be caught by reading a number off the
 * ROSTER, and both needed a test that asks what was actually painted.
 *
 * ONE -- "his sprite should get bigger with each eat". He already grew:
 * `absorb.fat` was 0.04, so sizeMul climbed 1.04, 1.08, 1.12, 1.16 and nobody
 * could argue with it. But drawFighter blits his cell at
 * `d = Math.round(16 * sizeMul)`, and what that rounds to over the first four
 * catches is 17, 17, 18, 19. Two of every four eats moved nothing on screen.
 * The fix is 1/16 -- 0.0625 -- because the cell is sixteen pixels wide:
 * `Math.round(16 * (1 + n/16))` is `16 + n` with no rounding left in it, and
 * the ladder becomes 16, 17, 18, 19, 20, 21, 22, 23, 24.
 *
 * So the assertion is NOT that sizeMul rises. sizeMul rose at 0.04 too, which
 * is exactly why the old step survived a full test suite. The assertion is
 * that the DRAWN RECT changes on every single catch, read off the drawImage
 * drawFighter actually issues, and its negative control is the old 0.04 put
 * back -- at which point three of the eight catches draw the identical rect
 * and the test fails.
 *
 * TWO -- "when he sleeps actually put him in the bed like he is sleeping".
 * drawBed has painted furniture and three Zs under him since 2.83 and
 * drawFighter blitted his ordinary STANDING cell on top, so three seconds of
 * punishment looked like a man standing bolt upright in the middle of a bed.
 * 2.85 swaps the body: drawSleeper paints a SLEEP_ROWS grid on his back, and
 * drawMouth returns on the same bedded() test so nothing is left painting the
 * standing cell's rows in the air above him.
 *
 * Asserted against what is painted rather than against which function ran.
 * The sleeper is a pixelArt grid, so its pixels really exist in the fillRects
 * that rasterized it, and the recording context below expands the blit back
 * out with the same nearest-neighbor mapping the real canvas uses. The
 * standing body is a PNG off his sheet and has no pixels to read here, so it
 * is caught the other way round: the blit that would have drawn it is a
 * SQUARE rect of side `round(16 * sizeMul)` whose bottom edge is his feet,
 * and the test is that no such rect is issued while he is in bed. Between the
 * two, "a standing man is not drawn and a lying one is" is a statement about
 * the canvas rather than about the call graph.
 *
 * Every test has a NEGATIVE CONTROL: the same checker run against a copy of
 * the engine with one thing changed in memory, and the check is that it then
 * fails. The mutants live in a string and a fresh vm and are never written
 * anywhere.
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
   interleaving, and therefore anything that averages over AI behavior,
   different on every run. Math remains the prototype. */
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
   reads back properties it sets, and a test cannot spy on a context that
   throws writes away.

   AND IT RECORDS ITS FILLRECTS. pixelArt rasterizes a grid one pixel at a
   time into a canvas of its own, so the only place the bed's pixels and the
   sleeper's pixels exist is in those calls. */
function stubContext(px) {
  return new Proxy({}, {
    get(target, key) {
      if (key === "fillRect" && px) {
        return (x, y, w, h) => {
          const col = target.fillStyle || "#000";
          for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) px.push([x + i, y + j, col]);
          }
        };
      }
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
    width: w, height: h, style: {}, __px: [],
    getContext: () => stubContext(el.__px),
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

/* One stretch of the engine, changed in memory. Never written to disk.

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

/* Two fighters on a stage, past the 110 frames of spawn invulnerability. */
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
    f.attackFrame = 0; f.chargeTimer = 0; f.specialSpawned = false;
    f.fat = 0; f.bedTimer = 0; f.buffTimer = 0; f.buffStats = null;
  });
  me.x = main.x + 90; me.facing = 1;
  foe.x = me.x + 90; foe.facing = -1; foe.invuln = 9999;`;

/* The recorder drawFighter is handed. Two lists, not one, and that is the
   whole design of it:

     `blits` is every drawImage AS ISSUED -- the destination rect and whether
     the image was a pixelArt canvas (which has pixels) or a sheet cell (which
     does not, here). The standing body is a sheet cell, so the only honest
     way to say "he was not drawn standing" is to say that no square rect of
     side `round(16 * sizeMul)` anchored on his feet was ever issued.

     `px` is every pixel that actually landed, from the fillRects that
     rasterized a pixelArt grid, expanded through the blit with the same
     nearest-neighbor mapping the real canvas uses. That is where the bed and
     the sleeper live, and it is what "he was drawn lying down" is read from.
     EACH PIXEL CARRIES THE INDEX OF THE BLIT IT CAME OUT OF, because the bed
     and the man in it are two grids drawn one after the other and three of
     his ten colors are the bed's own -- so "which pixels are him" is a
     question about which blit they landed in, not about what color they are.

   Nothing here writes to the fighter. */
const RECORDER = `
  function recorder() {
    var px = [], blits = [], sty = '#000';
    return {
      px: px, blits: blits,
      globalAlpha: 1, imageSmoothingEnabled: true, font: '', textAlign: '',
      get fillStyle() { return sty; },
      set fillStyle(v) { sty = v; },
      save: function () {}, restore: function () {}, translate: function () {},
      beginPath: function () {}, arc: function () {}, fill: function () {},
      stroke: function () {}, closePath: function () {}, moveTo: function () {},
      lineTo: function () {}, fillText: function () {}, clip: function () {},
      fillRect: function (x, y, w, h) {
        for (var i = 0; i < w; i++) {
          for (var j = 0; j < h; j++) px.push([x + i, y + j, sty, -1]);
        }
      },
      drawImage: function (img, dx, dy, dw, dh) {
        var W = img.width, H = img.height;
        if (dw === undefined) { dw = W; dh = H; }
        var src = img.__px;
        var bi = blits.length;
        blits.push({ x: dx, y: dy, w: dw, h: dh, grid: !!src });
        if (!src) return;
        for (var k = 0; k < src.length; k++) {
          var p = src[k];
          var x0 = Math.floor(p[0] * dw / W), x1 = Math.floor((p[0] + 1) * dw / W);
          var y0 = Math.floor(p[1] * dh / H), y1 = Math.floor((p[1] + 1) * dh / H);
          for (var Y = y0; Y < y1; Y++) {
            for (var X = x0; X < x1; X++) px.push([dx + X, dy + Y, p[2], bi]);
          }
        }
      },
    };
  }`;

/* =====================================================================
   1. EVERY EAT CHANGES THE DRAWN SIZE

   He casts for real, one pad through netplay, so `specialsNow` and the getter
   chain are whatever the engine decided rather than something assembled here.
   Only `fat` is driven by hand after that, because the question is the whole
   ladder and eating eight times for real is a different test (it is next
   door, in nerdwars-cobeus-mouth.test.js).

   drawFighter is then run for each fat, and what comes back is the rect it
   blitted his BODY with -- the square one anchored on his feet. That rect is
   the thing the player sees. sizeMul is reported beside it only so a failure
   can say which of the two moved.
   ===================================================================== */

const drawnLadder = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  ${RECORDER}
  netplay.active = true;
  netplay.framePads = [bitsToPad(2048), bitsToPad(0)];
  step();
  netplay.active = false; netplay.framePads = null;
  if (me.state !== 'special') throw new Error('he did not cast: ' + me.state);
  me.setState('idle'); me.attackFrame = 0; me.chargeTimer = 0;
  var m = me.specialsNow.up;
  var out = [];
  for (var n = 0; n <= m.absorb.bite; n++) {
    me.fat = n; me.bedTimer = 0;
    var r = recorder();
    drawFighter(r, me);
    /* His BODY, picked out of everything else drawFighter paints by the one
       property that is true of it and of nothing else: it is the square blit
       whose bottom edge is his feet. */
    var body = null;
    for (var i = 0; i < r.blits.length; i++) {
      var b = r.blits[i];
      if (b.w === b.h && b.y + b.h === Math.round(me.y)) body = b;
    }
    out.push({ fat: n, size: +me.sizeMul.toFixed(6),
               drawn: body ? body.w : -1,
               x: body ? body.x : 0, y: body ? body.y : 0 });
  }
  me.fat = 0;
  return JSON.stringify({ step: m.absorb.fat, bite: m.absorb.bite, rows: out });
})()`));

function checkEveryEatShows(r) {
  assert.equal(r.rows.length, r.bite + 1,
    "precondition: nought through `bite` catches, which is " + (r.bite + 1) +
    " sizes; the sweep had " + r.rows.length);
  assert.equal(r.rows[0].drawn, 16,
    "precondition: an unfed Cobeus is blitted at the ordinary 16-pixel cell; " +
    "he was " + r.rows[0].drawn);
  for (const row of r.rows) {
    assert.ok(row.drawn > 0,
      "precondition: a body was blitted at every fat -- if drawFighter stopped " +
      "drawing him this test would pass on an empty screen; at fat " + row.fat +
      " no square blit anchored on his feet was issued");
  }

  /* THE REGRESSION, as one sentence. This is not "he gets bigger" -- he got
     bigger at 0.04 too, and that is exactly why the old step survived a full
     suite. It is "EVERY eat gets bigger", measured on the rect. */
  for (let i = 1; i < r.rows.length; i++) {
    const was = r.rows[i - 1], now = r.rows[i];
    assert.ok(now.drawn > was.drawn,
      "EVERY CATCH HAS TO MOVE THE PICTURE. drawFighter blits his cell at " +
      "round(16 * sizeMul), so a step that is smaller than a sixteenth of the " +
      "cell rounds to the same number twice and the eat is invisible -- which " +
      "is what `fat` 0.04 did: 16, 17, 17, 18, 19, 19, 20, 20, 21, and two of " +
      "the first four catches changed nothing at all. Catch " + now.fat +
      " drew " + now.drawn + " pixels, the same as catch " + was.fat +
      " (sizeMul went " + was.size + " to " + now.size + ", so the SIMULATION " +
      "moved and only the drawing did not -- which is the whole shape of this " +
      "bug and the reason a sizeMul assertion cannot catch it)");
    assert.equal(now.drawn - was.drawn, 1,
      "and it moves by exactly one pixel, because 1/16 of a 16-pixel cell is " +
      "one pixel and there is no rounding left in round(16 * (1 + n/16)) at " +
      "all; catch " + now.fat + " jumped from " + was.drawn + " to " + now.drawn);
  }

  const last = r.rows[r.rows.length - 1];
  assert.equal(last.drawn, 16 + r.bite,
    "so the eighth catch is the base cell plus `bite` pixels -- 24 against " +
    "16; he was drawn at " + last.drawn);
  assert.equal(r.step, 1 / 16,
    "and the step is exactly a sixteenth, which is the only number that makes " +
    "the sentence above true on a 16-pixel cell; `absorb.fat` is " + r.step);

  /* HE GROWS UPWARD AND STAYS ON THE FLOOR. The blit anchors on his feet, so
     this is the drawing's half of the relBox clamp -- a body that grew about
     its center would rise off the stage as he ate. */
  for (const row of r.rows) {
    assert.equal(row.y + row.drawn, r.rows[0].y + 16,
      "and he grows UPWARD off his own feet rather than floating: every cell's " +
      "bottom edge is the same screen row. At fat " + row.fat + " it was " +
      (row.y + row.drawn) + " against " + (r.rows[0].y + 16));
  }
}

test("every eat changes the size he is DRAWN at, not just his sizeMul", async () => {
  const run = await arena(COBEUS, NICK);
  checkEveryEatShows(drawnLadder(run));
});

test("negative control: the old 0.04 step draws the same cell twice", async () => {
  /* The step exactly as 2.84 shipped it, and nothing else touched. sizeMul
     still rises on every catch -- 1.04, 1.08, 1.12, 1.16 -- and that is the
     point of this control: the simulation is fine and the picture is not. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.0625, bite: 8 },",
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.04, bite: 8 },") });
  expectToFail(() => checkEveryEatShows(drawnLadder(run)),
    "a sub-pixel step that draws 17, 17, 18, 19 should fail the every-eat " +
    "test; it passed");
});

test("negative control: a sizeMul assertion would have passed on the old step", async () => {
  /* Not a mutant -- the SHIPPED 2.84 step, checked the way it was checked
     before this file existed. The old engine passed every test it had, and
     this is why: `sizeMul` rises on all eight catches at 0.04. Any test
     written against the getter is green on a bug the player can see. It is
     here so that nobody rewrites the checker above in terms of sizeMul and
     quietly loses the only assertion that catches this. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.0625, bite: 8 },",
    "      absorb: { pad: 14, from: 6, to: 15, heal: 8, fat: 0.04, bite: 8 },") });
  const r = drawnLadder(run);
  for (let i = 1; i < r.rows.length; i++) {
    assert.ok(r.rows[i].size > r.rows[i - 1].size,
      "the old step really did raise sizeMul on every catch; at " + i +
      " it read " + r.rows[i].size);
  }
  const drawn = r.rows.map((x) => x.drawn);
  assert.deepEqual(drawn, [16, 17, 17, 18, 19, 19, 20, 20, 21],
    "and the DRAWN ladder it produced is the measurement this release is " +
    "answering; it was " + drawn.join(", "));
});

/* =====================================================================
   2. A BEDDED COBEUS IS DRAWN LYING DOWN

   Everything below reads one frame: `fat` at `bite`, `bedTimer` mid-bed, and
   the pin runSpecial holds him on. drawFighter is run whole, so the bed, the
   body and the mouth all go into the same recording and the question "what is
   on screen" has one answer.
   ===================================================================== */

const sleepFrame = (run, o) => JSON.parse(run(`(function () {
  ${SETUP}
  ${RECORDER}
  netplay.active = true;
  netplay.framePads = [bitsToPad(2048), bitsToPad(0)];
  step();
  netplay.active = false; netplay.framePads = null;
  if (me.state !== 'special') throw new Error('he did not cast: ' + me.state);
  var m = me.specialsNow.up;
  me.facing = ${o.facing || 1};
  me.fat = m.absorb.bite;
  me.bedTimer = ${o.bed === undefined ? "m.bed" : o.bed};
  me.attackFrame = m.startup + m.active;
  me.chargeTimer = 0;
  var bedded = !!me.bedded();
  var r = recorder();
  drawFighter(r, me);
  var d = Math.round(16 * me.sizeMul);
  /* Everything is reported in the fighter's own frame, so an assertion can
     say "above his feet" and "in front of his center" without knowing where
     on the stage he stood. */
  var fx = Math.round(me.x), fy = Math.round(me.y);
  var px = r.px.map(function (p) { return [p[0] - fx, p[1] - fy, p[2], p[3]]; });
  var blits = r.blits.map(function (b) {
    return { x: b.x - fx, y: b.y - fy, w: b.w, h: b.h, grid: b.grid };
  });
  me.fat = 0; me.bedTimer = 0;
  return JSON.stringify({ bedded: bedded, d: d, bed: m.bed, shrink: m.shrink,
                          size: +me.sizeMul.toFixed(4), px: px, blits: blits });
})()`));

/* The colors SLEEP_PAL is built from, and every one of them is a color the
   file already owned before this pass: four off CobeusSpriteSheet.png, his
   shoe gray off row 15 of every cell of it, the hole off his own trousers --
   the same single declared exception MOUTH_PAL.H is -- and three straight off
   BED_PAL. Written out here rather than read from the engine, because the
   claim is about HIS palette and a test that reads the palette it is checking
   asserts nothing. */
const HAIR = "#231C03", HAIR_MID = "#433608", SKIN = "#F0E3CF",
      SKIN_SHADOW = "#DAC8AB", PUPIL = "#3D320E", SHOE = "#7F7E7F",
      HOLE = "#080420";
const BLANKET = "#7c5aa8", SHEET = "#f2ece0", FOLD = "#3a2c1c";
const MATTRESS = "#8a6a45";

const up = (s) => s.toUpperCase();
const SLEEP_COLORS = {};
for (const c of [HAIR, HAIR_MID, SKIN, SKIN_SHADOW, PUPIL, SHOE, HOLE,
                 BLANKET, SHEET, FOLD]) SLEEP_COLORS[up(c)] = 1;
/* The seven that are HIS. Three of SLEEP_PAL's ten are the bed's own -- which
   is the point of them, the covers over him are the bed's covers -- so a
   color test alone cannot tell the man from the furniture he is lying on.
   These seven can: not one of them appears in BED_PAL. */
const HIS_COLORS = {};
for (const c of [HAIR, HAIR_MID, SKIN, SKIN_SHADOW, PUPIL, SHOE, HOLE])
  HIS_COLORS[up(c)] = 1;

/* HIM, PICKED OUT OF THE RECORDING. Every pixel knows which blit it came out
   of, so the man is the blit with a man in it: the one grid carrying any of
   the seven colors that are his and nobody else's. Asserted to be exactly
   one, because none means he was not drawn at all and two means he was drawn
   twice, and both of those are failures this file exists to name rather than
   to average over. */
function sleeperPixels(r) {
  const his = new Set();
  for (const p of r.px) if (p[3] >= 0 && HIS_COLORS[up(p[2])]) his.add(p[3]);
  assert.equal(his.size, 1,
    "exactly one blit in the whole frame has a man in it -- none means he " +
    "was not drawn and two means he was drawn twice; " + his.size + " did");
  const bi = [...his][0];
  return r.px.filter((p) => p[3] === bi);
}

function checkHeIsLyingDown(r) {
  assert.equal(r.bedded, true,
    "precondition: he is actually bedded on this frame");
  assert.equal(r.d, 24,
    "precondition: and at maximum fat, where the cell would be 24 pixels -- " +
    "he is only ever bedded at `bite`, so that is the only size the sleeper " +
    "is drawn at outside the shrink; the cell would have been " + r.d);

  /* THE COMPLAINT, AS AN ASSERTION. drawFighter blits his standing cell as a
     SQUARE of side round(16 * sizeMul) with its bottom edge on his feet, and
     that is the one blit in the whole function with both properties. While he
     is in bed there must not be one. */
  const standing = r.blits.filter((b) => b.w === b.h && b.w === r.d && b.y + b.h === 0);
  assert.equal(standing.length, 0,
    "A BEDDED COBEUS IS NOT BLITTED STANDING UP. That is the whole of the " +
    "complaint: drawBed has painted furniture under him since 2.83 and the " +
    "man on top of it was still the ordinary standing cell, so three seconds " +
    "of punishment read as a man stood bolt upright in the middle of a bed. " +
    "A " + r.d + "x" + r.d + " blit anchored on his feet was issued " +
    standing.length + " time(s)");

  /* AND SOMETHING IS DRAWN INSTEAD, which is the other half and needs saying
     separately: a body that is simply skipped is also not standing. */
  const sleeper = sleeperPixels(r);
  assert.ok(sleeper.length > 0,
    "and a BODY is drawn in its place rather than the branch just skipping " +
    "him -- a man deleted from his own bed is not a man asleep in it; " +
    "nothing in SLEEP_PAL's colors was painted");

  const xs = sleeper.map((p) => p[0]), ys = sleeper.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;

  /* HE IS HORIZONTAL. A standing Cobeus is a 24x24 square; the thing on the
     mattress has to be wider than it is tall by a margin no rounding can
     produce. */
  assert.ok(w >= h * 2,
    "he reads as HORIZONTAL: what is painted spans " + w + " by " + h +
    ", and a man standing up is " + r.d + " by " + r.d + ". A sleeper that " +
    "is not at least twice as wide as it is tall is a man sitting up in bed");

  /* AND HE IS ON THE MATTRESS RATHER THAN ON THE FLOOR OR IN THE AIR.
     drawBed's own pixels say where the mattress is, so this is read off the
     furniture rather than off a number written down here -- which is the same
     reason the mouth test reads his eye columns off his sheet. */
  const mattress = r.px.filter((p) => up(p[2]) === up(BLANKET) ||
                                      up(p[2]) === up(MATTRESS));
  assert.ok(mattress.length > 0,
    "precondition: the bed is drawn under him, so there is a mattress to be " +
    "lying on");
  const bedTop = Math.min(...mattress.map((p) => p[1]));
  const bedBottom = Math.max(...mattress.map((p) => p[1]));
  assert.ok(y1 < 0,
    "every pixel of him is ABOVE his feet -- he is on the bed, not on the " +
    "floor beside it; the lowest ran to " + y1);
  assert.ok(y1 <= bedBottom && y0 >= bedTop - h,
    "and he is IN the bed rather than floating over it: the bed's own " +
    "painted rows run " + bedTop + " to " + bedBottom + " and he runs " +
    y0 + " to " + y1);

  /* HIS EYE IS SHUT. One pixel of his own pupil color where a pupil goes is
     what "asleep" is made of at this size -- it is the move MOUTH_ROWS.Z0
     used to make on row 6 and it is the reason that cell could be retired
     rather than simply dropped. */
  assert.ok(sleeper.some((p) => up(p[2]) === up(PUPIL)),
    "and his EYE IS SHUT: one pixel of his own pupil color (" + PUPIL + ") " +
    "in the head end. A sleeper with his eyes open is the reason turning his " +
    "standing cell ninety degrees was thrown away");
  assert.ok(!sleeper.some((p) => up(p[2]) === "#FFFFFF"),
    "and not one white eye pixel survives anywhere on him -- a shut eye that " +
    "still has a white in it is a man squinting at you");

  /* EVERY COLOR IS ONE THE FILE ALREADY OWNED. Same rule the mouth is held
     to: an invented color is how the drawing this replaced went wrong. */
  for (const p of sleeper) {
    assert.ok(SLEEP_COLORS[up(p[2])],
      "every pixel of him is a color the file already owns -- four off his " +
      "sheet, his shoe gray, the hole off his own trousers and three off " +
      "BED_PAL; " + p[2] + " is not one of them");
  }
  assert.ok(sleeper.some((p) => up(p[2]) === up(BLANKET)),
    "and the covers over him are the BED'S OWN purple rather than a second " +
    "purple that nearly matches it, which is what makes them read as the " +
    "bed's covers rather than as a blanket he brought with him");
}

test("a bedded Cobeus is drawn lying in the bed, not standing in it", async () => {
  const run = await arena(COBEUS, NICK);
  checkHeIsLyingDown(sleepFrame(run, {}));
});

test("and facing the other way, with the pillow at the other end", async () => {
  const run = await arena(COBEUS, NICK);
  checkHeIsLyingDown(sleepFrame(run, { facing: -1 }));
});

test("negative control: 2.84's body, blitted standing in the middle of the bed", async () => {
  /* The branch taken out, which is 2.84 exactly: the bed is painted, the Zs
     rise, and drawFighter blits his ordinary standing cell on top of it. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  } else if (f.bedded()) {", "  } else if (false) {") });
  expectToFail(() => checkHeIsLyingDown(sleepFrame(run, {})),
    "a standing man blitted in the middle of a bed should fail the lying-down " +
    "test; it passed");
});

test("negative control: a sleeper drawn as well as the body, not instead of it", async () => {
  /* The mistake that is easier to make than leaving it alone: draw the grid
     and forget to stop the blit. The bed then has a man asleep in it AND a
     man stood up in it, which is the original bug with an extra drawing on
     top -- and the horizontal test alone would not catch it, because the
     sleeper is still there and still horizontal. The standing-blit assertion
     is what does. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "    drawSleeper(g, f, f.bedded());\n  } else {",
    "    drawSleeper(g, f, f.bedded());\n" +
    "    const dd = Math.round(16 * f.sizeMul);\n" +
    "    g.drawImage(im, x + 8 - (dd >> 1), y + 16 - dd, dd, dd);\n  } else {") });
  expectToFail(() => checkHeIsLyingDown(sleepFrame(run, {})),
    "a sleeper drawn on top of a standing body should fail the lying-down " +
    "test; it passed");
});

/* =====================================================================
   3. AND HE IS NOT A PHOTOGRAPH FOR THREE SECONDS

   The mouth set was redrawn once already because a cell keyed to a frozen
   counter is a still picture for as long as the freeze lasts. The bed is a
   hundred and eighty frames of exactly that kind of freeze -- attackFrame is
   pinned at `startup + active` for all of it -- so a sleeping pose that does
   not move is the same mistake at six times the length.

   Four phases, twelve frames each. The HEAD does not move; the covers over
   his belly and the hole in his face do, which is what makes them read as a
   chest rather than as a shape that wobbles. Both inputs are snapshotted, so
   there is a rollback assertion here too: the same bedTimer has to give the
   same picture, every time, from any starting point.
   ===================================================================== */

const theBreath = (run) => JSON.parse(run(`(function () {
  ${SETUP}
  ${RECORDER}
  netplay.active = true;
  netplay.framePads = [bitsToPad(2048), bitsToPad(0)];
  step();
  netplay.active = false; netplay.framePads = null;
  var m = me.specialsNow.up;
  me.facing = 1; me.fat = m.absorb.bite;
  me.attackFrame = m.startup + m.active; me.chargeTimer = 0;
  var fx = Math.round(me.x), fy = Math.round(me.y);
  function shot(bt) {
    me.bedTimer = bt;
    var r = recorder();
    drawSleeper(r, me, me.bedded());
    var print = r.px.map(function (p) {
      return (p[0] - fx) + ',' + (p[1] - fy) + ',' + p[2].toUpperCase();
    }).sort().join(' ');
    /* HIS SKULL, on its own. Not a column slice -- his HAIR, by color, which
       is the part of him the four phases are authored never to move. A
       sleeper whose head travels is a man nodding, which is a different
       drawing and a worse one. */
    var hair = r.px.filter(function (p) {
      var c = p[2].toUpperCase();
      return c === '#231C03' || c === '#433608';
    }).map(function (p) { return (p[0] - fx) + ',' + (p[1] - fy); }).sort().join(' ');
    /* And the hole in his face, which is the thing up there that DOES move:
       shut on the out-breath, one column rising, two at the top of the
       inhale. Counted rather than printed, because what it has to do is open
       and shut rather than merely differ. */
    var hole = r.px.filter(function (p) {
      return p[2].toUpperCase() === '#080420';
    }).length;
    return { bt: bt, phase: sleepPhase(me, me.bedded()), print: print,
             hair: hair, hole: hole, n: r.px.length };
  }
  var frames = [];
  for (var bt = m.bed; bt > m.shrink; bt--) frames.push(shot(bt));
  /* AND THE SAME FRAME REACHED FROM SOMEWHERE ELSE. The breath is derived
     from bedTimer and a ROSTER number, both snapshotted, so a rewind to any
     frame has to reproduce it exactly. Drawn again after the whole sweep, in
     a different order, which is what a rollback amounts to here. */
  var replay = [shot(m.bed - 7), shot(m.bed - 40), shot(m.bed - 7)];
  me.fat = 0; me.bedTimer = 0;
  return JSON.stringify({ bed: m.bed, shrink: m.shrink, frames: frames,
                          replay: replay });
})()`));

function checkHeBreathes(r) {
  assert.equal(r.frames.length, r.bed - r.shrink,
    "precondition: every frame of the bed before the shrink starts, which is " +
    (r.bed - r.shrink) + "; the sweep had " + r.frames.length);
  for (const f of r.frames) {
    assert.ok(f.n > 0, "precondition: something is painted on bedTimer " + f.bt);
  }

  const prints = new Set(r.frames.map((f) => f.print));
  assert.equal(prints.size, 3,
    "HE BREATHES. Four authored phases, and phases 1 and 3 are the same cell " +
    "drawn on the way up and on the way down, so three distinct pictures is " +
    "what an even beat looks like. A hundred and eighty frames of ONE picture " +
    "is the mistake the mouth set was redrawn to answer, at six times the " +
    "length; it drew " + prints.size + " distinct pictures");

  /* AND IT IS THE COVERS AND HIS MOUTH THAT MOVE, NOT HIS HEAD. The covers
     only read as a chest because the head they are attached to is still. */
  const heads = new Set(r.frames.map((f) => f.hair));
  assert.equal(heads.size, 1,
    "HIS HEAD NEVER MOVES. Every pixel of his hair is in the same place on " +
    "every frame of the bed, which is what makes the covers read as a chest " +
    "rather than as a shape that wobbles; it took " + heads.size + " positions");
  const holes = [...new Set(r.frames.map((f) => f.hole))].sort((a, b) => a - b);
  assert.ok(holes.length >= 3 && holes[0] === 0,
    "and his MOUTH opens and shuts on the same beat -- shut on the " +
    "out-breath, one column rising, two at the top of the inhale. The hole " +
    "took these pixel counts across the bed: " + holes.join(", "));

  /* Runs: no phase may be held long enough to read as a still. */
  let len = 1;
  const runs = [];
  for (let i = 1; i < r.frames.length; i++) {
    if (r.frames[i].print !== r.frames[i - 1].print) { runs.push(len); len = 1; }
    else len++;
  }
  runs.push(len);
  for (const n of runs) {
    assert.ok(n <= 12,
      "no phase is held for more than twelve frames -- a fifth of a second, " +
      "which is the beat the four cells were authored on; the runs were " +
      runs.join(", "));
  }
  assert.ok(runs.length >= 12,
    "and the beat runs right through the bed rather than stopping partway: " +
    "twelve frames a phase over " + (r.bed - r.shrink) + " is at least twelve " +
    "changes; there were " + runs.length);

  /* THE ROLLBACK HALF. Same bedTimer, same picture, whatever order it was
     reached in -- which is what makes this safe to derive from bedTimer
     rather than from a counter of its own. */
  assert.equal(r.replay[0].print, r.replay[2].print,
    "the same bedTimer draws the same frame however it was arrived at, " +
    "because the phase is derived from bedTimer and a ROSTER number and both " +
    "are in the snapshot. A breath counted on a field of its own would " +
    "restart on every rewind");
  assert.notEqual(r.replay[0].print, r.replay[1].print,
    "precondition: and the two bedTimers compared really are different " +
    "frames of the breath, or the line above passes on a still picture");
}

test("the sleeper breathes, and the same frame replays identically", async () => {
  const run = await arena(COBEUS, NICK);
  checkHeBreathes(theBreath(run));
});

test("negative control: one phase for the whole bed is a photograph", async () => {
  /* The obvious build: pick a cell and draw it for three seconds. Everything
     else is identical -- same grid, same anchor, same palette -- and the man
     in the bed is a still picture, which is what the mouth looked like before
     it was fixed. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  return (((m.bed || 0) - f.bedTimer) / 12 | 0) % 4;",
    "  return 0;") });
  expectToFail(() => checkHeBreathes(theBreath(run)),
    "a sleeper frozen on one phase should fail the breath test; it passed");
});

test("negative control: a breath counted off battleFrames does not survive a rewind", async () => {
  /* The phase driven by the global frame counter instead of by bedTimer. It
     LOOKS identical in motion -- same four cells, same twelve-frame beat --
     and it is wrong for the one reason this file cares about: battleFrames is
     not what a rollback restores this drawing to. Re-reading the same
     bedTimer after the sweep then gives a different picture, which is a
     desync you can see. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  return (((m.bed || 0) - f.bedTimer) / 12 | 0) % 4;",
    "  return ((battleFrames / 12 | 0) + (m.bed ? 0 : 0)) % 4;") });
  expectToFail(() => checkHeBreathes(theBreath(run)),
    "a breath that does not replay from bedTimer should fail the rollback " +
    "clause; it passed");
});

/* =====================================================================
   4. AND HE SETTLES INTO IT

   `shrink` eases sizeMul back over the last twenty frames so he stands up
   rather than snapping. It was worth less than it looks at 0.04 -- the last
   twenty frames drew 21, 20, 19, 17, 16 -- and at 0.0625 it is 24, 22, 20,
   18, 16. The sleeper scales with him, so what that ramp does now is a man
   visibly deflating into the bed before he gets up out of it.
   ===================================================================== */

test("he deflates into the bed over the shrink rather than popping", async () => {
  const run = await arena(COBEUS, NICK);
  const seen = [];
  for (let bt = 20; bt >= 1; bt--) {
    const f = sleepFrame(run, { bed: bt });
    const sleeper = sleeperPixels(f);
    const xs = sleeper.map((p) => p[0]), ys = sleeper.map((p) => p[1]);
    seen.push({ bt, w: Math.max(...xs) - Math.min(...xs) + 1,
                h: Math.max(...ys) - Math.min(...ys) + 1,
                bottom: Math.max(...ys), left: Math.min(...xs) });
  }
  const widths = [...new Set(seen.map((s) => s.w))];
  assert.ok(widths.length >= 4,
    "the sleeper shrinks with him in visible steps rather than holding one " +
    "size and popping on the frame he stands up; it took " + widths.length +
    " distinct widths across the twenty (" + widths.join(", ") + ")");
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].w <= seen[i - 1].w,
      "and it only ever goes DOWN; at bedTimer " + seen[i].bt + " it was " +
      seen[i].w + " against " + seen[i - 1].w);
  }
  /* AND HE STAYS ON THE SHEETS WHILE HE DOES IT, which is the whole reason
     the sleeper has an anchor of its own: drawFighter's blit pins a cell's
     BOTTOM to the feet, and a grid anchored that way would drift clear of the
     mattress as he shrank. */
  const bottoms = new Set(seen.map((s) => s.bottom));
  assert.equal(bottoms.size, 1,
    "his BACK stays welded to the mattress through all twenty frames -- the " +
    "sleeper is anchored on his back and his head end, not on a pair of feet " +
    "he is not standing on. The bottom edge took " + bottoms.size +
    " values: " + [...bottoms].join(", "));
  const lefts = new Set(seen.map((s) => s.left));
  assert.equal(lefts.size, 1,
    "and his head stays on the pillow: the head end is pinned to the " +
    "headboard rail, so shrinking carries him UP the bed rather than " +
    "sliding him along it. The left edge took " + [...lefts].join(", "));
});

test("negative control: anchored the way a standing body is, he lifts off the bed", async () => {
  /* The sleeper hung off its TOP instead of off his back, which is the shape
     of the giant-Simon regression relBox's clamp exists because of, translated
     into a drawing: a body whose anchor is not the edge it rests on drifts off
     that edge the moment it changes size. He lifts clear of the mattress over
     the twenty frames of the shrink and finishes the bed hovering above the
     sheets. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  g.drawImage(art, left, Math.round(f.y) - 5 - h, w, h);",
    "  g.drawImage(art, left, Math.round(f.y) - 13, w, h);") });
  const seen = [];
  for (let bt = 20; bt >= 1; bt--) {
    const f = sleepFrame(run, { bed: bt });
    const sleeper = sleeperPixels(f);
    seen.push(Math.max(...sleeper.map((p) => p[1])));
  }
  expectToFail(() => {
    assert.equal(new Set(seen).size, 1,
      "the bottom edge moved: " + [...new Set(seen)].join(", "));
  }, "a sleeper anchored on his feet should fail the welded-to-the-mattress " +
     "clause; it passed");
});
