/* BATTLEFIELD, the sixth stage, and the first with a moving part.
 *
 * It was drawn as black shapes on a transparent sheet and scaled onto the
 * screen: a floating island for the main platform -- the widest main in the
 * game -- three small platforms above it, and a top row whose middle third
 * was drawn GRAY. That third is a trapdoor. Stand on it half a second and it
 * drops open under you for three seconds, then shuts.
 *
 * Every other stage is a list of rectangles that never changes, so nothing
 * in the engine had ever needed to ask "which platforms are there THIS
 * frame". The door made that a real question, and the answer had to be
 * threaded through every landing check in the file -- fighters, every
 * projectile, the dog, the CPU's footing probes -- and into the rollback
 * snapshot, because a door one machine thought was open and the other
 * thought was shut is a desync the moment anybody walks across it.
 *
 * These tests load the engine source rather than the bundle for the same
 * reason nerdwars-platforms.test.js does: trapArm, trapOpen, platformsNow()
 * and saveSim are not on the public surface, and neither is placing a
 * fighter on a chosen platform.
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
const LADDER_SRC = readFileSync(path.join(JS_DIR, "ladder.js"), "utf8");
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

async function bootEngine() {
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
  vm.runInContext(readFileSync(ENGINE_PATH, "utf8"), sandbox, { filename: "nerdwars.js" });
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

const BATTLEFIELD = 5;

/* AutisNick against JohnnyHam on the island, both CPUs, warmed up past the
   first second so the GO! banner and the spawn-in are behind us. Also
   installs two helpers INSIDE the vm:

   __place(f, x, y) -- a clean, actionable fighter standing at (x, y). The
     warmup frames run both CPUs off Math.random, so whatever state a fighter
     is in afterward is luck; a fighter mid-special ignores the pad and a
     fighter in hitstun is not standing on anything. Stocks are set high so a
     fall during a test is a fall, not a KO and a respawn on the far side of
     the screen. The door itself is shut and unarmed, because a CPU may have
     wandered across it during the warmup.

   __neutral(n) -- n frames of nobody pressing anything, fed through netplay
     so the CPUs do not build their own pads. Hitstop is cleared every frame
     because hitstop pauses the actor, and a paused actor is not standing on
     a door in any sense tickTrap can see. */
async function island() {
  const run = await bootEngine();
  run("select.cursor=[0,1]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=" + BATTLEFIELD + "; startBattle();");
  run("for (var i=0;i<60;i++) step();");
  run(`
    function __place(f, x, y) {
      f.setState('idle');
      f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
      f.dropThrough = 0; f.invuln = 0; f.confused = 0; f.buffTimer = 0;
      f.mana = 999; f.vx = 0; f.vy = 0; f.grabbing = -1; f.grabbedBy = -1;
      f.grounded = true; f.specialSpawned = false; f.stocks = 99;
      f.health = COMBAT.maxHealth; f.eliminated = false;
      f.x = x; f.y = y; f.prevY = y;
      projectiles.length = 0; effects.length = 0;
      trapArm = 0; trapOpen = 0;
    }
    /* Mid-test: pick a standing fighter up and set them down somewhere else
       WITHOUT touching the door. A test that is measuring what the door does
       after somebody leaves it cannot use a helper that shuts it. */
    function __moveTo(f, x, y) {
      f.setState('idle'); f.timer = 0; f.landLag = 0;
      f.vx = 0; f.vy = 0; f.grounded = true;
      f.x = x; f.y = y; f.prevY = y;
    }
    function __neutral(n) {
      netplay.active = true;
      for (var i = 0; i < n; i++) {
        for (var k = 0; k < fighters.length; k++) {
          fighters[k].hitstop = 0; fighters[k].mana = 999;
        }
        netplay.framePads = [bitsToPad(0), bitsToPad(0)];
        step();
      }
      netplay.active = false; netplay.framePads = null;
    }`);
  return run;
}

/* The door, the platform directly under its middle, and the main island --
   read from the stage rather than typed in, so a relayout moves the tests
   with it. */
const GEOMETRY = `
  var door = STAGE.platforms.find(function (p) { return p.trap; });
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var doorX = door.x + door.w / 2;
  var below = STAGE.platforms.filter(function (p) {
    return p !== door && p.y > door.y && doorX >= p.x && doorX <= p.x + p.w;
  }).sort(function (a, b) { return a.y - b.y; })[0];`;

test("BATTLEFIELD is the sixth stage, and the stage select counts to six", async () => {
  /* Nothing derives the number of stages from anywhere but STAGES itself:
     the position dots, the left/right wrap, the preview. Each of those was
     written to STAGES.length rather than to 5, and this is what holds them
     to it. */
  const run = await bootEngine();
  assert.equal(run("STAGES.length"), 6, "there should be six stages");
  assert.equal(run("STAGES[" + BATTLEFIELD + "].key"), "battlefield",
    "the sixth stage should be the battlefield, so stagePick 5 reaches it");
  assert.equal(run("STAGES[" + BATTLEFIELD + "].trap && 'trap'"), "trap",
    "and it should be the one with the trapdoor");

  const keys = run("STAGES.map(function (s) { return s.key; }).join(',')").split(",");
  assert.equal(new Set(keys).size, keys.length,
    "every stage key should be unique -- the leaderboard and the room both " +
    "name stages by key; saw " + keys.join(", "));

  // The select wraps at the real count: right from the last is the first.
  run("scene = 'stage'; stagePick = " + BATTLEFIELD + ";");
  tapKey(run, "KeyD");
  assert.equal(run("stagePick"), 0,
    "moving right from the last stage should wrap to the first");
  tapKey(run, "KeyA");
  assert.equal(run("stagePick"), BATTLEFIELD,
    "and left from the first should wrap back to the battlefield, not to " +
    "whatever the count used to be");

  /* The preview renders the stage through the same drawStage a match uses,
     so drawing the select is also the first time the island is drawn. The
     canvas is a stub; what is being checked is that nothing throws, and
     that the dot row is one dot per stage. */
  const dots = run(`(function () {
    scene = 'stage'; stagePick = ${BATTLEFIELD};
    var n = 0, rowY = px(165), size = px(4);
    sctx.fillRect = function (x, y, w, h) {
      if (y === rowY && w === size && h === size) n++;
    };
    try { drawStageSelect(); } finally { sctx.fillRect = function () {}; }
    return n;
  })()`);
  assert.equal(dots, 6,
    "the stage select should draw one position dot per stage; drew " + dots);
});

test("the island's geometry is sound", async () => {
  /* Seven platforms scaled off a drawing, by hand. The things that go wrong
     when you do that: a platform hanging off the screen, two platforms in
     the same row running into each other, a body polygon with one point
     typed in the layout's coordinates rather than the screen's, and spawns
     that land people in the air. All of it is checked against the screen
     the engine actually has, not against numbers copied out of the file. */
  const run = await island();
  const g = run(`(function () {
    ${GEOMETRY}
    var VWv = VW, VHv = VH;
    var mains = STAGE.platforms.filter(function (p) { return p.main; });
    /* "The widest main in the game" is what the layout note says, and it is
       not quite so: the swamp, the matrix and the beach have floors that run
       the whole 320px, wall to wall. Those are grounds, not islands. Among
       the stages where the floor is a thing you can fall off both ends of,
       this is the widest -- and being an island it has edges, so the
       comparison that means something is against the other islands. */
    var isIsland = function (m) { return m.x > 0 && m.x + m.w < VWv; };
    var widerMainElsewhere = STAGES.filter(function (s) {
      if (s === STAGE) return false;
      var m = s.platforms.find(function (p) { return p.main; });
      return m && isIsland(m) && m.w >= main.w;
    }).map(function (s) { return s.key; });
    var otherIslands = STAGES.filter(function (s) {
      if (s === STAGE) return false;
      var m = s.platforms.find(function (p) { return p.main; });
      return m && isIsland(m);
    }).length;

    var offscreen = STAGE.platforms.filter(function (p) {
      return p.x < 0 || p.x + p.w > VWv || p.y <= 0 || p.y >= VHv;
    }).length;

    // Rectangles of height 1: they overlap when they share a row and their
    // spans intersect. Touching end to end is not overlapping.
    var overlaps = 0;
    for (var i = 0; i < STAGE.platforms.length; i++) {
      for (var j = i + 1; j < STAGE.platforms.length; j++) {
        var a = STAGE.platforms[i], b = STAGE.platforms[j];
        if (Math.abs(a.y - b.y) >= 1) continue;
        if (a.x < b.x + b.w && b.x < a.x + a.w) overlaps++;
      }
    }

    var bodyOut = STAGE.body.filter(function (pt) {
      return pt[0] < 0 || pt[0] > VWv || pt[1] < 0 || pt[1] > VHv;
    }).length;

    var spawnsOff = STAGE.spawns.filter(function (s) {
      return s.x < main.x || s.x > main.x + main.w || s.y !== main.y;
    }).length;
    var respawnOff = STAGE.respawn.x < main.x || STAGE.respawn.x > main.x + main.w ||
                     STAGE.respawn.y >= main.y;

    // And the fighters a match actually builds start where the stage says.
    var startedOff = fighters.filter(function (f) {
      return f.x < main.x || f.x > main.x + main.w;
    }).length;

    return { count: STAGE.platforms.length, mains: mains.length, mainW: main.w,
             isIsland: isIsland(main), otherIslands: otherIslands,
             widerMainElsewhere: widerMainElsewhere.join(','), offscreen: offscreen,
             overlaps: overlaps, bodyPoints: STAGE.body.length, bodyOut: bodyOut,
             spawnsOff: spawnsOff, respawnOff: respawnOff, startedOff: startedOff,
             hasBelow: !!below, trapCount: STAGE.platforms.filter(function (p) {
               return p.trap; }).length };
  })()`);

  assert.equal(g.count, 7, "the island should have seven platforms, has " + g.count);
  assert.equal(g.mains, 1, "exactly one of them should be the main floor; " + g.mains + " are");
  assert.equal(g.isIsland, true,
    "the main floor should be an island with open air past both ends, not a " +
    "wall-to-wall ground");
  assert.ok(g.otherIslands >= 2,
    "precondition: there are other island stages to compare against (space, lava)");
  assert.equal(g.widerMainElsewhere, "",
    "the island is meant to be the widest floating main in the game (" + g.mainW +
    "px), but these island stages match or beat it: " + g.widerMainElsewhere);
  assert.equal(g.offscreen, 0,
    g.offscreen + " platform(s) hang off the 320x180 screen");
  assert.equal(g.overlaps, 0,
    g.overlaps + " pair(s) of platforms overlap in the same row");
  assert.ok(g.bodyPoints > 10, "the body should be a real silhouette, not a box");
  assert.equal(g.bodyOut, 0,
    g.bodyOut + " body point(s) are outside the screen -- a coordinate left in " +
    "the layout's own units rather than scaled to the screen's");
  assert.equal(g.spawnsOff, 0, "both spawns should stand on the main floor");
  assert.equal(g.respawnOff, false, "the respawn point should be above the main floor");
  assert.equal(g.startedOff, 0, "a started match should put both fighters over the island");
  assert.equal(g.trapCount, 1, "exactly one platform should be the trapdoor");
  assert.ok(g.hasBelow,
    "there should be a platform directly under the door's middle, or the " +
    "door drops you into nothing and it is a pit rather than a trapdoor");
});

test("standing on the trapdoor opens it, drops you, and the floor comes back", async () => {
  /* The whole mechanic, frame by frame: arming while you stand there,
     opening at exactly STAGE.trap.arm, the fighter who was on it losing the
     ground, the door absent from platformsNow() but nothing else missing,
     shut again after STAGE.trap.open frames, and load-bearing once shut. The
     numbers are read from STAGE.trap rather than typed as 30 and 180, so a
     retune of the timing moves the test with it. */
  const run = await island();
  const r = run(`(function () {
    ${GEOMETRY}
    var me = fighters[0], foe = fighters[1];
    var ARM = STAGE.trap.arm, OPEN = STAGE.trap.open;
    __place(foe, main.x + main.w - 10, main.y);
    __place(me, doorX, door.y);
    if (STAGE.platformsTrapOpen === undefined) return { noList: true };

    // Arming: one frame of standing, one tick of the counter.
    var armTrace = [], openedEarly = false;
    for (var i = 1; i < ARM; i++) {
      __neutral(1);
      armTrace.push(trapArm);
      if (trapOpen !== 0) openedEarly = true;
    }
    var armedBefore = trapArm, groundedBefore = me.grounded, yBefore = me.y;

    // The frame it opens.
    __neutral(1);
    var openAt = trapOpen, armAt = trapArm, groundedAt = me.grounded;

    // Open: the door is gone from the world but nothing else is.
    var now = platformsNow();
    var doorListed = now.indexOf(door) >= 0;
    var missing = STAGE.platforms.filter(function (p) {
      return p !== door && now.indexOf(p) < 0; }).length;
    var listIsTrapOpen = now === STAGE.platformsTrapOpen;

    // Falling: y goes up (down the screen) and he lands on the one below.
    var yTrace = [];
    for (var i = 0; i < 20; i++) { __neutral(1); yTrace.push(me.y); }
    var landedY = me.y, landedGrounded = me.grounded;
    var stillListedWhileOpen = platformsNow().indexOf(door) >= 0;

    // The rest of the open time, then it is shut.
    __neutral(OPEN - 1 - 20);
    var lastOpen = trapOpen;
    __neutral(1);
    var shut = trapOpen;

    // Shut again, and standing on it is standing on something. Moved, not
    // re-placed: the door has to have shut on its own for this to count.
    __moveTo(me, doorX, door.y);
    __neutral(5);
    var heldY = me.y, heldGrounded = me.grounded, rearming = trapArm;

    return { ARM: ARM, OPEN: OPEN, armTrace: armTrace.join(','), openedEarly: openedEarly,
             armedBefore: armedBefore, groundedBefore: groundedBefore, yBefore: yBefore,
             openAt: openAt, armAt: armAt, groundedAt: groundedAt,
             doorListed: doorListed, missing: missing, listIsTrapOpen: listIsTrapOpen,
             yTrace: yTrace.join(','), landedY: landedY, landedGrounded: landedGrounded,
             stillListedWhileOpen: stillListedWhileOpen,
             lastOpen: lastOpen, shut: shut,
             heldY: heldY, heldGrounded: heldGrounded, rearming: rearming,
             doorY: door.y, belowY: below.y, platforms: STAGE.platforms.length,
             openLen: STAGE.platformsTrapOpen.length };
  })()`);

  assert.ok(!r.noList, "STAGE.platformsTrapOpen should exist on the trap stage");
  assert.equal(r.openLen, r.platforms - 1,
    "platformsTrapOpen should be every platform but the door");

  // Arming.
  const expectedArm = [];
  for (let i = 1; i < r.ARM; i++) expectedArm.push(i);
  assert.equal(r.armTrace, expectedArm.join(","),
    "trapArm should rise by one for every frame somebody stands on the door; " +
    "saw " + r.armTrace);
  assert.ok(!r.openedEarly, "and the door must not open before it is fully armed");
  assert.equal(r.groundedBefore, true, "precondition: he is standing on it while it arms");
  assert.equal(r.yBefore, r.doorY, "precondition: at the door's height");

  // Opening.
  assert.equal(r.openAt, r.OPEN,
    "on frame " + r.ARM + " the door should open for STAGE.trap.open (" + r.OPEN +
    ") frames; trapOpen was " + r.openAt);
  assert.equal(r.armAt, 0, "and the arm counter should reset when it does");
  assert.equal(r.groundedAt, false,
    "the fighter standing on it should lose the ground the instant it opens");

  // While open.
  assert.equal(r.doorListed, false, "an open door must not be in platformsNow()");
  assert.equal(r.missing, 0,
    "but every OTHER platform must still be; " + r.missing + " went missing");
  assert.ok(r.listIsTrapOpen,
    "platformsNow() should hand back the prebuilt platformsTrapOpen list, not a " +
    "fresh filter every frame");
  assert.equal(r.stillListedWhileOpen, false, "and it should stay out while open");

  // Falling.
  const ys = r.yTrace.split(",").map(Number);
  assert.ok(ys[0] > r.doorY,
    "he should be falling on the first frame after it opens; y went from " +
    r.doorY + " to " + ys[0]);
  assert.ok(ys[1] > ys[0], "and keep falling: " + ys.slice(0, 4).join(" -> "));
  assert.equal(r.landedY, r.belowY,
    "he should land on the platform under the door at y=" + r.belowY +
    ", but ended at y=" + r.landedY);
  assert.equal(r.landedGrounded, true, "and be standing on it");

  // Shutting.
  assert.equal(r.lastOpen, 1, "the open time should count down to its last frame");
  assert.equal(r.shut, 0,
    "after STAGE.trap.open frames the door should be shut again (trapOpen 0)");

  // Load-bearing again.
  assert.equal(r.heldY, r.doorY,
    "a fighter placed on the shut door should be held at y=" + r.doorY +
    ", not fall to y=" + r.heldY);
  assert.equal(r.heldGrounded, true, "and be grounded on it");
  assert.equal(r.rearming, 5,
    "and standing there should start arming it again: trapArm " + r.rearming);
});

test("stepping off the door lets it relax instead of staying armed", async () => {
  /* A door that remembered every footstep would open under the second
     person to cross it, however long after the first. Standing arms it;
     leaving un-arms it at the same rate; only a continuous half-second
     opens it. */
  const run = await island();
  const r = run(`(function () {
    ${GEOMETRY}
    var me = fighters[0], foe = fighters[1];
    __place(foe, main.x + main.w - 10, main.y);
    __place(me, doorX, door.y);
    __neutral(10);
    var armed = trapArm;

    // Off the door and onto the island proper.
    __moveTo(me, main.x + 40, main.y);
    var relaxTrace = [];
    for (var i = 0; i < 12; i++) { __neutral(1); relaxTrace.push(trapArm); }

    // And having relaxed, a fresh stand starts from nothing.
    __moveTo(me, doorX, door.y);
    __neutral(3);
    return { armed: armed, relaxTrace: relaxTrace.join(','), fresh: trapArm,
             opened: trapOpen };
  })()`);

  assert.equal(r.armed, 10, "precondition: ten frames of standing is ten of arming");
  assert.equal(r.relaxTrace, "9,8,7,6,5,4,3,2,1,0,0,0",
    "once nobody is on it, trapArm should count back down to zero and stop " +
    "there; saw " + r.relaxTrace);
  assert.equal(r.fresh, 3,
    "a later stand should start the count from nothing, not from where the " +
    "last one left off; got " + r.fresh);
  assert.equal(r.opened, 0, "and nothing in all that should have opened it");
});

test("a projectile falls through an open door and stops on a shut one", async () => {
  /* The reason platformsNow() exists at all. Fighters could have been
     special-cased; the point of a hole in the floor is that EVERYTHING goes
     through it, so every landing check in the file asks the same question.
     Two of the things that fall: the rainbow, which dies on any floor, and
     the pizza, which bounces and skids on one. Both are built from the
     engine's own classes and stepped by their own update(), with the door
     held open or shut by hand, so this measures the projectile and not the
     door's timing. */
  const run = await island();
  const kind = (k) => run("Object.keys(ROSTER.autisnick.specials).find(function (n) {" +
    " return ROSTER.autisnick.specials[n].kind === '" + k + "'; })");
  const rainbowSlot = kind("rainbow"), pizzaSlot = kind("pizza");
  assert.ok(rainbowSlot, "precondition: AutisNick has a rainbow special");
  assert.ok(pizzaSlot, "precondition: and a pizza");

  const drop = (which, open) => run(`(function () {
    ${GEOMETRY}
    var me = fighters[0];
    __place(me, doorX, door.y - 30);
    me.grounded = false; me.facing = 1;
    trapOpen = ${open};
    var spec = ROSTER.autisnick.specials['${which === "rainbow" ? rainbowSlot : pizzaSlot}'];
    var p = ${which === "rainbow" ? "new Rainbow(me, spec)" : "new Pizza(me, spec, 'D')"};
    // Straight down, from just above the door.
    p.x = doorX; p.y = door.y - 20; p.vx = 0; p.vy = 1;
    var crossedAlive = false, lowest = p.y, frames = 0;
    for (var i = 0; i < 200 && !p.dead; i++) {
      p.update(); frames++;
      if (p.y > lowest) lowest = p.y;
      if (!p.dead && p.y > door.y + 2) crossedAlive = true;
    }
    return { dead: p.dead, y: p.y, lowest: lowest, crossedAlive: crossedAlive,
             frames: frames, doorY: door.y, belowY: below.y, trapOpen: trapOpen };
  })()`);

  for (const which of ["rainbow", "pizza"]) {
    const open = drop(which, 100);
    assert.equal(open.trapOpen, 100, "precondition: the door was held open");
    assert.ok(open.crossedAlive,
      "with the door open the " + which + " should pass the door's y=" + open.doorY +
      " and keep falling; it got no lower than " + open.lowest.toFixed(1) +
      (open.dead ? " and died" : ""));
    assert.ok(open.lowest >= open.belowY - 1.5,
      "and reach the platform under it at y=" + open.belowY + "; lowest was " +
      open.lowest.toFixed(1));

    const shut = drop(which, 0);
    assert.equal(shut.crossedAlive, false,
      "with the door shut the same " + which + " must stop on it, but it got to y=" +
      shut.lowest.toFixed(1) + " past the door at y=" + shut.doorY);
    assert.ok(shut.lowest <= shut.doorY + 3,
      "a shut door should catch the " + which + " at its own height; lowest was " +
      shut.lowest.toFixed(1) + " against " + shut.doorY);
  }

  // The two behave differently on contact, which is the point of using both.
  const rb = drop("rainbow", 0), pz = drop("pizza", 0);
  assert.equal(rb.dead, true, "a rainbow dies on the floor it hits");
  assert.equal(pz.dead, false, "a pizza stays in play on the floor it hits");
});

test("the snapshot carries the door, and a new match shuts it", async () => {
  /* Both counters are simulation state by the file's own definition: a
     rollback that rewound the fighters but not the door would replay them
     walking across a floor that was, on the other machine, not there. And a
     match that started with a door half-armed from the last one would open
     under the first person to spawn near it. */
  const run = await island();
  const r = run(`(function () {
    trapArm = 17; trapOpen = 42;
    var s = saveSim();
    trapArm = 3; trapOpen = 0;
    var changedArm = trapArm, changedOpen = trapOpen;
    restoreSim(s);
    var backArm = trapArm, backOpen = trapOpen;
    // Restoring twice from the same snapshot must give the same answer --
    // a rollback can rewind to one frame more than once.
    trapArm = 0; trapOpen = 0;
    restoreSim(s);
    var againArm = trapArm, againOpen = trapOpen;
    trapArm = 17; trapOpen = 42;
    startBattle();
    return { snapArm: s.trapArm, snapOpen: s.trapOpen,
             changedArm: changedArm, changedOpen: changedOpen,
             backArm: backArm, backOpen: backOpen,
             againArm: againArm, againOpen: againOpen,
             freshArm: trapArm, freshOpen: trapOpen, stage: STAGE.key };
  })()`);

  assert.equal(r.snapArm, 17, "saveSim should record trapArm");
  assert.equal(r.snapOpen, 42, "and trapOpen");
  assert.equal(r.changedArm, 3, "precondition: the live values were changed");
  assert.equal(r.changedOpen, 0);
  assert.equal(r.backArm, 17,
    "restoreSim should bring trapArm back to the snapshot's 17, got " + r.backArm);
  assert.equal(r.backOpen, 42,
    "and trapOpen back to 42, got " + r.backOpen);
  assert.equal(r.againArm, 17, "a second restore from the same snapshot should agree");
  assert.equal(r.againOpen, 42);
  assert.equal(r.stage, "battlefield", "precondition: the new match is on the island");
  assert.equal(r.freshArm, 0, "startBattle should leave the door unarmed");
  assert.equal(r.freshOpen, 0, "and shut");
});

test("the island is drawn from its body, with no tileset, and does not throw", async () => {
  /* Every other stage is painted from tiles recovered out of the 2016 .xcf
     files. Nobody drew tiles for this one, so drawStage takes the `body`
     branch: the silhouette as a polygon, the platforms as slabs, the door in
     the gray it was drawn in. TILES.battlefield must NOT exist -- if
     somebody adds one, drawStage will have two ways to draw the stage and
     the preview and the match could disagree. */
  const run = await island();
  assert.equal(run("typeof TILES.battlefield"), "undefined",
    "there should be no battlefield tileset; the stage is drawn from its body");
  assert.equal(run("STAGE.body && STAGE.body.length > 0"), true,
    "precondition: the stage has a body to draw");

  // The whole frame, through render(), with the real (stub) canvases.
  assert.doesNotThrow(() => run("scene = 'battle'; render();"),
    "render() should draw a battlefield match without a tileset");

  // And what drawStage draws: the polygon, and the door in both states.
  /* Recorded as geometry rather than counted: shut, the door is a slab the
     full width of the opening; open, it is two leaves hanging from the
     hinges, each taller than it is wide, and nothing solid spans the gap.
     Three rects either way, so a count would call them the same picture. */
  const drawn = (open) => run(`(function () {
    ${GEOMETRY}
    trapOpen = ${open}; trapArm = 0;
    var lineTos = 0, fills = 0, atDoor = [];
    var rec = { fillStyle: '#000', globalAlpha: 1,
      beginPath: function () {}, closePath: function () {},
      moveTo: function () {}, lineTo: function () { lineTos++; },
      fill: function () { fills++; },
      fillRect: function (x, y, w, h) {
        // Only rects that start on the door's own row and inside its span.
        if (y === door.y && x >= door.x && x + w <= door.x + door.w) {
          atDoor.push({ x: x, y: y, w: w, h: h });
        }
      },
      save: function () {}, restore: function () {}, rect: function () {},
      clip: function () {}, drawImage: function () {} };
    drawStage(rec);
    var slab = atDoor.some(function (r) { return r.w === door.w && r.h >= 2; });
    var leaves = atDoor.filter(function (r) { return r.h > r.w; }).length;
    return { lineTos: lineTos, fills: fills, body: STAGE.body.length,
             rects: atDoor.length, slab: slab, leaves: leaves };
  })()`);

  const shut = drawn(0), open = drawn(100);
  assert.ok(shut.lineTos >= shut.body - 1,
    "the island's silhouette should be traced point by point (" + shut.body +
    " points); drawStage issued " + shut.lineTos + " lineTo calls");
  assert.ok(shut.fills >= 1, "and filled");
  assert.ok(shut.rects > 0 && open.rects > 0,
    "the door is drawn in both states -- an open door is drawn open, not " +
    "drawn absent (shut: " + shut.rects + " rects, open: " + open.rects + ")");
  assert.equal(shut.slab, true,
    "a shut door should be drawn as a solid slab across the whole opening");
  assert.equal(open.slab, false,
    "an open door must NOT be drawn as a solid slab, or nobody can tell it is " +
    "open until they fall through it");
  assert.ok(open.leaves >= 2,
    "an open door should show its two leaves hanging from the hinges; drew " +
    open.leaves);
});

test("two CPUs can fight on the island for ten seconds, and a KO comes back normally", async () => {
  /* A soak. Nothing about the new stage -- the trapdoor, the polygon body,
     the seven platforms, the respawn point over a floor that may not be
     there -- is allowed to produce a NaN, a negative stock, or a fighter
     standing outside the blast zone. checkBlastZones runs at the end of
     every update, so after any step a fighter outside the zone must already
     be in 'ko'; one frame of grace covers the roll and dodge paths, which
     do not check until they finish. A KO is forced halfway so the respawn
     path is exercised whether or not the CPUs manage one on their own. */
  const run = await island();
  const r = run(`(function () {
    var bz = STAGE.blast;
    var nan = 0, negative = 0, outside = 0, worstOutside = 0, koFrames = 0;
    var outsideRun = [0, 0];
    var stocksBefore = fighters[1].stocks, koSeen = false;
    var respawned = false, relanded = false, minStocks = 99;
    for (var i = 0; i < 600; i++) {
      if (i === 300) fighters[1].knockOut();
      step();
      if (scene !== 'battle') break;
      for (var k = 0; k < fighters.length; k++) {
        var f = fighters[k];
        if (isNaN(f.x) || isNaN(f.y) || isNaN(f.vx) || isNaN(f.vy)) nan++;
        if (f.stocks < 0) negative++;
        if (f.stocks < minStocks) minStocks = f.stocks;
        if (f.state === 'ko') { koFrames++; outsideRun[k] = 0; continue; }
        if (f.eliminated) continue;
        var out = f.x < bz.left || f.x > bz.right || f.y < bz.top || f.y > bz.bottom;
        outsideRun[k] = out ? outsideRun[k] + 1 : 0;
        if (outsideRun[k] > worstOutside) worstOutside = outsideRun[k];
        if (outsideRun[k] > 1) outside++;
      }
      if (i > 300) {
        var l = fighters[1];
        if (l.state === 'ko') koSeen = true;
        if (koSeen && l.state !== 'ko' && !respawned) respawned = true;
        if (respawned && l.grounded && !l.eliminated) relanded = true;
      }
    }
    return { nan: nan, negative: negative, outside: outside, worstOutside: worstOutside,
             koFrames: koFrames, minStocks: minStocks, scene: scene,
             stocksBefore: stocksBefore, stocksAfter: fighters[1].stocks,
             koSeen: koSeen, respawned: respawned, relanded: relanded,
             x0: fighters[0].x, y0: fighters[0].y, x1: fighters[1].x, y1: fighters[1].y };
  })()`);

  assert.equal(r.nan, 0,
    "a fighter's position or velocity went NaN on the island (" + r.nan + " frames)");
  assert.equal(r.negative, 0, "stocks must never go negative; hit " + r.minStocks);
  assert.equal(r.outside, 0,
    "a live fighter sat outside the blast zone for " + r.worstOutside +
    " consecutive frames without being KO'd; leaving the zone is supposed to " +
    "cost a stock, not be a place to stand");
  assert.ok(r.koSeen, "precondition: the forced KO should have put fighter 1 into 'ko'");
  assert.equal(r.stocksAfter, r.stocksBefore - 1,
    "one KO should cost exactly one stock: " + r.stocksBefore + " -> " + r.stocksAfter);
  assert.ok(r.respawned, "and the fighter should come back from it");
  assert.ok(r.relanded,
    "and land on something -- the respawn point is above the island, so a " +
    "fighter who never touches ground again fell straight through it");
  assert.ok(r.scene === "battle" || r.scene === "results",
    "the match should still be a match (or have ended properly), scene is " + r.scene);
});
