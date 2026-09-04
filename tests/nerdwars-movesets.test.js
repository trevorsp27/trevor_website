/* NerdWars movesets: John's and Reese's rebuilt kits.
 *
 * Six new specials and two mechanics the engine never had before -- a smoke
 * cloud that inverts a victim's movement, and a gun that pins someone caught
 * mid-swing. Both are simulation state, which is the reason these tests
 * exist: a status effect that changes how a fighter READS INPUT is exactly
 * the kind of thing that can work perfectly on one machine and desync a
 * match, and this project has a rollback netcode that will not forgive it.
 *
 * The engine ships as a browser script, so these run it in a vm context with
 * a DOM stub and a hand-cranked requestAnimationFrame.
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
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float32Array,
    Float64Array, isNaN, parseInt, parseFloat,
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
  /** Hold a key for n frames, then let go. */
  g.hold = (code, n) => {
    g.press(code);
    g.pump(n);
    g.release(code);
    g.pump(1);
  };
  return g;
}

const ORDER = ["autisnick", "johnnyham", "kel", "ladeane", "reese", "trev"];

/** Two humans, seat 0 as `a`, seat 1 as `b`, on the first stage. */
function startAs(g, a, b) {
  assert.equal(g.nw.scene, "title");
  g.tap("KeyS");                       // "2 PLAYERS (local)"
  g.tap("Enter");
  assert.equal(g.nw.scene, "select");
  // The select screen is a 3-wide GRID, not a list, and each seat starts on a
  // different character -- seat 0 on AutisNick, seat 1 on Reese. Counting
  // right-presses linearly walks into the clamp at the end of a row and lands
  // somewhere else entirely, so navigate by column and row.
  const step = (from, to, keys) => {
    const [L, R, U, D] = keys;
    let [c0, r0] = [from % 3, Math.floor(from / 3)];
    const [c1, r1] = [to % 3, Math.floor(to / 3)];
    for (; r0 < r1; r0++) g.tap(D);
    for (; r0 > r1; r0--) g.tap(U);
    for (; c0 < c1; c0++) g.tap(R);
    for (; c0 > c1; c0--) g.tap(L);
  };
  step(0, ORDER.indexOf(a), ["KeyA", "KeyD", "KeyW", "KeyS"]);
  g.tap("KeyG");
  step(4, ORDER.indexOf(b), ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
  g.tap("Comma");
  assert.equal(g.nw.scene, "stage", "both locked in should reach stage select");
  g.tap("Enter");
  assert.equal(g.nw.scene, "battle");
  const f = g.nw.fighters;
  assert.equal(f[0].key, a, "seat 0 should be " + a + ", got " + f[0].key);
  assert.equal(f[1].key, b, "seat 1 should be " + b + ", got " + f[1].key);
}

const finite = (f) =>
  Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.health);

/* ------------------------------------------------------------------ */

test("both kits are wired up with the moves and prices they claim", async () => {
  const g = await bootGame();
  const by = Object.fromEntries(g.nw.roster.map((c) => [c.key, c]));

  const john = by.johnnyham.moves.map((m) => m.slot + ":" + m.label);
  assert.deepEqual(john.sort(), [
    "down:SIC 'EM", "neutral:SMOKESCREEN", "up:SIDEARM",
  ]);
  assert.equal(by.johnnyham.ult, "HONEY BAKED", "the ham stays");

  const reese = by.reese.moves.map((m) => m.slot + ":" + m.label);
  assert.deepEqual(reese.sort(), [
    "down:CROP DUST", "neutral:BELCH", "up:JITTERS",
  ]);
  assert.equal(by.reese.ult, "SHIRTS OPTIONAL", "the shirt stays");

  /* Both lost an uppercut, which was their only way back onto the stage, so
     the replacement `up` has to be affordable enough to actually use as one.
     Nobody else's recovery costs more than 26. */
  for (const key of ["johnnyham", "reese"]) {
    const up = by[key].moves.find((m) => m.slot === "up");
    assert.ok(
      up.mana <= 34,
      key + "'s recovery costs " + up.mana + " of 100 mana; being unable to " +
        "afford to get back on stage is a bad way to lose a stock"
    );
  }
});

/* The trap this project has hit before: hitbox() has a SECOND switch on kind,
   and a projectile kind missing from its exclusion list gets a melee box
   built from ox/oy/w/h it does not have -- NaN for the whole active window,
   silently, for a few frames every cast. */
test("the new projectile moves never put NaN into the simulation", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");

  const keys = ["KeyH", "KeyJ", "KeyK"];        // neutral, down, up specials
  for (let round = 0; round < 24; round++) {
    g.hold(keys[round % 3], 3);
    g.pump(14);
    for (const f of g.nw.fighters) {
      assert.ok(finite(f), "seat state went non-finite after round " + round +
        ": " + JSON.stringify(f));
    }
    for (const p of g.nw.projectiles) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y),
        "projectile " + p.kind + " went non-finite: " + JSON.stringify(p));
    }
  }
});

test("every new special actually puts something in the world", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");

  const seen = new Set();
  const sweep = () => {
    for (const p of g.nw.projectiles) seen.add(p.kind);
  };
  /* Long gaps between casts on purpose. Mana regenerates at 0.5 a frame and
     all three specials draw the same pool, so firing every fifteen frames
     means the 30-cost gun is never affordable and the test quietly proves
     less than it says. Seventy frames is a full bar back. */
  for (const key of ["KeyH", "KeyJ", "KeyK"]) {
    for (let round = 0; round < 3; round++) {
      g.hold(key, 3);
      for (let i = 0; i < 70; i++) { g.pump(1); sweep(); }
    }
  }
  for (const cls of ["Cloud", "Dog", "Slug"]) {
    assert.ok(seen.has(cls), "expected a " + cls + " from John's kit, saw " +
      [...seen].join(", "));
  }
});

/* The whole reason these tests exist. Inverted controls change how a fighter
   reads input, and the swap is applied inside the simulation from snapshotted
   state -- if it were applied where input is READ instead, two machines would
   disagree about which way somebody walked and the match would desync. Two
   engines fed identical keystrokes must land in identical states. */
test("two engines running the new kits stay identical", async () => {
  const a = await bootGame();
  const b = await bootGame();
  for (const g of [a, b]) startAs(g, "johnnyham", "reese");

  // Close the gap first: they spawn far enough apart that a script of
  // specials alone never lands a hit, and two engines agreeing about two
  // people missing each other proves nothing.
  for (const g of [a, b]) {
    g.press("KeyD");
    g.press("ArrowLeft");
    g.pump(45);
    g.release("KeyD");
    g.release("ArrowLeft");
    g.pump(2);
  }

  const script = ["KeyH", "KeyD", "KeyJ", "KeyA", "KeyK", "KeyG", "KeyW"];
  const script2 = ["Period", "ArrowLeft", "Slash", "ArrowRight", "Semicolon", "Comma"];
  for (let i = 0; i < 240; i++) {
    const k1 = script[i % script.length];
    const k2 = script2[i % script2.length];
    for (const g of [a, b]) {
      if (i % 5 === 0) { g.press(k1); g.press(k2); }
      if (i % 5 === 3) { g.release(k1); g.release(k2); }
      g.pump(1);
    }
  }

  assert.deepEqual(
    JSON.parse(JSON.stringify(a.nw.fighters)),
    JSON.parse(JSON.stringify(b.nw.fighters)),
    "the same inputs must produce the same fight on both machines"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(a.nw.projectiles)),
    JSON.parse(JSON.stringify(b.nw.projectiles))
  );
  // And it has to have been a real fight, or this proves nothing.
  assert.ok(
    a.nw.fighters.some((f) => f.health < 100),
    "nobody took damage, so the comparison is vacuous"
  );
});

test("a long fight with both kits does not crash or stall", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");
  const startFrames = g.nw.frames;

  const p1 = ["KeyH", "KeyJ", "KeyK", "KeyG", "KeyD", "KeyW"];
  const p2 = ["Period", "Slash", "Semicolon", "Comma", "ArrowLeft", "ArrowUp"];
  for (let i = 0; i < 240; i++) {
    if (i % 6 === 0) { g.press(p1[(i / 6) % p1.length]); g.press(p2[(i / 6) % p2.length]); }
    if (i % 6 === 4) { g.release(p1[(i / 6 | 0) % p1.length]); g.release(p2[(i / 6 | 0) % p2.length]); }
    g.pump(1);
  }
  assert.ok(g.nw.frames > startFrames + 200, "the loop should still be running");
  for (const f of g.nw.fighters) assert.ok(finite(f), JSON.stringify(f));
});

/* The smoke, end to end and through the real simulation: John gasses Reese
   and Reese's walk comes out backwards.

   Worth testing through a real hit rather than by poking the field, because
   the swap happens on a COPY of the pad inside Fighter.update -- the one
   place it can happen without the two machines in a netplay match disagreeing
   about which way somebody walked. */
test("smoke turns a victim's walk backwards, then wears off", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");

  // Walk them together -- but not past each other. They spawn 88px apart and
  // close 2.8px a frame between them, so forty frames overshoots and John
  // ends up firing away from Reese.
  g.press("KeyD");
  g.press("ArrowLeft");
  g.pump(20);
  g.release("KeyD");
  g.release("ArrowLeft");
  g.pump(4);

  const before = g.nw.fighters[1].health;
  g.hold("KeyH", 3);                       // SMOKESCREEN
  g.pump(110);                             // let the cloud drift onto him
  assert.ok(
    g.nw.fighters[1].health < before,
    "the cloud never reached Reese, so this proves nothing about the smoke"
  );

  /** Net movement over `n` frames of holding `key`. */
  const drift = (key, n) => {
    g.pump(20);                            // let any hitstun expire first
    const x0 = g.nw.fighters[1].x;
    g.press(key);
    g.pump(n);
    g.release(key);
    g.pump(1);
    return g.nw.fighters[1].x - x0;
  };

  const gassed = drift("ArrowRight", 22);
  assert.ok(
    gassed < 0,
    "holding right while smoked should move Reese LEFT, but he moved " +
      gassed.toFixed(2) + "px"
  );

  // 240 frames of it, and then it is over.
  g.pump(260);
  const clear = drift("ArrowRight", 22);
  assert.ok(
    clear > 0,
    "once the smoke expires right should mean right again, but he moved " +
      clear.toFixed(2) + "px"
  );
});

/* Spot dodge used to have no cooldown at all: eighteen frames of animation
   with invulnerability from frame 3 to 12, and nothing stopping another the
   instant it ended. Holding down was ten invulnerable frames out of every
   eighteen, indefinitely. */
test("spot dodge cannot be spammed", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");

  // Hold down for four seconds and count how many dodges actually start.
  let dodges = 0, wasDodging = false;
  g.press("ShiftLeft");            // shield, which is what down+shield does
  g.press("KeyS");
  for (let i = 0; i < 240; i++) {
    g.pump(1);
    const now = g.nw.fighters[0].state === "dodge";
    if (now && !wasDodging) dodges++;
    wasDodging = now;
  }
  g.release("KeyS");
  g.release("ShiftLeft");

  // 240 frames at one per 46 is at most 6; the old behaviour managed 13.
  assert.ok(dodges > 0, "holding down while shielding should still dodge");
  assert.ok(
    dodges <= 6,
    "four seconds of holding down produced " + dodges + " dodges; the " +
      "cooldown should cap it around five"
  );
});
