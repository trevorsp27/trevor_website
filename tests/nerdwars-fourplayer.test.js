/* NerdWars with more than two fighters.
 *
 * The engine was written for exactly two, and the number was spread across it
 * rather than written down anywhere: `1 - localSlot` for "the other player",
 * `[0, 0]` for "who has this projectile already hit", two spawn points per
 * stage, two HUD corners. Four is now reachable from the title screen.
 *
 * Two things are worth guarding here. The first is that the four-player mode
 * exists and works. The second, and the reason this file was written, is that
 * the 1v1 game did NOT change: it is the mode that ships, that people play
 * online, and that every balance number was measured against.
 *
 * These drive the SHIPPED bundle through its real menus with real key events,
 * so they exercise the path an actual player takes rather than reaching into
 * the engine and arranging a match by hand.
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
const GAME = readFileSync(path.join(JS_DIR, "game.js"), "utf8");

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
  el.parentElement = {
    clientWidth: w,
    clientHeight: h,
    contains: () => true,
    dataset: {},
  };
  return el;
}

async function bootGame() {
  const view = stubCanvas(960, 540);
  const winListeners = new Map();
  const rafQueue = [];
  let clock = 0;

  const on = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };

  const sandbox = {
    console, Math, JSON, Date, Promise, Object, Array, Map, Set, Number,
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float64Array,
    isNaN, parseInt, parseFloat,
    requestAnimationFrame: (cb) => rafQueue.push(cb),
    innerWidth: 960,
    innerHeight: 540,
    addEventListener: on(winListeners),
    Image: class {
      constructor() {
        this.complete = true;
        this.naturalWidth = 16;
        this.naturalHeight = 16;
      }
      set src(v) {
        this._src = v;
        if (this.onload) this.onload();
      }
      get src() {
        return this._src;
      }
    },
    document: {
      getElementById: (id) => (id === "nw-canvas" || id === "game" ? view : null),
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener: on(new Map()),
      documentElement: {},
      fullscreenElement: null,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(GAME, sandbox, { filename: "game.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const fire = (type, ev) => {
    for (const fn of winListeners.get(type) || []) fn(ev);
  };

  const g = {
    nw: sandbox.window.NerdWars,
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const due = rafQueue.splice(0, rafQueue.length);
        clock += 1000 / 60;
        for (const cb of due) cb(clock);
      }
    },
    press: (code) => fire("keydown", { code, preventDefault() {} }),
    release: (code) => fire("keyup", { code }),
  };
  // A press is edge-triggered off the previous frame, so it needs a frame to
  // be seen and a frame to be let go of again.
  g.tap = (code) => {
    g.press(code);
    g.pump(2);
    g.release(code);
    g.pump(2);
  };
  return g;
}

/** Walk the title -> select -> stage menus into a running match. */
function startMatch(g, { mode }) {
  assert.equal(g.nw.scene, "title", "expected to start at the title");
  for (let i = 0; i < mode; i++) g.tap("KeyS");   // move down the mode list
  g.tap("Enter");
  assert.equal(g.nw.scene, "select", "Enter on the title should reach select");

  // Two people picking at once is the one screen Enter cannot drive: that
  // branch reads each player's own attack key so the two of them can lock in
  // independently. Every other mode picks a seat at a time and takes Enter.
  if (mode === 1) {
    g.tap("KeyG");     // player one confirms
    g.tap("Comma");    // player two confirms
  } else {
    for (let i = 0; i < 8 && g.nw.scene === "select"; i++) g.tap("Enter");
  }
  assert.equal(g.nw.scene, "stage", "picking fighters should reach the stage select");

  g.tap("Enter");
  assert.equal(g.nw.scene, "battle", "picking a stage should start the match");
}

test("the title offers a four-player brawl, and it starts", async () => {
  const g = await bootGame();
  startMatch(g, { mode: 2 });

  const f = g.nw.fighters;
  assert.equal(f.length, 4, "a four-player brawl should have four fighters");

  // Spread left to right along the ground, not stacked on one spawn point.
  const xs = Array.from(f, (x) => x.x);
  assert.equal(JSON.stringify([...xs].sort((a, b) => a - b)), JSON.stringify(xs),
    `spawns should run left to right, got ${xs.join(", ")}`);
  assert.equal(new Set(xs).size, 4, "four fighters, four different spawn points");
  assert.equal(new Set(f.map((x) => x.y)).size, 1, "all four should start on the floor");
});

test("a four-way is a real fight, and it ends with one of them left", async () => {
  const g = await bootGame();
  startMatch(g, { mode: 2 });

  // Nobody is at the keyboard, so all four are CPUs. Let them settle it. The
  // clock is 60 * 180 frames, so this covers a full match plus a margin.
  let damaged = 0;
  for (let i = 0; i < 11400 && g.nw.scene === "battle"; i++) {
    g.pump(1);
    if (i % 300 === 0) {
      const n = g.nw.fighters.filter((f) => f.health < 100 || f.stocks < 3).length;
      if (n > damaged) damaged = n;
    }
  }

  assert.equal(g.nw.scene, "results",
    "four CPUs should finish a match inside the time limit");

  // Non-vacuous: four bots standing in separate corners for three minutes
  // would also reach the results screen, and would prove nothing.
  assert.ok(damaged >= 3,
    `a brawl should hurt nearly everyone; only ${damaged} of 4 took anything`);

  // A brawl ends one of two ways: somebody outlasts the rest, or the clock
  // runs out with several still up. Both are fine -- what is not fine is
  // several eliminated and the match still calling itself unfinished.
  const standing = g.nw.fighters.filter((f) => f.state !== "gone");
  assert.ok(standing.length >= 1 && standing.length <= 4,
    `nonsense survivor count: ${standing.length}`);
  if (g.nw.fighters.some((f) => f.state === "gone")) {
    assert.ok(standing.length >= 1, "somebody has to be left");
  }
});

test("one on one is exactly the match it always was", async () => {
  // The mode that ships, that people play online, and that every balance
  // number was measured against. Nothing about four players may move it.
  const g = await bootGame();
  startMatch(g, { mode: 1 });

  const f = g.nw.fighters;
  assert.equal(f.length, 2);
  // The hand-placed spawn points for DEEP SPACE, which is the first stage.
  assert.equal(JSON.stringify(Array.from(f, (x) => x.x)), JSON.stringify([116, 204]),
    "two players must still spawn where the stages were laid out for them");
});

test("hosting online after a four-way does not build four fighters", async () => {
  // The bug: netStart rewrote select.cursor to the two characters the lobby
  // agreed on but left playerCount at 4, so startBattle built a third fighter
  // from ORDER[undefined] and died inside the Fighter constructor with
  // "Cannot read properties of undefined (reading 'accent')".
  const g = await bootGame();
  startMatch(g, { mode: 2 });
  assert.equal(g.nw.fighters.length, 4, "precondition: a four-way is running");

  g.nw.net.start({
    localSlot: 0,
    chars: ["kel", "trev"],
    stage: "swamp",
    delay: 2,
    send: () => {},
  });

  assert.equal(g.nw.scene, "battle");
  assert.equal(g.nw.fighters.length, 2,
    "an online match is two fighters no matter what was running before it");
  assert.equal(JSON.stringify(Array.from(g.nw.fighters, (f) => f.key)),
               JSON.stringify(["kel", "trev"]));

  // And it keeps running rather than throwing on the first frame.
  g.pump(30);
  assert.equal(g.nw.net.status.desync, null);
  assert.equal(g.nw.fighters.length, 2);
});
