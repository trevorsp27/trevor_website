/* Two bugs a player found in one sitting, both worth a permanent guard.
 *
 * 1. Down+jump dropped you through ANY platform, the main floor included.
 *    There is nothing under the main floor, so that was not a movement option,
 *    it was an instant stock -- and down+jump is exactly what you are holding
 *    while fast-falling into a landing, so it happened by accident.
 *
 * 2. The world canvas crept sideways during online matches and left a stale
 *    strip down the edge it uncovered. drawFighter saves and translates the
 *    context for the rollback smoothing, and the respawn-blink early return
 *    sat between that save and its restore. A canvas transform outlives the
 *    frame, so one unbalanced save shifted every frame after it, further each
 *    time, and clearRect stopped clearing the actual screen.
 *
 *    It needed a rollback correction and a respawn in the same instant, which
 *    is why it was online-only and intermittent: visErr is zero offline, so
 *    `shifted` is false and the save never happens at all.
 *
 * These load the engine source rather than the bundle for the same reason
 * nerdwars-confuse.test.js does: NerdWars.fighters hands out rounded read-only
 * copies, and neither placing a fighter on a chosen platform nor reaching
 * drawFighter is possible through the public surface.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

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
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

async function bootEngine() {
  const view = stubCanvas(960, 540);
  const sandbox = {
    console, Math, JSON, Date, Promise, Object, Array, Map, Set, Number,
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
  vm.runInContext(readFileSync(ENGINE_PATH, "utf8"), sandbox, { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

async function battle() {
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");     // past the 110-frame spawn invuln
  return run;
}

/* The warmup frames run both CPUs off Math.random, so whichever state a
   fighter lands in is luck -- and a fighter mid-special ignores the jump
   button entirely. One run of this file saw "walk" and the next saw
   "special", which made the drop-through look fixed when it was not. Force a
   clean, actionable fighter instead of hoping for one. */
const CLEAN = `
    projectiles.length = 0; effects.length = 0;
    f.setState('idle');
    f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
    f.dropThrough = 0; f.invuln = 0; f.confused = 0; f.buffTimer = 0;
    f.vx = 0; f.vy = 0; f.grounded = true;`;

/* DOWN | JUMP, delivered the way a real press is.

   Jump is deliberately absent from NET_LEVEL_BITS, so what crosses the wire
   is one frame of it, an edge, not a held level. Holding the bit instead
   spends the air jump on the very next frame and carries the fighter back up
   over the platform it just left -- which looks exactly like the drop-through
   having failed, and cost this test a wrong diagnosis once already. */
const DOWN_JUMP = 8 | 16;

/** Hold `bits` on seat 0 for `hold` frames, then nothing for `coast`. */
const driveSeat0 = (bits, hold, coast) => `
  netplay.active = true;
  for (var i = 0; i < ${hold}; i++) {
    netplay.framePads = [bitsToPad(${bits}), bitsToPad(0)];
    step();
  }
  for (var i = 0; i < ${coast}; i++) {
    netplay.framePads = [bitsToPad(0), bitsToPad(0)];
    step();
  }
  netplay.active = false; netplay.framePads = null;`;

/* ------------------------------------------------------------------ */

test("down+jump on the main floor jumps instead of killing you", async () => {
  const run = await battle();
  const r = run(`(function(){
    var f = fighters[0];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    f.x = main.x + main.w / 2; f.y = main.y;
    ${CLEAN}
    var stocks0 = f.stocks, floorY = main.y;
    var maxY = f.y, minY = f.y;
    netplay.active = true;
    for (var i = 0; i < 51; i++) {
      netplay.framePads = [bitsToPad(i === 0 ? ${DOWN_JUMP} : 0), bitsToPad(0)];
      step();
      if (f.y > maxY) maxY = f.y;
      if (f.y < minY) minY = f.y;
    }
    netplay.active = false; netplay.framePads = null;
    return { y: f.y, floorY: floorY, maxY: maxY, minY: minY,
             stocks: f.stocks, stocks0: stocks0,
             grounded: f.grounded, eliminated: f.eliminated };
  })()`);

  assert.equal(r.stocks, r.stocks0,
    "holding down+jump on the stage floor must not cost a stock; it did, " +
    "which means the fighter fell through the world");
  assert.ok(!r.eliminated, "and must certainly not eliminate anybody");
  assert.ok(
    r.minY <= r.floorY + 1 && r.maxY <= r.floorY + 8,
    "the fighter left the floor at y=" + r.floorY + " and got as far down as " +
      "y=" + r.maxY.toFixed(1) + ". Below the stage is a blast zone, not a " +
      "place. (Checking the deepest point reached, not the final one: dying " +
      "respawns you high above the stage, which looks healthy at the end.)"
  );
});

test("down+jump on a thin platform still drops through it", async () => {
  /* The fix must not cost the feature. Dropping through a side platform is
     real movement -- it is how you get back to the floor in a hurry. */
  const run = await battle();
  const r = run(`(function(){
    var thin = STAGE.platforms.filter(function (p) { return !p.main; })[0];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var f = fighters[0];
    f.x = thin.x + thin.w / 2; f.y = thin.y;
    ${CLEAN}
    // Keep the other one well away so nothing interferes.
    fighters[1].x = main.x + main.w - 4; fighters[1].y = main.y;
    ${driveSeat0(DOWN_JUMP, 1, 40)}
    return { y: f.y, thinY: thin.y, mainY: main.y, stocks: f.stocks };
  })()`);

  assert.ok(
    r.y > r.thinY + 2,
    "the fighter should have dropped off the thin platform at y=" + r.thinY +
      " but is still at y=" + r.y.toFixed(1)
  );
  assert.ok(
    r.y <= r.mainY + 1,
    "and should have landed on the floor below at y=" + r.mainY +
      ", not carried on into the blast zone (ended at " + r.y.toFixed(1) + ")"
  );
});

test("the rollback shift never leaks out of drawFighter", async () => {
  /* Counts save/restore rather than inspecting pixels, because the damage is
     not what this frame looks like -- it is that the transform survives into
     the next one. An unbalanced save is the bug, exactly. */
  const run = await battle();

  const balance = (invuln, errX) => run(`(function(){
    var f = fighters[0];
    f.invuln = ${invuln};
    visErrX[f.slot] = ${errX}; visErrY[f.slot] = 0;
    var saves = 0, restores = 0;
    var rec = { globalAlpha: 1, fillStyle: '#000',
      save: function () { saves++; }, restore: function () { restores++; },
      translate: function () {}, scale: function () {},
      fillRect: function () {}, drawImage: function () {},
      beginPath: function () {}, arc: function () {}, fill: function () {} };
    drawFighter(rec, f);
    return saves - restores;
  })()`);

  // Blink is on for four frames in every eight, so this value is mid-blink.
  const BLINKING = 8;
  assert.equal(balance(0, 0), 0, "healthy fighter, no correction");
  assert.equal(balance(0, 6), 0, "healthy fighter mid-correction");
  assert.equal(balance(BLINKING, 0), 0, "blinking fighter, no correction");
  assert.equal(
    balance(BLINKING, 6), 0,
    "a fighter respawning DURING a rollback correction left the world canvas " +
      "translated. Every later frame then drew shifted, further each time, and " +
      "clearRect stopped covering the screen -- the stage visibly crept sideways"
  );
});

test("drawWorld starts each frame from a known transform", async () => {
  /* Belt and braces for the test above: even if something new leaks a
     transform, it must cost one frame rather than every frame after it. */
  const run = await battle();
  const resets = run(`(function(){
    var n = 0;
    var real = ctx.setTransform;
    ctx.setTransform = function () { n++; };
    drawWorld();
    ctx.setTransform = real;
    return n;
  })()`);
  assert.ok(resets >= 1,
    "drawWorld should reset the transform before drawing, so a leaked one " +
      "cannot accumulate across frames");
});
