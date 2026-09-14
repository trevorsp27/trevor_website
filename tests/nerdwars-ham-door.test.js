/* The ham and the trapdoor: HamDrop asks for its floor every frame now.
 *
 * HONEY BAKED aims at the nearest opponent's feet and comes down from the
 * top of the screen. The surface it lands on is not "the first platform it
 * crosses" -- that put it on the balcony over the target's head -- but the
 * highest platform under its x that is not above the target's feet. Until
 * 2.54 that answer was worked out ONCE, in the constructor, and update()
 * fell toward a fixed groundY for the rest of the drop.
 *
 * BATTLEFIELD broke the assumption behind that. Its top row has a trapdoor,
 * and platformsNow() exists precisely so that a thing which falls through
 * an open door does so everywhere in the engine. The ham did ask
 * platformsNow() -- but only at cast, so if the door was shut when John
 * pointed at the sky and opened during the thirty frames of fall, the ham
 * "landed" at the door's y over an open hole: crater, both Shock waves and
 * the chunk fan going off in midair while the target who armed the door had
 * already dropped to the platform underneath. Deterministic on both
 * machines, so never a desync, only a whiff. The fix moved the scan into
 * HamDrop.groundUnder(), remembered the target's foot height as `ty` (a
 * plain number, because saveSim copies own fields and a rollback has to
 * rebuild a mid-fall ham that still knows what to ignore), and asks it again
 * on every frame of update().
 *
 * Each behavior here is pinned twice: once against the engine as shipped,
 * and once against an in-memory copy with the guard it protects undone,
 * which has to make the SAME assertion fail. A test that survives its own
 * sabotage is measuring nothing, and the trapdoor tests in particular have a
 * lot of numbers that could come out right by accident.
 *
 * These load the engine source, as nerdwars-battlefield.test.js does: HamDrop,
 * platformsNow(), trapArm, trapOpen and saveSim are not on the public
 * surface, and neither is standing a fighter on a chosen platform.
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
// Read once: the sabotage tests hand bootEngine an edited copy of this string.
const ENGINE_SRC = readFileSync(ENGINE_PATH, "utf8");

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

/* The one departure from the shared harness: the engine source is a
   parameter, defaulting to the file on disk, so the sabotage tests can boot
   an edited copy without ever writing one. */
async function bootEngine(source = ENGINE_SRC) {
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
  vm.runInContext(source, sandbox, { filename: "nerdwars.js" });
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

const BATTLEFIELD = 5, DEEP_SPACE = 0;
// ORDER indices: the ham's owner and somebody to drop it on.
const JOHN = 1, KEL = 2;
const ULT = 256;

/* JohnnyHam against Kel on the island, both CPUs, warmed up past the GO!
   banner and the spawn-in. Also installs three helpers INSIDE the vm:

   __place(f, x, y) -- a clean, actionable fighter standing at (x, y). The
     warmup frames run both CPUs off Math.random, so whatever state a fighter
     is in afterward is luck. Stocks are set high so a fall during a test is
     a fall, not a KO and a respawn on the far side of the screen.

   __clean() -- no projectiles, no effects, no freeze, and the door shut and
     unarmed, because a CPU may have wandered across it during the warmup.

   __step(bits0, bits1, pin) -- one frame with those two pads, fed through
     netplay so the CPUs do not build their own. Hitstop is cleared and mana
     pinned every frame, as the other harnesses do; `pin` runs just before
     the step, which is how a test holds the door shut against a fighter
     who is standing on it. */
async function island(source, stage = BATTLEFIELD) {
  const run = await bootEngine(source);
  run("select.cursor=[" + JOHN + "," + KEL + "]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=" + stage + "; startBattle();");
  run("for (var i=0;i<60;i++) step();");
  assert.equal(run("fighters.map(function (f) { return f.key; }).join(',')"),
    "johnnyham,kel", "precondition: ORDER should seat JohnnyHam at " + JOHN + " and Kel at " + KEL);
  run(`
    function __place(f, x, y) {
      f.setState('idle');
      f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
      f.dropThrough = 0; f.invuln = 0; f.confused = 0; f.buffTimer = 0;
      f.mana = 999; f.vx = 0; f.vy = 0; f.grabbing = -1; f.grabbedBy = -1;
      f.grounded = true; f.specialSpawned = false; f.hasHit = false;
      f.attackFrame = 0; f.stocks = 99; f.health = COMBAT.maxHealth;
      f.eliminated = false; f.poison = 0; f.burn = 0; f.drowsy = 0;
      f.x = x; f.y = y; f.prevY = y;
    }
    function __clean() {
      projectiles.length = 0; effects.length = 0; freezeFrames = 0;
      trapArm = 0; trapOpen = 0;
    }
    function __step(bits0, bits1, pin) {
      netplay.active = true;
      for (var k = 0; k < fighters.length; k++) {
        fighters[k].hitstop = 0; fighters[k].mana = 999;
      }
      if (pin) pin();
      netplay.framePads = [bitsToPad(bits0 || 0), bitsToPad(bits1 || 0)];
      step();
      netplay.active = false; netplay.framePads = null;
    }`);
  return run;
}

/* The door, the platform directly under its middle, the main island, and an
   x that is on the door -- read from the stage rather than typed in, so a
   relayout moves the tests with it. */
const GEOMETRY = `
  var door = STAGE.platforms.find(function (p) { return p.trap; }) || null;
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var doorX = door ? Math.floor(door.x + door.w / 2) : -1;
  var below = door ? STAGE.platforms.filter(function (p) {
    return p !== door && p.y > door.y && doorX >= p.x && doorX <= p.x + p.w;
  }).sort(function (a, b) { return a.y - b.y; })[0] : null;
  var me = fighters[0], foe = fighters[1];`;

/* John on the island, the foe wherever the case wants him. */
const STAND = (foeX, foeY) => `
  __clean();
  __place(me, main.x + 40, main.y); me.facing = 1;
  __place(foe, ${foeX}, ${foeY}); foe.facing = -1;`;

/* A ham built by hand and pushed into the world, with its land() wrapped so
   the test reads the y it was actually handed rather than inferring one.
   The wrapper lives on the instance, not the prototype, so nothing leaks
   into the next case. */
const BUILD_HAM = `
  var b = new HamDrop(me, ROSTER.johnnyham.ult);
  var landedAt = null, landedFrame = -1;
  b.land = function (sy) { landedAt = sy; HamDrop.prototype.land.call(this, sy); };
  projectiles.push(b);`;

/* The real path: John presses the button and runSpecial spawns the ham on
   the startup frame. Found in `projectiles` the frame it appears and wrapped
   the same way. */
const CAST_HAM = (frames, pin) => `
  me.ultMeter = COMBAT.ultMax;
  var ham = null, spawnFrame = -1, castLandedAt = null, castLandedFrame = -1;
  for (var i = 0; i < ${frames}; i++) {
    __step(i === 0 ? ${ULT} : 0, 0, ${pin || "null"});
    if (!ham) {
      ham = projectiles.find(function (p) { return p instanceof HamDrop; }) || null;
      if (ham) {
        spawnFrame = i;
        ham.land = function (sy) { castLandedAt = sy; HamDrop.prototype.land.call(this, sy); };
      }
    }
    if (typeof onFrame === 'function') onFrame(i, ham);
    if (ham && ham.dead) { castLandedFrame = i; break; }
  }`;

/* ------------------------------------------------------------------ */

/* Every case is a probe (vm source, returns primitives) and a check
   (assertions on what came back). The tests below run each against the
   engine as shipped; the last test runs each against a copy with its guard
   undone and requires the SAME check to throw. */

const SHUT_DOOR_PROBE = `(function () {
  ${GEOMETRY}
  var HOLD_SHUT = function () { trapArm = 0; };

  // Built by hand.
  ${STAND("doorX", "door.y")}
  ${BUILD_HAM}
  var x0 = b.x, ty0 = b.ty, g0 = b.groundY, openedEver = false;
  for (var i = 0; i < 80 && !b.dead; i++) {
    __step(0, 0, HOLD_SHUT);
    if (trapOpen > 0) openedEver = true;
    if (b.dead) landedFrame = i;
  }
  var deadGround = b.groundY;

  // Cast through the button.
  ${STAND("doorX", "door.y")}
  var onFrame = function () { if (trapOpen > 0) openedEver = true; };
  ${CAST_HAM(120, "HOLD_SHUT")}

  return { doorX: doorX, doorY: door.y, belowY: below.y, x0: x0, ty0: ty0, g0: g0,
           landedAt: landedAt, landedFrame: landedFrame, deadGround: deadGround,
           openedEver: openedEver, spawnFrame: spawnFrame, startup: ROSTER.johnnyham.ult.startup,
           castLandedAt: castLandedAt, castLandedFrame: castLandedFrame };
})()`;

function checkShutDoor(r) {
  assert.equal(r.openedEver, false, "precondition: the door stayed shut for the whole test");
  assert.equal(r.x0, r.doorX, "the ham should be aimed at the foe's x on the door; aimed at " + r.x0);
  assert.equal(r.ty0, r.doorY, "and remember his feet at the door's y; ty was " + r.ty0);
  assert.equal(r.g0, r.doorY,
    "at cast, over a shut door, the floor it is coming down on is the door (y=" +
    r.doorY + "); groundY was " + r.g0);
  assert.ok(r.landedFrame >= 0, "the hand-built ham should have landed within 80 frames");
  assert.equal(r.landedAt, r.doorY,
    "over a shut door the ham should land ON the door, y=" + r.doorY + "; land() was handed " +
    r.landedAt + (r.landedAt === r.belowY ? " -- the platform under the door" : ""));
  assert.equal(r.deadGround, r.doorY,
    "and its groundY on the frame it died should be the door's; it was " + r.deadGround);
  assert.equal(r.spawnFrame, r.startup,
    "precondition: the cast should spawn the ham on the ult's startup frame (" + r.startup +
    "); it appeared on frame " + r.spawnFrame);
  assert.ok(r.castLandedFrame >= 0, "the cast ham should have landed within 120 frames");
  assert.equal(r.castLandedAt, r.doorY,
    "the ham John actually casts should land on the door too, y=" + r.doorY + "; it landed at " +
    r.castLandedAt);
}

const OPEN_DOOR_PROBE = `(function () {
  ${GEOMETRY}

  // The door opened by hand, five frames into the fall.
  ${STAND("doorX", "door.y")}
  ${BUILD_HAM}
  var g0 = b.groundY, footAtOpen = null, gAtOpen = null;
  for (var i = 0; i < 80 && !b.dead; i++) {
    if (i === 5) { trapOpen = 100; footAtOpen = b.y + HAM_FOOT; gAtOpen = b.groundY; }
    __step(0, 0);
    if (b.dead) landedFrame = i;
  }
  var openAtLanding = trapOpen;

  /* The door opened by the engine, on its own timing, under a ham John cast
     at somebody who had already been standing on it. He has stood there
     twenty frames short of arming it when the button goes down; the ham
     spawns on the startup frame and the door gives way while it is still
     well above the row. This is the review's scenario. */
  ${STAND("doorX", "door.y")}
  trapArm = Math.max(0, STAGE.trap.arm - 20);
  /* tickTrap runs before the projectiles update, so on the frame the door
     opens the ham has already been asked again; the floor it was falling
     toward is read off the frame BEFORE. */
  var openFrame = -1, natFootAtOpen = null, natGBeforeOpen = null, prevG = null;
  var onFrame = function (i, h) {
    if (openFrame >= 0) return;
    if (trapOpen > 0) {
      openFrame = i;
      natFootAtOpen = h ? h.y + HAM_FOOT : null;
      natGBeforeOpen = prevG;
    } else {
      prevG = h ? h.groundY : null;
    }
  };
  ${CAST_HAM(160)}

  return { doorY: door.y, belowY: below.y, g0: g0, footAtOpen: footAtOpen, gAtOpen: gAtOpen,
           landedAt: landedAt, landedFrame: landedFrame, openAtLanding: openAtLanding,
           spawnFrame: spawnFrame, openFrame: openFrame, natFootAtOpen: natFootAtOpen,
           natGBeforeOpen: natGBeforeOpen, castLandedAt: castLandedAt,
           castLandedFrame: castLandedFrame, foeY: foe.y };
})()`;

function checkOpenDoor(r) {
  // By hand.
  assert.equal(r.g0, r.doorY, "precondition: at cast the shut door was the floor it picked");
  assert.ok(r.footAtOpen !== null && r.footAtOpen < r.doorY,
    "precondition: the door opened while the ham's underside (" + r.footAtOpen +
    ") was still above the door row (" + r.doorY + ")");
  assert.equal(r.gAtOpen, r.doorY,
    "precondition: the frame before it was thrown open, the ham was still coming down on the door");
  assert.ok(r.landedFrame >= 0, "the ham should have landed within 80 frames");
  assert.ok(r.openAtLanding > 0, "precondition: the door was still open when it landed");
  assert.notEqual(r.landedAt, r.doorY,
    "the door opened under it, and the ham still went off at the door's y=" + r.doorY +
    " -- over an open hole");
  assert.equal(r.landedAt, r.belowY,
    "with the door open the ham should fall through and land on the platform under it, y=" +
    r.belowY + "; it landed at " + r.landedAt);

  // On the engine's own timing.
  assert.ok(r.spawnFrame >= 0, "precondition: the cast ham appeared");
  assert.ok(r.openFrame > r.spawnFrame,
    "precondition: the door should open AFTER the ham is in the air (spawned frame " +
    r.spawnFrame + ", opened frame " + r.openFrame + ")");
  assert.equal(r.natGBeforeOpen, r.doorY,
    "precondition: the frame before it opened, the ham was still coming down on the door; " +
    "groundY read " + r.natGBeforeOpen);
  assert.ok(r.natFootAtOpen < r.doorY,
    "precondition: and was still above the row when it opened (underside at " + r.natFootAtOpen + ")");
  assert.ok(r.castLandedFrame >= 0, "the cast ham should have landed within 160 frames");
  assert.equal(r.castLandedAt, r.belowY,
    "cast at a foe who armed the door, the ham should follow him through it to y=" +
    r.belowY + "; it landed at " + r.castLandedAt +
    (r.castLandedAt === r.doorY ? " -- the door it saw at cast, now open" : ""));
}

/* One stage's worth of the regression: the foe on the main floor with
   platforms over his head, the ham dropped on him, and every platform in its
   column above his feet recorded as crossed or not. `crossed` means the
   ham's underside got more than two pixels past that row while still alive. */
const THROUGH_PROBE = `(function () {
  ${GEOMETRY}
  var foeX = ${"FOE_X"};
  ${STAND("foeX", "main.y")}
  ${BUILD_HAM}
  var above = platformsNow().filter(function (p) {
    return b.x >= p.x && b.x <= p.x + p.w && p.y < main.y;
  }).map(function (p) { return p.y; }).sort(function (a, c) { return a - c; });
  var crossed = above.map(function () { return false; });
  for (var i = 0; i < 80 && !b.dead; i++) {
    __step(0, 0, function () { trapArm = 0; });
    for (var k = 0; k < above.length; k++) {
      if (!b.dead && b.y + HAM_FOOT > above[k] + 2) crossed[k] = true;
    }
    if (b.dead) landedFrame = i;
  }
  return { stage: STAGE.key, mainY: main.y, ty: b.ty, g0: b.groundY, above: above.join(','),
           crossed: crossed.join(','), landedAt: landedAt, landedFrame: landedFrame };
})()`;

function checkThrough(r) {
  assert.ok(r.above.length > 0,
    "precondition: on " + r.stage + " there should be platforms over the foe's head in the " +
    "ham's column; found none");
  assert.equal(r.ty, r.mainY, "precondition: the ham remembers the foe's feet on the main floor");
  assert.equal(r.g0, r.mainY,
    "on " + r.stage + ", at cast, the floor should be the main at y=" + r.mainY +
    " and not one of the platforms above his feet (" + r.above + "); groundY was " + r.g0);
  assert.ok(r.landedFrame >= 0, "the ham should have landed within 80 frames on " + r.stage);
  assert.equal(r.landedAt, r.mainY,
    "on " + r.stage + " the ham should drop straight through the platforms above the foe's " +
    "feet (" + r.above + ") and land on the main at y=" + r.mainY + "; it landed at " + r.landedAt);
  assert.equal(r.crossed, r.above.split(",").map(() => "true").join(","),
    "and it should pass every one of those rows alive (" + r.above + "); crossed: " + r.crossed);
}

const SNAPSHOT_PROBE = `(function () {
  ${GEOMETRY}
  ${STAND("doorX", "main.y")}
  var b = new HamDrop(me, ROSTER.johnnyham.ult);
  var tyType = typeof b.ty;
  var own = Object.keys(b).indexOf('ty') >= 0;
  projectiles.push(b);
  for (var i = 0; i < 8; i++) __step(0, 0);
  var yBefore = b.y, vyBefore = b.vy, gBefore = b.groundY, guBefore = b.groundUnder(),
      tyBefore = b.ty;
  var snap = saveSim();
  for (var i = 0; i < 5; i++) __step(0, 0);
  var yMoved = b.y, stillAlive = !b.dead;
  restoreSim(snap);
  var hams = projectiles.filter(function (p) { return p instanceof HamDrop; });
  var r = hams[0];
  var out = { tyType: tyType, own: own, mainY: main.y,
              yBefore: yBefore, vyBefore: vyBefore, gBefore: gBefore, guBefore: guBefore,
              tyBefore: tyBefore, yMoved: yMoved, stillAlive: stillAlive, count: hams.length,
              rebuilt: !!r && r !== b };
  if (r) {
    out.yAfter = r.y; out.vyAfter = r.vy; out.gAfter = r.groundY; out.guAfter = r.groundUnder();
    out.tyAfter = r.ty; out.tyAfterType = typeof r.ty;
    // A second restore from the same snapshot must give the same answer --
    // a rollback can rewind to one frame more than once.
    for (var i = 0; i < 3; i++) __step(0, 0);
    restoreSim(snap);
    var r2 = projectiles.filter(function (p) { return p instanceof HamDrop; })[0];
    out.guAgain = r2 ? r2.groundUnder() : null;
    out.yAgain = r2 ? r2.y : null;
  }
  return out;
})()`;

function checkSnapshot(r) {
  assert.equal(r.tyType, "number",
    "HamDrop.ty must be a plain number straight out of the constructor -- snapValue copies " +
    "primitives and would clone an object -- but typeof read '" + r.tyType + "'");
  assert.equal(r.own, true,
    "and an ordinary own field, or saveSim's Object.keys walk never sees it");
  assert.equal(r.guBefore, r.mainY,
    "precondition: with platforms over the foe's head, ty is doing work -- groundUnder() " +
    "should read the main floor (" + r.mainY + "), read " + r.guBefore);
  assert.ok(r.stillAlive && r.yMoved > r.yBefore,
    "precondition: the five frames after saveSim moved the ham (" + r.yBefore + " -> " +
    r.yMoved + ") without landing it");
  assert.equal(r.count, 1, "restoreSim should hand back exactly one ham; found " + r.count);
  assert.ok(r.rebuilt, "and it should be a rebuilt object, not the live one");
  assert.equal(r.yAfter, r.yBefore,
    "the restored ham should be back at the snapshot's y=" + r.yBefore + "; it is at " + r.yAfter);
  assert.equal(r.vyAfter, r.vyBefore, "with the snapshot's vy");
  assert.equal(r.tyAfterType, "number",
    "the restored ham should still carry ty as a number; typeof read '" + r.tyAfterType + "'");
  assert.equal(r.tyAfter, r.tyBefore,
    "and the same ty (" + r.tyBefore + "); it has " + r.tyAfter);
  assert.equal(r.gAfter, r.gBefore,
    "the restored groundY should match the snapshot's " + r.gBefore + "; it is " + r.gAfter);
  assert.equal(r.guAfter, r.guBefore,
    "and groundUnder() must give the same answer after the round-trip as before it: " +
    r.guBefore + " before, " + r.guAfter + " after");
  assert.equal(r.guAgain, r.guBefore, "a second restore from the same snapshot should agree");
  assert.equal(r.yAgain, r.yBefore, "on y as well");
}

/* Ten seconds of CPU JohnnyHam against CPU Kel on the island, with a ham
   dropped into the match at frames 60 and 300 so the whole landing --
   crater, Shocks, chunks -- runs against live fighters whether or not the
   CPU gets its meter up. Nothing is allowed to produce a NaN: not a fighter's
   health or position, and not a projectile's, because a NaN in the ham's own
   y is a ham that never lands and never dies. */
const CANARY_PROBE = `(function () {
  select.cursor=[${JOHN},${KEL}]; twoPlayer=true; playerCount=2; humanCount=0;
  stagePick=${BATTLEFIELD}; startBattle();
  var nan = 0, pnan = 0, hams = 0, seen = {}, frames = 0;
  for (var i = 0; i < 600; i++) {
    if (i === 60 || i === 300) {
      projectiles.push(new HamDrop(fighters[0], ROSTER.johnnyham.ult)); hams++;
    }
    step(); frames++;
    if (scene !== 'battle') break;
    for (var k = 0; k < fighters.length; k++) {
      var f = fighters[k];
      if (isNaN(f.health) || isNaN(f.x) || isNaN(f.y)) nan++;
    }
    for (var j = 0; j < projectiles.length; j++) {
      var p = projectiles[j];
      if (isNaN(p.x) || isNaN(p.y)) pnan++;
      seen[p.constructor.name] = true;
    }
  }
  return { stage: STAGE.key, nan: nan, pnan: pnan, hams: hams, frames: frames, scene: scene,
           seen: Object.keys(seen).sort().join(',') };
})()`;

function checkCanary(r) {
  assert.equal(r.stage, "battlefield", "precondition: the match is on the island");
  assert.equal(r.hams, 2, "precondition: two hams went into the match");
  const seen = r.seen.split(",");
  assert.ok(seen.includes("HamDrop") && seen.includes("Shock") && seen.includes("Pellet"),
    "precondition: the hams should have fallen and landed (crater and chunks); what flew " +
    "was: " + r.seen);
  assert.equal(r.nan, 0,
    "a fighter's health or position went NaN on the island (" + r.nan + " fighter-frames)");
  assert.equal(r.pnan, 0,
    "a projectile's position went NaN on the island (" + r.pnan + " projectile-frames)");
  assert.ok(r.scene === "battle" || r.scene === "results",
    "the match should still be a match (or have ended properly), scene is " + r.scene);
}

/* ------------------------------------------------------------------ */

test("over a shut door the ham lands ON the door", async () => {
  /* The door is a platform like any other while it is shut, and the ham has
     to treat it as one: the foe is standing on it, so its y is his feet, and
     the scan must pick it over the platform underneath. Held shut by
     pinning trapArm, because a foe standing on the door for the length of
     the fall is exactly what opens it. Both the hand-built ham and the one
     John casts are checked, since the cast path is the one players use and
     the hand-built one is what the other cases measure. */
  const run = await island();
  checkShutDoor(run(SHUT_DOOR_PROBE));
});

test("the door opens during the fall and the ham follows it down", async () => {
  /* The finding. The floor was decided once at cast; now groundUnder() is
     asked every frame, so a door that gives way under a falling ham moves
     its landing to the platform below rather than leaving a crater in
     midair. Twice: with the door thrown open by hand five frames in, and
     with the engine's own tickTrap opening it under a foe who had been
     standing there when John pressed the button. */
  const run = await island();
  checkOpenDoor(run(OPEN_DOOR_PROBE));
});

test("platforms above the target's feet are still ignored", async () => {
  /* The reason the constructor scan existed in the first place: aiming at an
     x and landing on the first thing under it put the ham on the balcony
     over the target's head, where nothing it did could reach him. Moving the
     scan into groundUnder() must not lose that filter. On the island the foe
     stands under the door row AND the middle platform; on Deep Space under
     the top platform. The ham goes through all of them. */
  const run = await island();
  checkThrough(run(THROUGH_PROBE.replace("FOE_X", "doorX")));

  run("stagePick=" + DEEP_SPACE + "; startBattle();");
  assert.equal(run("STAGE.key"), "space", "precondition: the second stage is Deep Space");
  const under = run("(function () { var top = STAGE.platforms.slice().sort(function (a, b) {" +
    " return a.y - b.y; })[0]; return Math.floor(top.x + top.w / 2); })()");
  checkThrough(run(THROUGH_PROBE.replace("FOE_X", String(under))));
});

test("ty is a number, and a mid-fall ham survives saveSim/restoreSim", async () => {
  /* The rollback rebuilds projectiles from Object.keys of the live one, and
     snapValue copies primitives, keeps fighters and frozen ROSTER/STAGES
     entries by reference, and shallow-clones anything else. A ty that was an
     object would come back as a copy; one that was not an own enumerable
     field would not come back at all, and groundUnder() on the restored ham
     would have nothing to ignore. So: typeof, ownership, and the same
     groundUnder() answer on both sides of a restore, with the foe stood under
     platforms so that the answer depends on ty. */
  const run = await island();
  checkSnapshot(run(SNAPSHOT_PROBE));
});

test("ten seconds of CPU JohnnyHam on the island, two hams in, nothing goes NaN", async () => {
  const run = await island();
  checkCanary(run(CANARY_PROBE));
});

/* ------------------------------------------------------------------ */

/* Each guard, undone in an in-memory copy of the engine, must make its own
   test's check throw. The edit is a single exact line (or two adjacent
   lines), asserted to occur exactly once so a line that has moved or been
   reworded fails loudly here rather than making the sabotage a silent no-op
   -- string edits to this engine have a history of doing that. */
const SABOTAGE = [
  {
    test: "over a shut door the ham lands ON the door",
    from: "      if (p.y < this.ty - 2) continue;",
    to:   "      if (p.y <= this.ty) continue;",
    why: "an off-by-one in the above-the-feet filter that throws away the platform he is standing on",
    probe: SHUT_DOOR_PROBE, check: checkShutDoor,
    read: (r) => "hand-built ham landed at " + r.landedAt + ", cast ham at " + r.castLandedAt,
  },
  {
    test: "the door opens during the fall and the ham follows it down",
    from: "    this.groundY = this.groundUnder();\n    if (this.y + HAM_FOOT >= this.groundY)",
    to:   "    if (this.y + HAM_FOOT >= this.groundY)",
    why: "update() no longer re-asks for the floor, so the ham falls toward the y it picked at cast",
    probe: OPEN_DOOR_PROBE, check: checkOpenDoor,
    read: (r) => "hand-opened door: landed at " + r.landedAt + "; engine-opened door: landed at " +
                 r.castLandedAt,
  },
  {
    test: "platforms above the target's feet are still ignored",
    from: "      if (p.y < this.ty - 2) continue;",
    to:   "      if (false) continue;",
    why: "the above-the-feet filter is gone, so the highest platform in the column wins",
    probe: THROUGH_PROBE.replace("FOE_X", "doorX"), check: checkThrough,
    read: (r) => "landed at " + r.landedAt + " over platforms at " + r.above,
  },
  {
    test: "ty is a number (snapshot contract)",
    from: "    this.ty = ty;",
    to:   "    this.ty = [ty];",
    why: "ty stored as an array: still an own field, no longer a primitive",
    probe: SNAPSHOT_PROBE, check: checkSnapshot,
    read: (r) => "typeof ty was '" + r.tyType + "'",
  },
  {
    test: "a mid-fall ham survives saveSim/restoreSim (snapshot contract)",
    from: "    this.ty = ty;",
    to:   "    Object.defineProperty(this, 'ty', { value: ty });",
    why: "ty is a number but not enumerable, so saveSim never copies it and the restored ham has none",
    probe: SNAPSHOT_PROBE, check: checkSnapshot,
    read: (r) => "own=" + r.own + ", groundUnder() " + r.guBefore + " before the round-trip and " +
                 r.guAfter + " after",
  },
  {
    test: "ten seconds of CPU JohnnyHam on the island, two hams in, nothing goes NaN",
    from: "    this.vy += this.spec.drop;\n    this.t++;\n    // Glaze coming off it on the way down.",
    to:   "    this.vy += this.spec.dropp;\n    this.t++;\n    // Glaze coming off it on the way down.",
    why: "a typo in the ham's gravity makes its vy, then its y, NaN -- a ham that never lands",
    probe: CANARY_PROBE, check: checkCanary,
    read: (r) => r.pnan + " projectile-frames with a NaN position",
  },
];

test("every test above is load-bearing: undo its guard and it fails", async () => {
  for (const s of SABOTAGE) {
    const hits = ENGINE_SRC.split(s.from).length - 1;
    assert.equal(hits, 1,
      "the sabotage for '" + s.test + "' must match exactly one place in the engine so the " +
      "edit is not a silent no-op; `" + s.from.trim().split("\n")[0] + "` matched " + hits);
    const run = await island(ENGINE_SRC.replace(s.from, s.to));
    const r = run(s.probe);
    // An AssertionError specifically: a check that blew up on a missing
    // field would otherwise count as having caught the sabotage.
    assert.throws(() => s.check(r), assert.AssertionError,
      "'" + s.test + "' should fail once `" + s.from.trim().split("\n")[0] + "` becomes `" +
      s.to.trim().split("\n")[0] + "` (" + s.why + "), but its check still passed; the probe read: " +
      s.read(r));
  }
});
