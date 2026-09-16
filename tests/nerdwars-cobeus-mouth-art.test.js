/* OPEN WIDE -- the DRAWING, and nothing about the move.
 *
 * 2.82 changed drawMouth and not one number of the special, so
 * nerdwars-cobeus-mouth.test.js -- which pins the catch, the flat heal, the
 * stock and the fat -- passes unedited and is the guarantee that this pass
 * was cosmetic. What it cannot see is the thing that was wrong.
 *
 * WHAT WAS WRONG. drawFighter blits the 16x16 cell with its TOP-LEFT at
 * (round(f.x) - 8, round(f.y) - 16), so CELL ROW r lands on screen row
 * f.y - 16 + r. The mouth was drawn at f.y - 13 * sk, which is CELL ROW 3,
 * and its tall rect ran from y-3 to y+2 -- CELL ROWS 0 THROUGH 5. His hair is
 * rows 0 to 3; his face does not begin until row 4 and his chin is row 7. So
 * the pale 4x1 "lip" landed on ROW 0, the crown of his head, and horizontally
 * f.x + facing * 2 is col 10, off his center and a pixel past his silhouette,
 * which is why it also swallowed an eye. It was never an ugly mouth. It was a
 * dark blob on his hair, four rows above where a mouth goes.
 *
 * So the first test here is that sentence as an assertion, and it is the only
 * one that really matters: NOTHING THIS FUNCTION PAINTS INSIDE HIS CELL MAY
 * LAND ABOVE ROW 7. Its negative control is the 2.81 drawing itself, restored
 * at its own f.y - 13 anchor, and the control is that this test then fails.
 *
 * The other three pin the rules the new set is built on:
 *
 *   ROWS 4, 5 AND 6 ARE HIS. His brow, his two #FFFFFF eye whites and his two
 *   #3D320E pupils are what is left of Cobeus at sixteen pixels. Row 4 is
 *   repainted by nothing ever, row 5 only by a squint in his own skin, row 6
 *   only on the conked cell and only to his own shadow -- because a man
 *   knocked out has his eyes shut. On every other cell his pupils survive.
 *
 *   THE HOLD MOVES. Fifty-four frames of held mouth is nearly a second, and a
 *   picture that does not change over a second is the complaint the rewrite
 *   exists to answer.
 *
 *   AND FACING LEFT LANDS ON HIS FACE TOO. The sheet does not mirror him, it
 *   SLIDES him: standL is standR translated +2 with zero differing pixels, so
 *   a flipped or unshifted overlay lands two columns off his face. jumpL is
 *   the opposite case -- an exact mirror -- and the art is symmetric, so it
 *   takes the overlay unshifted. Both halves are read off HIS OWN SHEET here
 *   rather than asserted against a number written down in this file: the
 *   mouth has to sit centered between whichever pair of eyes is on screen.
 *
 * HOW THE PIXELS ARE READ. The overlay is a pixelArt canvas, so "what was
 * painted" lives in the fillRects that rasterized it. Every canvas this
 * harness makes records them, and the recording context the probe hands
 * drawMouth expands its drawImage back into pixels with the same
 * nearest-neighbor mapping the real canvas does. Both halves are tagged --
 * `src` 0 for the blitted cell, 1 for the inhale streaks drawn in the air --
 * because the streaks change every single frame and would make the hold test
 * pass on their own.
 *
 * Every test has a NEGATIVE CONTROL: the same checker run against a copy of
 * the engine with one line changed in memory, and the check is that the same
 * assertions then fail. The mutated copies live in a string and a fresh vm
 * and are never written anywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

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

/* =====================================================================
   HIS OWN SHEET, decoded.

   The eye columns below are not written down anywhere in this file -- they
   are read out of the same 16x16 PNGs the game blits, because every claim
   this file makes about "his face" is a claim about those pixels. Four cells
   are reachable while the mouth is open: stand and jump, each way round.
   ===================================================================== */

function cellUrl(who, set, name) {
  const at = SPRITES.indexOf(who + ": {");
  assert.ok(at >= 0, "sprites.js should have a " + who + " entry");
  const setAt = SPRITES.indexOf(set + ": {", at);
  const m = new RegExp(name + ':\\s*"data:image/png;base64,([^"]+)"')
    .exec(SPRITES.slice(setAt));
  assert.ok(m, "sprites.js should have " + who + "." + set + "." + name);
  return m[1];
}

/* 8-bit RGBA, no interlace -- which is what every cell on the sheet is, and
   is asserted rather than assumed. */
function decodePng(b64) {
  const buf = Buffer.from(b64, "base64");
  let p = 8, idat = [], w = 0, h = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.slice(p + 4, p + 8).toString();
    if (type === "IHDR") {
      w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12);
      assert.equal(buf[p + 16], 8, "bit depth");
      assert.equal(buf[p + 17], 6, "color type RGBA");
      assert.equal(buf[p + 20], 0, "not interlaced");
    }
    if (type === "IDAT") idat.push(buf.slice(p + 8, p + 8 + len));
    p += 12 + len;
    if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (ft === 1) line[x] = (line[x] + a) & 255;
      else if (ft === 2) line[x] = (line[x] + b) & 255;
      else if (ft === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    prev = line;
    const row = [];
    for (let x = 0; x < w; x++) {
      const o = x * 4;
      row.push(line[o + 3] === 0 ? null : "#" + [0, 1, 2]
        .map((k) => line[o + k].toString(16).padStart(2, "0")).join("").toUpperCase());
    }
    rows.push(row);
  }
  return rows;
}

const SKIN = "#F0E3CF", SHADOW = "#DAC8AB", WHITE = "#FFFFFF", PUPIL = "#3D320E";

/* His face, per body cell: which columns his eye whites and his pupils are
   in. The mouth is centered against these and nothing else. */
const FACE = {};
for (const name of ["standR", "standL", "jumpR", "jumpL"]) {
  const cell = decodePng(cellUrl("cobeus", "base", name));
  const whites = [], pupils = [];
  for (let x = 0; x < 16; x++) {
    if (cell[5][x] === WHITE) whites.push(x);
    if (cell[6][x] === PUPIL) pupils.push(x);
  }
  FACE[name] = { cell, whites, pupils, center: (Math.min(...pupils) + Math.max(...pupils)) / 2 };
}

/* Stores what is written to it, unlike a discard-everything stub: the engine
   reads back properties it sets (fillStyle, globalAlpha), and a test cannot
   install a spy on a context that throws writes away.

   AND IT RECORDS ITS FILLRECTS, which the other harnesses in this suite do
   not need to. pixelArt rasterizes a cell by filling it one pixel at a time
   into a canvas of its own, so the only place the overlay's pixels exist is
   in those calls. */
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

const SP_UP = 2048;

/* WHAT WAS PAINTED, per attackFrame.

   He casts the move for real -- one pad through netplay, exactly as the catch
   probe next door does it -- so `specialsNow`, `specialSlot` and `moveFor`
   are whatever the engine decided rather than something assembled here. Only
   the frame counter is driven by hand after that, because sweeping 78 frames
   is the whole question and stepping to each one would also move him.

   Every pixel comes back in SCREEN space, with the body's own blit arithmetic
   beside it, so the checker converts to cell space the way drawFighter does
   and a change to either one cannot be hidden by a matching change here. */
const paint = (run, o) => JSON.parse(run(`(function () {
  ${SETUP}
  me.facing = ${o.facing};
  netplay.active = true;
  netplay.framePads = [bitsToPad(${SP_UP}), bitsToPad(0)];
  step();
  netplay.active = false; netplay.framePads = null;
  if (me.state !== 'special') throw new Error('he did not cast: ' + me.state);
  var want = ${JSON.stringify(o.frames)};
  var out = [];
  for (var n = 0; n < want.length; n++) {
    me.attackFrame = want[n][0];
    me.bedTimer = want[n][1];
    me.grounded = ${o.grounded ? "true" : "false"};
    var px = [], sty = '#000';
    var rec = {
      globalAlpha: 1,
      get fillStyle() { return sty; },
      set fillStyle(v) { sty = v; },
      fillRect: function (x, y, w, h) {
        for (var i = 0; i < w; i++) {
          for (var j = 0; j < h; j++) px.push([x + i, y + j, sty, 1]);
        }
      },
      drawImage: function (img, dx, dy, dw, dh) {
        var W = img.width, H = img.height;
        for (var k = 0; k < img.__px.length; k++) {
          var p = img.__px[k];
          var x0 = Math.floor(p[0] * dw / W), x1 = Math.floor((p[0] + 1) * dw / W);
          var y0 = Math.floor(p[1] * dh / H), y1 = Math.floor((p[1] + 1) * dh / H);
          for (var Y = y0; Y < y1; Y++) {
            for (var X = x0; X < x1; X++) px.push([dx + X, dy + Y, p[2], 0]);
          }
        }
      },
    };
    drawMouth(rec, me);
    var d = Math.round(16 * me.sizeMul);
    out.push({ af: want[n][0], bed: want[n][1], d: d,
               left: Math.round(me.x - 8) + 8 - (d >> 1),
               top: Math.round(me.y - 16) + 16 - d,
               px: px });
  }
  return JSON.stringify(out);
})()`));

/* attackFrame 0..77 is the whole move -- startup 6, active 60, recovery 12 --
   and then frame 66 again with the bed under him, which is the one runSpecial
   pins him at for all 180 frames of being knocked out. */
const WHOLE_MOVE = [];
for (let af = 0; af <= 77; af++) WHOLE_MOVE.push([af, 0]);
const CONKED = [[66, 180]];

/* Screen pixels -> cell space, by the same arithmetic drawFighter blits the
   body with. `in` is the 16 columns his body occupies; the inhale streaks are
   mostly outside it, which is the point of them. */
function cells(frame) {
  return frame.px.map((p) => ({
    col: Math.floor(((p[0] - frame.left) * 16) / frame.d),
    row: Math.floor(((p[1] - frame.top) * 16) / frame.d),
    color: p[2],
    overlay: p[3] === 0,
  }));
}
const inCell = (c) => c.col >= 0 && c.col < 16;
const ROWS_ART = { 4: 1, 5: 1, 6: 1 };

/* THE ONE DECLARED EXCEPTION, and it is worth being precise about because
   everything else in this file is written to forbid it. The mouth lives from
   row 7 down, but a face that never blinks over sixty frames of straining is
   a mask -- so his EYES are allowed to close, and closing an eye means his
   own skin over his own white on row 5 and his own shadow over his own pupil
   on row 6, in the two columns his eyes are actually in. Nothing else above
   row 7 is ever allowed, and test 2 pins every clause of this sentence. */
function isEyeClosure(c, face) {
  if (c.row === 5) return face.whites.includes(c.col) && c.color.toUpperCase() === SKIN;
  if (c.row === 6) return face.pupils.includes(c.col) && c.color.toUpperCase() === SHADOW;
  return false;
}

/* =====================================================================
   1. IT IS DRAWN ON HIS FACE, NOT ON HIS HAIR
   ===================================================================== */

function checkOnHisFace(frames, pose) {
  const face = FACE[pose];
  assert.equal(frames.length, 79,
    "precondition: the sweep is the whole move plus the conked frame");
  for (const f of frames) {
    assert.ok(f.d === 16,
      "precondition: this is read at sizeMul 1, where the cell is 16 screen " +
      "pixels and every row is one; it was " + f.d);
    assert.ok(f.px.length > 0,
      "every frame of the move paints something -- a mouth that vanishes " +
      "mid-move is its own bug; attackFrame " + f.af + " painted nothing");
  }

  /* THE REGRESSION, as one sentence. Row 7 is his chin. Rows 0 to 3 are his
     hair and 4 to 6 are his brow and his eyes, and the drawing this replaced
     put its pale lip on row 0. The mouth itself -- everything that is not one
     of the two declared eye closures -- lives from row 7 down. */
  let top = 99;
  for (const f of frames) {
    for (const c of cells(f)) {
      if (!inCell(c)) continue;
      assert.ok(c.row >= 5,
        "NOTHING drawMouth paints inside his cell may land on rows 0 to 4 -- " +
        "rows 0-3 are his HAIR and row 4 is his brow. This is the drawing " +
        "this one replaced, exactly: it anchored at f.y - 13, which is CELL " +
        "ROW 3, and put a pale lip on ROW 0, the crown of his head. On " +
        "attackFrame " + f.af + (f.bed ? " (bedded)" : "") + " a " + c.color +
        " pixel landed on row " + c.row + ", col " + c.col);
      if (isEyeClosure(c, face)) continue;
      if (c.row < top) top = c.row;
      assert.ok(c.row >= 7,
        "and the MOUTH may not land above ROW 7 -- his chin, which is the " +
        "upper lip on every open cell. The only thing allowed above it is an " +
        "eye closing, which is his own skin or his own shadow in his own two " +
        "eye columns (" + face.whites.join(" and ") + " on " + pose + "). On " +
        "attackFrame " + f.af + (f.bed ? " (bedded)" : "") + " a " + c.color +
        " pixel landed on row " + c.row + ", col " + c.col);
    }
  }
  assert.equal(top, 7,
    "and the topmost thing the mouth paints IS row 7, his chin turned into an " +
    "upper lip; the highest painted row was " + top);

  /* Every color is one off his own sheet. The two the old drawing used are
     named because they are the evidence: neither #140a06 nor #f2e6c8 is on
     CobeusSpriteSheet.png at all -- they were invented. */
  const owned = { "#F0E3CF": 1, "#DAC8AB": 1, "#EFDABA": 1, "#3D320E": 1,
                  "#231C03": 1, "#080420": 1 };
  const seen = new Set();
  for (const f of frames) for (const c of cells(f)) seen.add(c.color.toUpperCase());
  for (const col of seen) {
    assert.ok(owned[col],
      "every pixel this paints is a color Cobeus already owns; " + col +
      " is not one of them (the drawing this replaced used #140a06 and " +
      "#f2e6c8, and neither appears anywhere on his sheet)");
  }
}

test("the mouth is drawn on his face, not on his hair", async () => {
  const run = await arena(COBEUS, NICK);
  checkOnHisFace(paint(run, { facing: 1, grounded: true,
                              frames: WHOLE_MOVE.concat(CONKED) }), "standR");
});

test("negative control: the 2.81 drawing at its f.y - 13 anchor fails the face test", async () => {
  /* The drawing exactly as 2.81 shipped it -- two crossed rects and a pale
     lip, anchored at f.y - 13 * sk -- dropped into the new function in place
     of the blit. Nothing else moves: the same poses are chosen on the same
     frames and the same streaks are drawn in the same air. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  const d = Math.round(16 * sk);\n" +
    "  g.drawImage(mouthArt(pose, f.facing < 0 && f.grounded),\n" +
    "              Math.round(f.x - 8) + 8 - (d >> 1),\n" +
    "              Math.round(f.y - 16) + 16 - d, d, d);",
    "  const x = Math.round(f.x + f.facing * 2 * sk);\n" +
    "  const y = Math.round(f.y - 13 * sk);\n" +
    "  g.fillStyle = '#140a06';\n" +
    "  g.fillRect(x - 3, y - 2, 6, 4);\n" +
    "  g.fillRect(x - 2, y - 3, 4, 6);\n" +
    "  g.fillStyle = '#f2e6c8';\n" +
    "  g.fillRect(x - 2, y - 3, 4, 1);") });
  expectToFail(() => checkOnHisFace(paint(run, { facing: 1, grounded: true,
                                                frames: WHOLE_MOVE.concat(CONKED) }), "standR"),
    "a mouth drawn at the f.y - 13 anchor lands on his hair and should fail " +
    "the face test; it passed");
});

/* =====================================================================
   2. ROWS 4, 5 AND 6 ARE HIS
   ===================================================================== */

function checkHisFaceSurvives(frames, pose) {
  const face = FACE[pose];
  assert.deepEqual(face.pupils, face.whites,
    "precondition: on " + pose + " his pupils sit directly under his eye " +
    "whites, in the same two columns");

  let sawSquint = 0, sawShut = 0;
  for (const f of frames) {
    const conked = f.bed > 0;
    for (const c of cells(f)) {
      if (!inCell(c) || !ROWS_ART[c.row]) continue;

      assert.notEqual(c.row, 4,
        "ROW 4 IS HIS BROW and is repainted by nothing, ever; attackFrame " +
        f.af + " put " + c.color + " on it at col " + c.col);

      if (c.row === 5) {
        assert.ok(face.whites.includes(c.col),
          "row 5 may only ever be touched at his two eye-white columns (" +
          face.whites.join(" and ") + " on " + pose + "), because the only " +
          "thing allowed to happen up there is a squint; attackFrame " + f.af +
          " painted col " + c.col);
        assert.equal(c.color.toUpperCase(), SKIN,
          "and a squint is HIS OWN SKIN (" + SKIN + ") closed over his own " +
          "white, not a color from the mouth; attackFrame " + f.af +
          " used " + c.color);
        sawSquint++;
      }

      if (c.row === 6) {
        assert.ok(conked,
          "ROW 6 IS HIS PUPILS, and they survive every cell of the set but " +
          "one: the conked pose, where he is unconscious and his eyes are " +
          "shut. attackFrame " + f.af + " is not that pose and it painted " +
          c.color + " on row 6, col " + c.col);
        assert.ok(face.pupils.includes(c.col),
          "even the conked pose only closes the two pupil columns (" +
          face.pupils.join(" and ") + "); it painted col " + c.col);
        assert.equal(c.color.toUpperCase(), SHADOW,
          "and it closes them in HIS OWN SHADOW (" + SHADOW + "), which is " +
          "what a shut eye is made of here; it used " + c.color);
        sawShut++;
      }
    }
  }

  /* Both exceptions have to actually HAPPEN, or this test passes on a set
     that never paints those rows at all and proves nothing about the rule. */
  assert.equal(sawSquint > 0, true,
    "precondition: the hold squints at least once -- it is one of the four " +
    "things that move -- and nothing on row 5 was painted");
  assert.equal(sawShut, 2,
    "and the conked cell shuts exactly two eyes; it painted " + sawShut +
    " pixels on row 6");
}

test("rows 4, 5 and 6 are his -- his pupils survive every cell", async () => {
  const run = await arena(COBEUS, NICK);
  checkHisFaceSurvives(
    paint(run, { facing: 1, grounded: true, frames: WHOLE_MOVE.concat(CONKED) }),
    "standR");
});

test("rows 4, 5 and 6 are his facing left too", async () => {
  const run = await arena(COBEUS, NICK);
  checkHisFaceSurvives(
    paint(run, { facing: -1, grounded: true, frames: WHOLE_MOVE.concat(CONKED) }),
    "standL");
});

test("negative control: a squint one row lower eats his pupils", async () => {
  /* The strain cell closing rows 5 AND 6 -- which is what "shut his eyes"
     looks like if you write it without knowing where his pupils are. It is
     two characters of art data, it reads as a blink at x1, and at x3 he has
     no eyes for six frames of every cycle. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  H2: { 5: '......S..S......',",
    "  H2: { 5: '......S..S......', 6: '......S..S......',") });
  expectToFail(() => checkHisFaceSurvives(
    paint(run, { facing: 1, grounded: true, frames: WHOLE_MOVE.concat(CONKED) }),
    "standR"),
    "a squint that closes over his pupils should fail the rows-4-5-6 test; " +
    "it passed");
});

/* =====================================================================
   3. THE HOLD ACTUALLY CHANGES
   ===================================================================== */

/* Just the blitted cell, as a string. The streaks are left out on purpose:
   they move two pixels every single frame, so a signature that included them
   would say the hold changes even if the mouth were a photograph. */
function cellPrint(frame) {
  return cells(frame).filter((c) => c.overlay)
    .map((c) => c.row + "," + c.col + "," + c.color.toUpperCase())
    .sort().join(" ");
}

function checkTheHoldMoves(frames) {
  const hold = frames.filter((f) => f.bed === 0 && f.af >= 10 && f.af <= 63);
  assert.equal(hold.length, 54,
    "precondition: the hold is attackFrames 10 to 63, which is 54 frames -- " +
    "nearly a second; the sweep found " + hold.length);

  const prints = hold.map(cellPrint);
  const distinct = new Set(prints);
  assert.equal(distinct.size, 4,
    "the hold cycles FOUR different cells; it drew " + distinct.size);

  let changes = 0;
  const runs = [];
  let len = 1;
  for (let i = 1; i < prints.length; i++) {
    if (prints[i] !== prints[i - 1]) { changes++; runs.push(len); len = 1; }
    else len++;
  }
  runs.push(len);
  assert.equal(changes, 8,
    "and it changes eight times across those 54 frames -- a picture that " +
    "holds still for nearly a second is the complaint this rewrite answers; " +
    "it changed " + changes + " times");
  for (const r of runs) {
    assert.ok(r <= 6,
      "no single cell is held for more than six frames (a tenth of a " +
      "second); the runs were " + runs.join(", "));
  }

  /* AND IT IS THE JAW THAT MOVES, not just the paint. The lowest row the
     cell reaches is the bottom of the hole, and over the cycle it has to
     take more than one value or he is opening and closing nothing. */
  const floors = new Set(hold.map((f) => {
    let low = -1;
    for (const c of cells(f)) if (c.overlay && c.row > low) low = c.row;
    return low;
  }));
  assert.deepEqual([...floors].sort(), [10, 11],
    "and what moves is the JAW: the bottom of the hole sits on row 10 or row " +
    "11 depending on the phase, which is three screen pixels at x3. It " +
    "reached " + [...floors].join(", "));
}

test("the hold actually changes", async () => {
  const run = await arena(COBEUS, NICK);
  checkTheHoldMoves(paint(run, { facing: 1, grounded: true, frames: WHOLE_MOVE }));
});

test("negative control: one cell held for the whole hold fails the hold test", async () => {
  /* The obvious build: pick the open cell, draw it until the window shuts.
     Every other thing about the move is identical -- same startup cells, same
     snap, same close, same streaks -- and the mouth is a photograph for 54
     frames, which is what it looked like before this pass. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "  if (af <= 63) return MOUTH_HOLD[(((af - 10) / 6) | 0) % 4];",
    "  if (af <= 63) return MOUTH_HOLD[0];") });
  expectToFail(
    () => checkTheHoldMoves(paint(run, { facing: 1, grounded: true, frames: WHOLE_MOVE })),
    "a hold that never changes cell should fail the hold test; it passed");
});

/* =====================================================================
   4. FACING LEFT LANDS ON HIS FACE TOO
   ===================================================================== */

/* THE SHEET SLIDES HIM RATHER THAN MIRRORING HIM, and the consequence is the
   whole of this test: the mouth must sit centered between whichever pair of
   eyes is actually on screen. standL's eyes are at cols 8 and 11 and standR's
   at 6 and 9 -- the SAME drawing, translated two columns -- so an overlay
   that is not shifted for standL is two columns off his face and eats his
   cheek. jumpL is the other case: it is an exact mirror of jumpR, its eyes
   are back at 6 and 9, and the art is symmetric about col 7.5, so it wants
   the overlay UNSHIFTED. One rule covers both, which is why the test is
   written against his eyes rather than against a shift. */
function checkCenteredOnHisFace(frames, pose) {
  const face = FACE[pose];
  let lo = 99, hi = -1, painted = 0;
  const art = [];
  for (const f of frames) {
    for (const c of cells(f)) {
      if (!c.overlay) continue;
      painted++;
      art.push([f.af, c]);
      if (c.row < 7) continue;   // a shut eye is not part of the mouth's span
      if (c.col < lo) lo = c.col;
      if (c.col > hi) hi = c.col;
    }
  }
  assert.ok(painted > 0, "precondition: " + pose + " painted something");
  /* The thesis first, so a misaligned overlay is reported as what it is
     rather than as whichever of his features it happened to hit. */
  assert.equal((lo + hi) / 2, face.center,
    "the mouth is centered between HIS eyes, and on " + pose + " those are " +
    "cols " + face.pupils.join(" and ") + " -- center " + face.center + ". " +
    "The painted cell ran from col " + lo + " to col " + hi + ", center " +
    ((lo + hi) / 2) + ". standL is standR TRANSLATED +2 rather than mirrored, " +
    "so an unshifted or flipped overlay lands two columns off his face");

  /* And it is on his face at all, which is the first test asked of the cell
     he is usually watched from and is asked again here of the other three. */
  for (const [af, c] of art) {
    assert.ok(c.row >= 7 || isEyeClosure(c, face),
      "on " + pose + " nothing the mouth paints may land above row 7, and " +
      "the only exception is an eye closing in his own color in his own " +
      "columns; attackFrame " + af + " put " + c.color + " on row " +
      c.row + ", col " + c.col);
  }
}

/* The four cells that can be under this overlay. He is rooted and grounded
   for the whole open window, so standR and standL are what the hold is drawn
   on; the airborne pair is reachable on the recovery, which is a glide. */
test("facing left lands on his face too", async () => {
  const run = await arena(COBEUS, NICK);
  const open = WHOLE_MOVE.filter((p) => p[0] >= 7 && p[0] <= 66);
  checkCenteredOnHisFace(paint(run, { facing: 1, grounded: true, frames: open }), "standR");
  checkCenteredOnHisFace(paint(run, { facing: -1, grounded: true, frames: open }), "standL");
  checkCenteredOnHisFace(paint(run, { facing: 1, grounded: false, frames: open }), "jumpR");
  checkCenteredOnHisFace(paint(run, { facing: -1, grounded: false, frames: open }), "jumpL");
});

test("negative control: an unshifted overlay on standL fails the facing test", async () => {
  /* The overlay laid on every cell at the same columns -- which is the
     obvious thing to write, and is correct for three of the four cells. The
     fourth is the one he spends the whole move in when he is facing left. */
  const run = await arena(COBEUS, NICK, { engine: sabotage(
    "    rows.push(!r ? MOUTH_BLANK : shift ? '..' + r.slice(0, 14) : r);",
    "    rows.push(!r ? MOUTH_BLANK : r);") });
  const open = WHOLE_MOVE.filter((p) => p[0] >= 7 && p[0] <= 66);
  /* standR is unaffected, and that is the point of checking it here: the
     mutant is invisible from the side the move is usually watched from. */
  checkCenteredOnHisFace(paint(run, { facing: 1, grounded: true, frames: open }), "standR");
  expectToFail(
    () => checkCenteredOnHisFace(paint(run, { facing: -1, grounded: true, frames: open }), "standL"),
    "an unshifted overlay on standL sits two columns off his face and should " +
    "fail the facing test; it passed");
});
