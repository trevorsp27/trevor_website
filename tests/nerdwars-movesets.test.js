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
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set, Number,
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
/* Walk them toward each other until they are actually within `gap`, rather
   than for a number of frames that happened to work on the stage as it was
   laid out that week. DEEP SPACE was widened from 176 to 240 and every
   fixed-frame version of this quietly stopped arriving -- which is the worst
   way for a test to fail, because "the cloud never reached him" and "the
   cloud does nothing" look identical from here. */
function closeToGap(g, gap, cap = 240) {
  const apart = () => Math.abs(g.nw.fighters[0].x - g.nw.fighters[1].x);
  g.press("KeyD"); g.press("ArrowLeft");
  let n = 0;
  while (n < cap && apart() > gap) { g.pump(1); n++; }
  g.release("KeyD"); g.release("ArrowLeft");
  g.pump(3);
  assert.ok(apart() <= gap + 6,
    "could not get the two fighters within " + gap + "px in " + cap +
    " frames; they are " + apart().toFixed(0) + "px apart, so whatever this " +
    "test goes on to assert would be about nothing");
  return apart();
}

test("smoke turns a victim's walk backwards, then wears off", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");

  // Close to a measured distance rather than a counted one: near enough for
  // the cloud to drift onto him, not so near they walk past each other.
  closeToGap(g, 34);

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

  /* And then it is over. The wait is deliberately longer than the duration
     rather than equal to it: confusion ticks inside update(), BELOW the
     `if (this.hitstop > 0) return`, so a trade during the smoke stretches it
     past its nominal length in wall-clock frames. */
  g.pump(260);
  const clear = drift("ArrowRight", 22);
  assert.ok(
    clear > 0,
    "once the smoke expires right should mean right again, but he moved " +
      clear.toFixed(2) + "px"
  );
});

/* Evasion uptime.
 *
 * The shield button does two things -- with a direction it rolls, with down
 * it spot dodges -- and neither had a cooldown, so either could be held
 * forever. The first attempt at this capped only the dodge, which did work
 * and changed nothing anybody could feel: the roll has the LONGER
 * invulnerability window (12 frames of 20 against 10 of 18), so capping the
 * dodge alone just moved everyone onto the better option. Measured over four
 * seconds it was dodge 56%, roll 40%.
 *
 * Hence one shared timer. Separate ones would let roll, dodge, roll alternate
 * two cooldowns and beat both.
 */
function evasionStarts(g, drive) {
  let starts = 0, prev = null;
  g.press("ShiftLeft");
  for (let i = 0; i < 240; i++) {
    drive(i);
    g.pump(1);
    const st = g.nw.fighters[0].state;
    if ((st === "roll" || st === "dodge") && st !== prev) starts++;
    prev = st;
  }
  g.release("ShiftLeft");
  return starts;
}

test("neither evasion can be spammed, and alternating them does not help", async () => {
  for (const [label, drive, cap] of [
    ["spot dodge", (g) => (i) => { if (i === 0) g.press("KeyS"); }, 6],
    /* Fresh presses, not a held direction. Raising the shield with a
       direction already down now BLOCKS -- that is the point of the change --
       so a roll has to be asked for the way a person asks for one: shield up,
       then tap. Holding KeyD for four seconds is a request to stand still. */
    ["roll", (g) => (i) => {
      if (i % 20 === 0) g.press("KeyD");
      if (i % 20 === 6) g.release("KeyD");
    }, 6],
    ["alternating", (g) => (i) => {
      if (i % 20 === 0) { g.release("KeyS"); g.press("KeyD"); }
      if (i % 20 === 10) { g.release("KeyD"); g.press("KeyS"); }
    }, 6],
  ]) {
    const g = await bootGame();
    startAs(g, "johnnyham", "reese");
    const n = evasionStarts(g, drive(g));
    assert.ok(n > 0, label + " should still be usable at all");
    assert.ok(
      n <= cap,
      "four seconds of " + label + " produced " + n + " evasions; the shared " +
        "cooldown should cap it near five. Uncapped, roll manages 8."
    );
  }
});

/* Trev's rebuilt kit and Kel's ult.
 *
 * The guillotine is the only grab in the game and the only thing that beats a
 * raised shield, so both of those are asserted rather than assumed. The
 * dangerous failure is not that it fails to grab -- it is a victim left held
 * for the rest of the match because the link broke at one end and nothing let
 * go at the other, which is why every case here ends by checking nobody is
 * still stuck.
 */
function waitOutSpawnInvuln(g) {
  g.pump(130);                      // COMBAT.respawnInvuln is 110
}



test("Trev's kit is the pawn and the fishing pole", async () => {
  const g = await bootGame();
  const trev = g.nw.roster.find((c) => c.key === "trev");
  assert.deepEqual(
    trev.moves.map((m) => m.slot + ":" + m.label).sort(),
    ["down:FISHING POLE", "neutral:CEREAL", "up:PAWN"]
  );
  assert.equal(trev.ult, "LASER SWORD", "the sword stays");
});

test("a tapped pawn walks off in front of him", async () => {
  /* PAWN replaced KNIGHT, and KNIGHT was his recovery -- two squares up and
     one across, generous on the vertical precisely because it was his way
     home. The test that used to live here asserted exactly that ("it is his
     only recovery; it rose Npx") and it is gone with the move it guarded.

     Off the stage he is down to his double jump now. That is a real loss and
     it is deliberate, not an oversight: the brief was to rework the move
     completely, and a pawn walking forwards does nothing for a man falling.
     What is guarded here instead is the thing the move actually does. */
  const g = await bootGame();
  startAs(g, "trev", "reese");
  waitOutSpawnInvuln(g);
  const pawns = () => g.nw.projectiles.filter((p) => p.kind === "Pawn");

  assert.equal(pawns().length, 0, "nothing out before he presses anything");
  g.press("KeyK"); g.pump(2); g.release("KeyK");
  g.pump(12);
  assert.equal(pawns().length, 1, "tapping should send one pawn");

  const start = pawns()[0].x;
  const facing = g.nw.fighters[0].x < g.nw.fighters[1].x ? 1 : -1;
  g.pump(40);
  const later = pawns()[0];
  assert.ok(later, "and it should still be out: it is slow on purpose");
  const travelled = (later.x - start) * facing;
  assert.ok(travelled > 10,
    "it should walk the way he is looking; moved " + travelled.toFixed(1) + "px");
  assert.ok(travelled < 60,
    "and slowly -- 40 frames should not cross the stage; moved " +
    travelled.toFixed(1) + "px");
});

test("the guillotine grabs through a raised shield and always lets go", async () => {
  for (const shielding of [false, true]) {
    const g = await bootGame();
    startAs(g, "trev", "reese");
    waitOutSpawnInvuln(g);
    closeToGap(g, 22);
    const V = () => g.nw.fighters[1];
    const hp0 = V().health;

    if (shielding) g.press("ShiftRight");
    g.press("KeyJ"); g.pump(3); g.release("KeyJ");
    let grabbed = false;
    for (let i = 0; i < 120; i++) {
      g.pump(1);
      if (V().state === "grabbed") grabbed = true;
    }
    if (shielding) g.release("ShiftRight");

    assert.ok(grabbed, "should grab even while " + (shielding ? "shielding" : "idle"));
    assert.ok(V().health < hp0, "and hurt them");
    assert.notEqual(V().state, "grabbed",
      "nobody may still be held after the throw -- that would lock them out " +
        "of the rest of the match");
  }
});

test("the throw goes where it is aimed", async () => {
  const outcomes = {};
  for (const [name, key] of [["forward", null], ["up", "KeyW"], ["back", "KeyA"]]) {
    const g = await bootGame();
    startAs(g, "trev", "reese");
    waitOutSpawnInvuln(g);
    closeToGap(g, 22);
    const V = () => g.nw.fighters[1];

    g.press("KeyJ"); g.pump(3); g.release("KeyJ");
    if (key) g.press(key);
    let released = null;
    for (let i = 0; i < 120; i++) {
      g.pump(1);
      if (released === null && V().state === "grabbed") released = "held";
      if (released === "held" && V().state !== "grabbed") {
        released = { x: V().x, y: V().y, at: i };
      }
    }
    // Where they ended up a dozen frames after being let go.
    outcomes[name] = { dx: V().x - released.x, dy: V().y - released.y };
    if (key) g.release(key);
  }
  assert.ok(outcomes.forward.dx > 5, "forward should send them forward");
  assert.ok(outcomes.back.dx < -5,
    "back should send them the other way, got dx=" + outcomes.back.dx.toFixed(0));
  assert.ok(Math.abs(outcomes.up.dx) < Math.abs(outcomes.forward.dx),
    "up should be more vertical than forward");
});

/* Kel's ult: the floor comes up, and only the people standing on it care.
 *
 * This one has to earn its meter the hard way -- there is no test hook to
 * fill it, and adding one would be production surface for a test. Two things
 * make it possible at all: the MATRIX stage, which is the only fully enclosed
 * arena, so nobody can be knocked out and end the match early; and a dense
 * jab loop, because on an open stage Kel just launches his opponent away and
 * the meter plateaus around 38.
 */
async function kelWithFullMeter() {
  const g = await bootGame();
  assert.equal(g.nw.scene, "title");
  g.tap("KeyS"); g.tap("Enter");
  g.tap("KeyD"); g.tap("KeyD");            // seat 0 -> kel
  g.tap("KeyG");
  g.tap("Comma");                          // seat 1 defaults to reese
  g.tap("KeyD"); g.tap("KeyD");            // stage -> matrix, the enclosed one
  g.tap("Enter");
  assert.equal(g.nw.scene, "battle");
  assert.equal(g.nw.fighters[0].key, "kel");
  g.pump(130);

  const K = () => g.nw.fighters[0], V = () => g.nw.fighters[1];
  for (let round = 0; round < 420 && K().ult < 100; round++) {
    const gap = V().x - K().x;
    if (Math.abs(gap) > 11) {
      const k = gap > 0 ? "KeyD" : "KeyA";
      g.press(k); g.pump(4); g.release(k);
    }
    g.press("KeyG"); g.pump(2); g.release("KeyG"); g.pump(11);
  }
  assert.equal(K().ult, 100, "could not fill the ult meter, so nothing below means anything");
  return g;
}

test("LEG DAY launches whoever is standing and spares whoever is not", async () => {
  // On the ground.
  {
    const g = await kelWithFullMeter();
    const V = () => g.nw.fighters[1];
    g.pump(30);
    const hp0 = V().health;
    g.press("KeyL"); g.pump(3); g.release("KeyL");
    for (let i = 0; i < 60; i++) g.pump(1);
    assert.ok(V().health < hp0,
      "somebody standing on the floor should be hit, took " + (hp0 - V().health));
  }
  // In the air.
  {
    const g = await kelWithFullMeter();
    const V = () => g.nw.fighters[1];
    g.pump(30);
    /* Order matters and so does the count. The ult has 20 frames of startup,
       so the jump has to still be in the air when the floor moves -- and the
       first version of this pumped only 10 frames after pressing it, which
       meant the ult had not fired yet and the assertion passed for the wrong
       reason. Ult first, jump into its startup, then let it land. */
    const hp0 = V().health;
    g.press("KeyL"); g.pump(3); g.release("KeyL");
    g.pump(8);
    g.press("ArrowUp"); g.pump(2); g.release("ArrowUp");
    let airborneWhenItLanded = null;
    for (let i = 0; i < 30; i++) {
      g.pump(1);
      if (i === 9) airborneWhenItLanded = V().state === "air";
    }
    assert.ok(airborneWhenItLanded,
      "the victim has to actually be off the ground when the floor moves, " +
        "or this proves nothing");
    assert.equal(V().health, hp0,
      "jumping is the answer to it -- an airborne fighter should take nothing");
  }
});


/* Shield is the "stop what I am doing" button, so it has to outrank whatever
   you were already doing. It used to be the opposite: shield plus a direction
   WAS the roll, so pressing block while running rolled you instead, and the
   only way to block at all was to come to a stop first and then press it.
 */
test("shield blocks and stops you even with a direction held", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");
  g.pump(130);                       // past spawn invulnerability

  // Get moving properly first, or "it stopped" proves nothing.
  const f = () => g.nw.fighters[0];
  const startX = f().x;
  g.press("KeyD");
  g.pump(20);
  const movingX = f().x;
  assert.equal(f().state, "walk", "should be walking before the shield goes up");

  // Shield WITHOUT letting go of the direction.
  g.press("ShiftLeft");
  g.pump(2);
  assert.equal(
    f().state, "shield",
    "raising the shield while holding a direction must block, not roll -- " +
      "got state " + JSON.stringify(f().state)
  );

  const stoppedX = f().x;
  g.pump(12);
  assert.ok(
    Math.abs(f().x - stoppedX) < 1,
    "and it should stop dead, not skid: drifted " +
      (f().x - stoppedX).toFixed(2) + "px while blocking"
  );
  assert.ok(
    movingX > startX + 4,
    "sanity: it should have walked somewhere before the shield went up, but " +
      "only covered " + (movingX - startX).toFixed(1) + "px"
  );

  // The roll is still there -- it just wants a fresh press.
  g.release("KeyD");
  g.pump(2);
  g.press("KeyD");
  g.pump(2);
  assert.equal(
    f().state, "roll",
    "letting go and pressing again, while still shielding, should roll -- " +
      "otherwise the change cost the roll entirely"
  );
  g.release("KeyD");
  g.release("ShiftLeft");
});


/* ------------------------------------------------------------------ *
 * The grab everybody has, and the one that is still Trev's.
 * ------------------------------------------------------------------ */

test("every character can grab, and it beats a raised shield", async () => {
  /* The roster had no answer to a held shield except Trev's, which is a lot
     to hang on one character being picked. Y is that answer now, so it is
     checked on somebody who owns no grab of their own. */
  const g = await bootGame();
  startAs(g, "kel", "reese");
  g.pump(130);
  closeToGap(g, 18);

  const V = () => g.nw.fighters[1];
  g.press("ShiftRight");                 // seat 1 blocks
  g.pump(6);
  assert.equal(V().state, "shield", "precondition: the victim is shielding");

  g.press("KeyY");
  g.pump(2);
  g.release("KeyY");
  let grabbed = false;
  for (let i = 0; i < 40 && !grabbed; i++) {
    g.pump(1);
    if (V().state === "grabbed") grabbed = true;
  }
  g.release("ShiftRight");
  assert.ok(grabbed,
    "Y should grab straight through a raised shield; the victim never left " +
    "state " + JSON.stringify(V().state));

  let freed = false;
  for (let i = 0; i < 160 && !freed; i++) {
    g.pump(1);
    if (V().state !== "grabbed") freed = true;
  }
  assert.ok(freed, "a grab that never releases ends the match for the victim");
});

test("the fishing pole reaches further than a bare grab, and throws harder", async () => {
  /* Both of the things that make it worth one of his three slots, measured
     rather than read back out of the spec it was written into. */
  const attempt = async (key, gap) => {
    const g = await bootGame();
    startAs(g, "trev", "reese");
    g.pump(130);
    closeToGap(g, gap);
    const V = () => g.nw.fighters[1];
    g.press(key); g.pump(3); g.release(key);
    let held = false, at = null, dist = null;
    for (let i = 0; i < 150; i++) {
      g.pump(1);
      if (V().state === "grabbed") held = true;
      else if (held && at === null) at = { x: V().x, i: i };
      if (at && i === at.i + 14) { dist = Math.abs(V().x - at.x); break; }
    }
    return { caught: held, thrown: dist };
  };

  const reach = async (key) => {
    let best = 0;
    for (const gap of [14, 22, 30, 38, 46]) {
      const r = await attempt(key, gap);
      if (r.caught) best = gap;
    }
    return best;
  };
  const poleReach = await reach("KeyJ");
  const bareReach = await reach("KeyY");
  assert.ok(bareReach > 0, "the bare grab should connect at SOME range");
  assert.ok(
    poleReach > bareReach,
    "the pole reached " + poleReach + "px and the bare grab " + bareReach +
    "px; if his own grab is not longer than the free one it is not a slot"
  );

  const poleThrow = (await attempt("KeyJ", 16)).thrown;
  const bareThrow = (await attempt("KeyY", 16)).thrown;
  assert.ok(poleThrow !== null && bareThrow !== null, "both should land and let go");
  assert.ok(
    poleThrow > bareThrow + 3,
    "the pole threw " + poleThrow.toFixed(0) + "px and the bare grab " +
    bareThrow.toFixed(0) + "px -- his is the one meant to end stocks"
  );
});

/* ------------------------------------------------------------------ *
 * John's dog: one out at a time, and it answers the button.
 * ------------------------------------------------------------------ */

const dogsOut = (g) => g.nw.projectiles.filter((b) => b.kind === "Dog").length;
const theDog = (g) => g.nw.projectiles.find((b) => b.kind === "Dog");

test("John gets one dog, and pressing again makes it jump", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");
  g.pump(130);

  g.press("KeyJ"); g.pump(3); g.release("KeyJ");   // SIC 'EM
  g.pump(20);
  assert.equal(dogsOut(g), 1, "one dog after one press");

  /* Three separate things swallow a single well-timed press, and between
     them they cost an afternoon: SIC 'EM runs 36 frames and the press is
     edge-triggered, so one sent mid-cast is dropped; the special branch sits
     behind `landLag <= 0`; and update() returns early during hitstop, which
     John is in constantly because his own dog keeps connecting. None of that
     is new -- it is true of every input in the game -- so the test presses
     the way a player does, more than once, and checks the invariant that
     actually matters on every single frame: there is never a second dog. */
  g.pump(40);
  const resting = theDog(g).y;

  let rose = false;
  let everTwo = false;
  for (let attempt = 0; attempt < 8 && !rose; attempt++) {
    g.press("KeyJ"); g.pump(2); g.release("KeyJ");
    for (let i = 0; i < 8 && !rose; i++) {
      g.pump(1);
      if (dogsOut(g) > 1) everTwo = true;
      const d = theDog(g);
      if (d && d.y < resting - 4) rose = true;
    }
  }
  assert.ok(!everTwo,
    "pressing again must command the dog, never fetch a second one");
  assert.ok(rose,
    "the dog should jump when the button is pressed again; it never left " +
    "y=" + resting);
});

test("a new dog waits for the old one to leave the screen", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");
  g.pump(130);
  g.press("KeyJ"); g.pump(3); g.release("KeyJ");
  g.pump(20);
  assert.equal(dogsOut(g), 1);

  for (let i = 0; i < 400 && dogsOut(g) > 0; i++) g.pump(1);
  assert.equal(dogsOut(g), 0, "the dog should eventually run off the screen");

  g.press("KeyJ"); g.pump(3); g.release("KeyJ");
  g.pump(20);
  assert.equal(dogsOut(g), 1, "with the first one gone, a second is allowed");
});

/* maxAlive used to count every projectile a fighter owned, so one move's cap
 * was spent by a different move's projectile: a smoke cloud in the air stopped
 * John calling his dog, and a bone still rolling stopped Kel dropping a
 * weight. Both looked simply broken, because nothing on screen connects a
 * cloud to a dog.
 */
test("one move's projectile does not spend another move's limit", async () => {
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");
  g.pump(130);

  g.press("KeyH"); g.pump(3); g.release("KeyH");        // SMOKESCREEN
  g.pump(50);
  const clouds = g.nw.projectiles.filter((b) => b.kind === "Cloud").length;
  assert.ok(clouds > 0,
    "precondition: the smoke should be in the air, saw " +
    JSON.stringify(g.nw.projectiles.map((b) => b.kind)));

  g.press("KeyJ"); g.pump(3); g.release("KeyJ");        // SIC 'EM
  g.pump(25);
  assert.equal(dogsOut(g), 1,
    "a cloud is not a dog and must not occupy the dog's one slot. Projectiles " +
    "out: " + JSON.stringify(g.nw.projectiles.map((b) => b.kind)));
});

test("a move still caps itself", async () => {
  /* The other half, and the one that breaks if the fix is too broad: SIC 'EM
     is meant to allow exactly one dog, which is what the whole leap mechanic
     rests on. */
  const g = await bootGame();
  startAs(g, "johnnyham", "reese");
  g.pump(130);
  g.press("KeyJ"); g.pump(3); g.release("KeyJ");
  g.pump(50);
  assert.equal(dogsOut(g), 1, "precondition: one dog");

  for (let i = 0; i < 4; i++) {
    g.press("KeyJ"); g.pump(2); g.release("KeyJ"); g.pump(8);
    assert.equal(dogsOut(g), 1, "still exactly one dog after press " + (i + 2));
  }
});
