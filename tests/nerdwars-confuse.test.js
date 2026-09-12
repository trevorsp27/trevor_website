/* Confusion: the CPU's half of it, and the ducks that announce it.
 *
 * SMOKESCREEN swaps left and right for four seconds. The swap happens inside
 * Fighter.update, on a COPY of the pad, AFTER the AI has already decided what
 * to press -- so the CPU was steering by the direction it named rather than
 * the one it would get, and while confused those are opposites. It walked off
 * ledges it had just probed as safe, and once knocked off the stage it flew
 * away from home under power, because "press toward the center" came out as
 * "press toward the blast zone".
 *
 * That was not a rounding error. Over 1200 CPU-vs-CPU matches JohnnyHam won
 * 96.8% of everything he played; with confuse removed entirely he won 10.3%.
 * Nearly the whole gap was opponents killing themselves. Compensating in the
 * ledge probe and the recovery steer took him to 53.5% with the move's
 * duration untouched.
 *
 * The compensation is deliberately limited to those two places -- not dying is
 * the only thing a confused fighter gets to be smart about. That boundary is
 * what these tests defend: one that the CPU no longer suicides, and one that
 * it is still just as lost when it is not busy dying. A fix that over-corrects
 * into immunity passes the first and fails the second, which is exactly why
 * both are here.
 *
 * WHY THIS FILE LOADS THE ENGINE SOURCE and not the shipped bundle, unlike
 * every other suite here: NerdWars.fighters exports rounded read-only COPIES,
 * so there is no way through the public surface to put a fighter into the
 * confused state or to reach drawFighter. arena-style direct loading gets the
 * real objects. The last test in the file closes that gap by checking the
 * shipped bundle was actually rebuilt from this source.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(HERE, "..", "assets", "js", "nerdwars");
const SPRITES = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
// The two repos are siblings on disk and build.py already writes across the
// gap, so this is the same relationship the build depends on.
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

function stubContext() {
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "createLinearGradient" || key === "createRadialGradient") {
          return () => ({ addColorStop() {} });
        }
        if (key === "measureText") return () => ({ width: 0 });
        if (key === "canvas") return { width: 0, height: 0 };
        return () => {};
      },
      set() {
        return true;
      },
    }
  );
}

function stubCanvas(w, h) {
  const el = {
    width: w,
    height: h,
    style: {},
    getContext: () => stubContext(),
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

/* Every sandbox in this repo is handed the HOST's Math object, so all of them
   share one Math.random stream -- and node --test runs files concurrently, so
   the interleaving of the AI's random choices differs from run to run. This
   file's assertions are averages over AI behavior, which made them pass alone
   and fail in the full suite.

   A seeded stream per boot fixes that, and costs nothing: Math is the
   prototype, so every other function on it still works. */
function seededMath(seed) {
  let s = (seed >>> 0) || 1;
  const M = Object.create(Math);
  M.random = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return M;
}

/** Boot the engine source with everything at module scope reachable. */
async function bootEngine(seed) {
  const view = stubCanvas(960, 540);
  const sandbox = {
    console, Math: seededMath(seed === undefined ? 1 : seed), JSON, Date,
    Promise, Object, Array, Map, Set, Number,
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float32Array,
    Float64Array, isNaN, parseInt, parseFloat,
    requestAnimationFrame: () => {},
    innerWidth: 960,
    innerHeight: 540,
    addEventListener() {},
    Image: class {
      constructor() {
        this.complete = true;
        this.naturalWidth = 16;
        this.naturalHeight = 16;
      }
      set src(v) {
        if (this.onload) this.onload();
      }
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
      "UI=window.NERDWARS_ASSETS.UI;",
    sandbox
  );
  vm.runInContext(readFileSync(ENGINE_PATH, "utf8"), sandbox, { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

/** A battle with both seats driven by the AI, past spawn invulnerability. */
async function cpuBattle(seats, seed) {
  const run = await bootEngine(seed);
  run(
    "select.cursor=[" + (seats || "1,4") + "]; twoPlayer=true; playerCount=" +
      (seats ? seats.split(",").length : 2) +
      "; humanCount=0; stagePick=0; startBattle();"
  );
  run("for (var i=0;i<130;i++) step();");
  return run;
}

/* Behavior here is stochastic -- aiDecide re-plans on Math.random -- so every
   claim below is the average of several runs rather than one lucky match. */
const TRIALS = 6;

/* ------------------------------------------------------------------ */

test("a confused CPU knocked off the stage still flies home", async () => {
  /* The unconfused run is the control. Without it this would be measuring
     whether the recovery AI works at all, not whether confusion breaks it. */
  const moved = { 0: [], 240: [] };
  for (const confused of [0, 240]) {
    for (let t = 0; t < TRIALS; t++) {
      const run = await cpuBattle(null, 1000 + t);
      const dx = run(`(function(){
        var f = fighters[1], stage = STAGE.platforms[0];
        f.invuln = 0;
        f.x = stage.x - 12;          // out past the left lip
        f.y = stage.y - 24;
        f.vx = 0; f.vy = 1.2;
        f.grounded = false;
        f.jumpsLeft = 2;
        f.confused = ${confused};
        var x0 = f.x;
        for (var i = 0; i < 40; i++) step();
        return f.x - x0;
      })()`);
      moved[confused].push(dx);
    }
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const clear = avg(moved[0]);
  const dazed = avg(moved[240]);

  assert.ok(
    clear > 2,
    "control: a clear-headed CPU dropped off the left lip should head back " +
      "right, averaged " + clear.toFixed(1) + "px"
  );
  assert.ok(
    dazed > 2,
    "a CONFUSED CPU must also head back right. It used to press toward home, " +
      "have the pad inverted under it, and fly into the blast zone -- which " +
      "is most of what made SMOKESCREEN a 96.8% win rate. Averaged " +
      dazed.toFixed(1) + "px over " + TRIALS + " runs"
  );
});

test("the CPU is still genuinely confused, not quietly immune", async () => {
  /* The failure mode of this fix is over-correcting. Compensate everywhere and
     the AI shrugs the move off, which would make SMOKESCREEN pointless and
     would not show up in the test above at all. On flat ground mid-stage,
     clear of every edge, a confused CPU should still be worse at closing on
     its target than a clear-headed one. */
  const closed = { 0: [], 240: [] };
  for (const confused of [0, 240]) {
    for (let t = 0; t < TRIALS; t++) {
      const run = await cpuBattle(null, 2000 + t);
      const gain = run(`(function(){
        var me = fighters[1], foe = fighters[0], stage = STAGE.platforms[0];
        var mid = stage.x + stage.w / 2;
        me.invuln = 0; foe.invuln = 0;
        me.x = mid + 30; me.y = stage.y; me.vx = 0; me.grounded = true;
        foe.x = mid - 30; foe.y = stage.y; foe.vx = 0; foe.grounded = true;
        me.confused = ${confused};
        var d0 = Math.abs(me.x - foe.x);
        for (var i = 0; i < 34; i++) step();
        return d0 - Math.abs(me.x - foe.x);     // how much ground it closed
      })()`);
      closed[confused].push(gain);
    }
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const clear = avg(closed[0]);
  const dazed = avg(closed[240]);

  assert.ok(
    clear > 3,
    "control: a clear-headed CPU should close on a foe 60px away, closed " +
      clear.toFixed(1) + "px"
  );
  assert.ok(
    dazed < clear - 3,
    "a confused CPU must NOT chase as well as a clear-headed one. If it does, " +
      "the compensation leaked out of the recovery path and the move stopped " +
      "meaning anything. clear " + clear.toFixed(1) + "px vs confused " +
      dazed.toFixed(1) + "px"
  );
});

test("the ducks appear only while confused, and clear the seat arrow", async () => {
  /* The only render test in the suite. It records the draw calls rather than
     rasterizing, which is enough to answer the two questions that matter:
     does the overlay key off `confused`, and does it stay out of the way of
     the seat marker that says which fighter is yours. */
  const run = await bootEngine();
  run("select.cursor=[1,4,2,5]; twoPlayer=true; playerCount=4; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const capture = (confused, frames) => run(`(function(){
    var f = fighters[0]; f.invuln = 0; f.confused = ${confused};
    var out = [];
    for (var n = 0; n < ${frames}; n++) {
      var ops = [];
      var rec = {
        globalAlpha: 1, fillStyle: '#000',
        fillRect: function (x, y, w, h) {
          ops.push({ x: x, y: y, w: w, h: h, c: this.fillStyle, a: this.globalAlpha });
        },
        drawImage: function () {}, beginPath: function () {}, arc: function () {},
        fill: function () {}, save: function () {}, restore: function () {},
        translate: function () {}, scale: function () {},
      };
      drawFighter(rec, f);
      out.push(ops);
      if (f.confused > 0) f.confused--;
    }
    return { ops: out, y: f.y, x: f.x };
  })()`);

  const DUCK_INK = ['#fff6d8', '#3a2f22', '#ff9d2e'];
  const bill = (ops) => ops.filter((o) => o.c === '#ff9d2e');
  // Only the ducks' own pixels. drawFighter also emits the seat arrow and,
  // if this fighter happens to have been poisoned during the warmup, the
  // poison glyph at f.y-20 -- which sits below the arrow quite legitimately
  // and made the first version of this assertion fail on a duck-free crime.
  const duckRects = (ops) => ops.filter((o) => DUCK_INK.includes(o.c));

  const clear = capture(0, 1);
  assert.equal(bill(clear.ops[0]).length, 0,
    "negative control: a fighter who is not confused should draw no ducks");

  // A whole orbit, so every position the ducks can reach gets checked.
  const dazed = capture(240, 80);
  const billsPerFrame = dazed.ops.map((ops) => bill(ops).length);
  assert.ok(
    billsPerFrame.every((n) => n === 3),
    "three ducks, every frame of the orbit -- saw counts " +
      [...new Set(billsPerFrame)].join(",")
  );

  /* The seat arrow owns f.y-24 through f.y-21 and is the one mark saying which
     fighter is yours. A duck crossing it is a worse bug than no ducks. */
  const arrowTop = Math.round(dazed.y) - 24;
  const lowest = Math.max(...duckRects(dazed.ops.flat()).map((o) => o.y + o.h));
  assert.ok(
    lowest <= arrowTop,
    "in a four-way the ducks must stay above the seat arrow at y=" + arrowTop +
      "; the lowest duck pixel reached " + lowest
  );

  // Fading out is the warning that the effect is ending, so it has to be
  // visible in the alpha and not just in the comment claiming it happens.
  const alphaAt = (c) => Math.max(...duckRects(capture(c, 1).ops[0]).map((o) => o.a));
  assert.ok(alphaAt(200) > alphaAt(20),
    "ducks should thin out as the confusion runs down");
});

test("the shipped bundle was rebuilt from this engine source", async () => {
  /* The tests above read src/nerdwars.js directly, so on their own they would
     happily pass against a site bundle nobody rebuilt. This is the seam. */
  assert.ok(existsSync(ENGINE_PATH), "engine source should sit beside this repo");
  const bundle = readFileSync(path.join(JS_DIR, "game.js"), "utf8");
  for (const marker of ["DUCK_ROWS", "drawDuck", "#ff9d2e"]) {
    assert.ok(
      bundle.includes(marker),
      "game.js is missing " + marker + " -- run src/build.py, the site is " +
        "serving an engine older than this source"
    );
  }
});
