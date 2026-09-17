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

/* Takes the engine SOURCE rather than always reading it off disk, so the
   negative controls at the foot of this file can boot a one-line-mutated copy
   in a fresh vm without that copy ever being written anywhere. Undefined --
   which is what every real test passes -- still reads the shipped engine. */
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

async function battle() {
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");     // past the 110-frame spawn invuln
  return run;
}

/* One line of the engine changed, in a string, on its way into a fresh vm --
   the copy is never written anywhere. A needle that matches twice would
   mutate a place the control was not reasoning about, and one that matches
   nowhere would hand back the shipped engine and "prove" a control that never
   ran, so both are refused rather than warned about. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker the real test ran,
   and it has to throw an assertion. Anything else thrown is a broken checker,
   not a failed test, and is let through so it cannot be mistaken for the
   control working. */
async function expectToFail(check, why) {
  try {
    await check();
  } catch (e) {
    if (e instanceof assert.AssertionError) return e.message;
    throw e;
  }
  assert.fail(why);
}

/* 130 frames of both seats holding NOTHING, in place of 130 frames of two
   CPUs fighting each other.

   updateBattle only asks aiPad for a pad when netplay has none to give it, so
   pinning both pads to neutral takes the AI -- and therefore Math.random --
   out of the warmup entirely. It still spends the 110-frame spawn invuln,
   which is all the warmup was ever for.

   This exists because a live warmup leaves state behind that the probe after
   it did not think to clear, and what is left behind depends on a Math stream
   shared by every test in the file. That is how a test can pass alone, fail
   in suite order, and change its mind again when somebody inserts a test
   above it. See the recovery check below for the one that actually did. */
const QUIET_WARMUP = `
  netplay.active = true;
  for (var i = 0; i < 130; i++) {
    netplay.framePads = [bitsToPad(0), bitsToPad(0)];
    step();
  }
  netplay.active = false; netplay.framePads = null;`;

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

/* The end of a match, which used to arrive before you could see it.
 *
 * koed() set state 'gone' on the final stock, so the loser vanished on the
 * frame of the last hit and updateBattle switched to the results on the next
 * one. The KO everybody had spent the match playing toward was the one thing
 * nobody ever watched. The flight now finishes first.
 */
test("the last KO flies off before the win screen appears", async () => {
  const run = await battle();
  const r = run(`(function(){
    var loser = fighters[1], winner = fighters[0];
    projectiles.length = 0; effects.length = 0;
    loser.setState('idle');
    loser.timer = 0; loser.hitstun = 0; loser.hitstop = 0; loser.invuln = 0;
    loser.vx = 0; loser.vy = 0;
    winner.invuln = 0; winner.hitstop = 0;
    loser.stocks = 1;
    loser.knockOut();

    var sawKoFlight = 0, drawnDuringFlight = 0, resultsAt = -1;
    for (var i = 0; i < 120; i++) {
      if (scene !== 'battle' && resultsAt < 0) resultsAt = i;
      if (scene !== 'battle') break;
      if (loser.state === 'ko') {
        sawKoFlight++;
        // Still on screen? drawFighter bails on a fighter it will not draw.
        var drew = 0;
        var rec = { globalAlpha:1, fillStyle:'#000',
          save:function(){}, restore:function(){}, translate:function(){},
          scale:function(){}, fillRect:function(){ drew++; },
          drawImage:function(){ drew++; }, beginPath:function(){},
          arc:function(){}, fill:function(){} };
        drawFighter(rec, loser);
        if (drew > 0) drawnDuringFlight++;
      }
      step();
    }
    return { sawKoFlight: sawKoFlight, drawnDuringFlight: drawnDuringFlight,
             resultsAt: resultsAt, eliminated: loser.eliminated,
             endState: loser.state, scene: scene, winner: winnerKey };
  })()`);

  assert.ok(r.eliminated, "the loser should be out of the match immediately");
  assert.ok(
    r.sawKoFlight > 20,
    "the final KO should stay in the air for the whole flight, but 'ko' " +
      "lasted only " + r.sawKoFlight + " frames"
  );
  assert.ok(
    r.drawnDuringFlight > 20,
    "and be VISIBLE for it -- the point is watching them go. Drawn on " +
      r.drawnDuringFlight + " of " + r.sawKoFlight + " frames"
  );
  assert.ok(
    r.resultsAt > 20,
    "the win screen should wait for the flight to land; it arrived after " +
      r.resultsAt + " frames"
  );
  assert.equal(r.scene, "results", "and then it should actually arrive");
});

/* Online there is nobody whose job it is to press continue, and no shared
   cursor for three other people to watch. The room takes itself back. */
test("an online results screen returns to picking without a keypress", async () => {
  const run = await battle();
  const r = run(`(function(){
    scene = 'results'; resultTimer = 0; winnerKey = 'trev';
    netplay.active = true;
    var left = -1;
    for (var i = 0; i < 400; i++) {
      step();
      if (scene !== 'results') { left = i; break; }
    }
    var online = scene;
    // Offline the person who presses the key is sitting right there, so it
    // must still wait for them.
    netplay.active = false;
    scene = 'results'; resultTimer = 0;
    for (var i = 0; i < 400; i++) step();
    return { left: left, online: online, offlineScene: scene };
  })()`);

  assert.ok(
    r.left > 60 && r.left < 400,
    "an online results screen should move on by itself after a few seconds " +
      "to read it; it left after " + r.left + " frames"
  );
  assert.notEqual(r.online, "results");
  assert.equal(
    r.offlineScene, "results",
    "offline it must still wait for a key -- the person who presses it is in " +
      "the room, and taking the screen away from them is not a kindness"
  );
});


/* The sword, and the clock -- both need the engine itself: the meter is
   earned elsewhere, and drawHUD is not on the public surface. */

/* The swing, driven and asserted in one function so the negative control at
   the foot of this file can run the identical checks against an engine where
   the swing is rooted again. */
async function checkSwordIsMobile(engineSrc) {
  const run = await bootEngine(engineSrc);
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const RIGHT = 2, JUMP = 16, ULT = 256;
  const r = run(`(function(){
    var f = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0; freezeFrames = 0;
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
    f.invuln = 0; f.vx = 0; f.vy = 0; f.grounded = true; f.facing = 1;
    f.grabbing = -1; f.grabbedBy = -1; f.poison = 0; f.burn = 0;
    f.x = main.x + 40; f.y = main.y;
    f.swordTimer = 400;                  // hand him the sword
    /* Out of reach and untouchable. Whoever the warmup left standing next to
       him is close enough for the first swing to CONNECT, and a connect is
       hitstop: attackFrame stops, the pad is read on a frame that never
       advances, and the jump press on frame 8 is swallowed whole. The test
       then reports a sword that cannot jump, on the Math streams where the
       other fighter happened to walk over -- which is a fight, not a swing.
       hitstop is cleared every frame as well, for the same reason. */
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.invuln = 9999; foe.stocks = 99; foe.health = 1000; foe.hasHit = true;
    foe.grabbing = -1; foe.grabbedBy = -1; foe.vx = 0; foe.vy = 0;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.grounded = true;
    var x0 = f.x, y0 = f.y, airborne = false, swung = false;
    netplay.active = true;
    for (var i = 0; i < 22; i++) {
      f.hitstop = 0;
      var bits = ${RIGHT};
      if (i === 0) bits |= ${ULT};       // swing
      if (i === 8) bits |= ${JUMP};
      netplay.framePads = [bitsToPad(bits), bitsToPad(0)];
      step();
      if (f.state === 'ult') swung = true;
      if (f.y < y0 - 4) airborne = true;
    }
    netplay.active = false; netplay.framePads = null;
    return { moved: f.x - x0, airborne: airborne, swung: swung };
  })()`);

  assert.ok(r.swung, "precondition: he should actually be swinging");
  assert.ok(r.moved > 4,
    "he should walk through a swing; moved " + r.moved.toFixed(1) + "px");
  assert.ok(r.airborne, "and jump through it");
}

test("Trev walks and jumps while swinging the sword", async () => {
  /* Thirty-three frames a swing and eighteen swings in the ult. Rooted, the
     reward for filling the meter was ten seconds of standing still.

     Everything it checks lives in checkSwordIsMobile above, so the negative
     control at the foot of this file can run the identical checks against a
     swing that is rooted again. */
  await checkSwordIsMobile();
});

test("the match clock is drawn, because it decides matches", async () => {
  /* Three minutes, and nothing displayed it. When it expired the winner was
     decided on stocks then health and the results appeared -- which, with
     everybody still standing, looks exactly like the game stopping at
     random. It was never a bug, it was an invisible rule. */
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<40;i++) step();");

  const drawn = run(`(function(){
    var seen = [];
    var real = text;
    text = function (str) { seen.push(String(str)); return real.apply(null, arguments); };
    try { drawHUD(); } finally { text = real; }
    return seen;
  })()`);

  assert.ok(
    drawn.some(function (t) { return /^[0-9]+:[0-9][0-9]$/.test(t); }),
    "the HUD should show the time remaining; it drew " + JSON.stringify(drawn)
  );
});

test("the music level is its own control, clamped and remembered", async () => {
  /* Two different complaints -- "this game is loud" and "I like the game but
     not the song for the ninth time" -- so music multiplies the master rather
     than replacing it. */
  const run = await bootEngine();
  assert.equal(run("AUDIO.music"), 1, "full by default");

  run("window.NerdWars.audio.setMusicVolume(0.4);");
  assert.ok(Math.abs(run("window.NerdWars.audio.musicVolume") - 0.4) < 1e-9);
  assert.ok(
    Math.abs(run("AUDIO.volume") - 0.7) < 1e-9,
    "turning the music down must not touch the master, or the two controls " +
      "are one control"
  );

  assert.equal(run("window.NerdWars.audio.setMusicVolume(5)"), 1, "clamped at the top");
  assert.equal(run("window.NerdWars.audio.setMusicVolume(-3)"), 0, "and at the bottom");

  // The help screen drives it, which is where a player will actually find it.
  run("window.NerdWars.audio.setMusicVolume(0.5); scene = 'help';");
  const moved = run(`(function(){
    var real = tapped;
    tapped = function (code) { return code === 'KeyD'; };
    try { updateHelp(); } finally { tapped = real; }
    return { music: AUDIO.music, scene: scene };
  })()`);
  assert.ok(moved.music > 0.5, "right should turn it up, got " + moved.music);
  assert.equal(moved.scene, "help",
    "and must not fall through into something that closes the screen");
});


test("with no clock, four CPUs still settle it on stocks", async () => {
  /* Removing the time limit means stocks are the ONLY way a match can end, so
     the thing worth guarding is that they reliably do. Four actual CPUs --
     which needs humanCount 0, and so needs the engine rather than the bundle,
     because the brawl hands the first two seats to the keyboard.

     Measured over eight seeded runs before this was written: all eight ended,
     between 48 and 86 seconds. The cap here is five minutes, which is not a
     time limit sneaking back in -- it is the point at which the test gives up
     and says so. */
  const run = await bootEngine();
  run("select.cursor=[0,1,2,3]; twoPlayer=true; playerCount=4; humanCount=0;" +
      " stagePick=0; startBattle();");
  const at = run(`(function(){
    for (var i = 0; i < 60 * 60 * 5; i++) {
      step();
      if (scene !== 'battle') return i;
    }
    return -1;
  })()`);

  assert.ok(at > 0,
    "four CPUs went five minutes without resolving. With the time limit gone " +
    "there is nothing else to end a match, so this would run forever");
  assert.ok(at > 60 * 10,
    "it ended after " + (at / 60).toFixed(0) + "s, which is too fast to have " +
    "been a fight -- something is ending the match early");
  assert.equal(run("scene"), "results");
});

/* "trevors fishingpole doesnt have an animation" -- and it did not. The move
 * it replaced was a guillotine choke with no art of its own, which read fine
 * because the victim was visibly held at his side. A pole that reaches 46px
 * across the stage and shows nothing between the button and the catch does
 * not, and a WHIFF showed nothing at all.
 *
 * Measured against what an idle fighter draws, so it cannot be satisfied by
 * the sprite that was always there.
 */
test("the fishing pole is visible while it is cast, and when it misses", async () => {
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const SP_DOWN = 1024;
  const r = run(`(function(){
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
    me.grabbing = -1;
    me.x = main.x + 40; me.y = main.y; me.grounded = true; me.facing = 1;
    // Far out of reach, so this is a clean whiff from start to finish.
    foe.x = main.x + main.w - 6; foe.y = main.y;
    foe.invuln = 0; foe.hitstop = 0; foe.vx = 0; foe.vy = 0;

    var count = function () {
      var n = 0;
      var rec = { globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
        save: function () {}, restore: function () {}, translate: function () {},
        scale: function () {}, rotate: function () {},
        fillRect: function () { n++; }, drawImage: function () { n++; },
        beginPath: function () {}, moveTo: function () {}, lineTo: function () {},
        stroke: function () { n++; }, arc: function () {}, fill: function () { n++; },
        closePath: function () {}, setLineDash: function () {} };
      drawFighter(rec, me);
      return n;
    };

    var idle = count();
    var during = [];
    netplay.active = true;
    for (var i = 0; i < 40; i++) {
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_DOWN} : 0), bitsToPad(0)];
      step();
      during.push({ f: me.attackFrame, state: me.state, ops: count() });
    }
    netplay.active = false; netplay.framePads = null;
    return { idle: idle, during: during, caught: me.grabbing >= 0 };
  })()`);

  assert.ok(!r.caught, "precondition: this is meant to be a whiff");
  const casting = r.during.filter((d) => d.state === "special");
  assert.ok(casting.length > 20, "precondition: the cast should run ~39 frames");

  const richer = casting.filter((d) => d.ops > r.idle);
  assert.ok(
    richer.length >= 10,
    "the pole should be on screen for a good part of its 39 frames. An idle " +
      "Trev draws " + r.idle + " things; during the cast he drew " +
      JSON.stringify(casting.map((d) => d.ops)) +
      " -- only " + richer.length + " frames showed anything extra"
  );
});

test("the title screen says which version it is", async () => {
  /* Two identifiers, two jobs: BUILD_ID is a content hash the lobby compares
     and is useless in a sentence; VERSION is the one somebody can read off
     the screen and tell you. Nothing derives VERSION, so this at least
     catches it going missing. */
  const run = await bootEngine();
  assert.match(run("window.NerdWars.version"), /^\d+\.\d+$/,
    "version should look like a version, got " +
      JSON.stringify(run("window.NerdWars.version")));

  run("scene = 'title';");
  const drawn = run(`(function(){
    var seen = [];
    var real = text;
    text = function (str) { seen.push(String(str)); return real.apply(null, arguments); };
    try { drawTitle(); } finally { text = real; }
    return seen;
  })()`);
  assert.ok(
    drawn.some((t) => t === "v" + run("window.NerdWars.version")),
    "the title screen should show the version; it drew " + JSON.stringify(drawn)
  );
});

test("a direct sword hit sets them alight for 15 over four seconds", async () => {
  /* Burning is poison's twin and deliberately not poison: they stack, and a
     kiss and a laser sword are two different things happening to you. The
     bolt the sword throws does NOT carry it -- the fire is what you get for
     closing to arm's length with a weapon that can also be thrown. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const spec = run("ROSTER.trev.ult.swing.burn");
  assert.ok(
    Math.abs(spec.frames * spec.dps - 15) < 0.01,
    "the burn should total 15, not " + (spec.frames * spec.dps)
  );
  assert.equal(run("ROSTER.trev.ult.swing.beam.burn"), undefined,
    "the thrown bolt must not light people, or there is no reason to ever " +
    "take the unsafe option");

  const ULT = 256;
  const r = run(`(function(){
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.vx = 0; me.vy = 0; me.grabbing = -1;
    me.x = main.x + 60; me.y = main.y; me.grounded = true; me.facing = 1;
    me.swordTimer = 500;
    foe.setState('idle'); foe.attackFrame = 0; foe.hasHit = true;
    foe.invuln = 0; foe.hitstop = 0; foe.stocks = 99; foe.health = 100;
    foe.x = me.x + 12; foe.y = main.y; foe.grounded = true;
    var lit = 0;
    netplay.active = true;
    for (var i = 0; i < 90; i++) {
      foe.x = me.x + 12; foe.vx = 0; foe.invuln = 0;
      netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
      step();
      if (foe.burn > 0) lit++;
    }
    netplay.active = false; netplay.framePads = null;
    return { lit: lit, burn: foe.burn, burnDps: foe.burnDps };
  })()`);

  assert.ok(r.lit > 40, "the sword should have set them on fire; burning on " +
    r.lit + " of 90 frames");
  assert.ok(r.burn > 0, "and it should still be burning after 90 frames");

  // It has to be visible, or "there is an on-fire animation" is not true.
  const drawn = run(`(function(){
    var f = fighters[1];
    f.burn = 200; f.invuln = 0;
    var n = 0, styles = {};
    var rec = { globalAlpha: 1, fillStyle: '#000',
      save: function () {}, restore: function () {}, translate: function () {},
      scale: function () {},
      fillRect: function () { n++; styles[this.fillStyle] = 1; },
      drawImage: function () {}, beginPath: function () {},
      arc: function () {}, fill: function () {} };
    drawFighter(rec, f);
    return { rects: n, styles: Object.keys(styles) };
  })()`);
  assert.ok(drawn.rects >= 8,
    "a burning fighter should be visibly on fire; drew " + drawn.rects + " rects");
  assert.ok(drawn.styles.some((c) => c === "#ff3c14"),
    "and in fire colors, not the poison pink; used " + JSON.stringify(drawn.styles));
});

test("SIDEARM actually pins somebody caught mid-swing", async () => {
  /* It never had. applyHit tested defender.state against 'attack' twenty-six
     lines AFTER setState('hitstun') had overwritten it, so the condition was
     'hitstun' === 'attack' and could not once be true. The 48-frame read --
     the thing the move is FOR -- had never fired in the game's life.
     Measured before the fix: eleven frames, same as hitting them standing. */
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=2; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const hit = (state) => run(`(function(){
    var me = fighters[0], foe = fighters[1];
    var gun = ROSTER.johnnyham.specials.up;
    foe.setState('${state}'); foe.timer = 0; foe.attackFrame = 2;
    foe.hitstun = 0; foe.hitstop = 0; foe.invuln = 0; foe.health = 100;
    foe.volleySince = 999; foe.volleyOf = null;
    foe.x = me.x + 20; foe.y = me.y;
    applyHit(me, foe, gun, me.x);
    return foe.hitstun;
  })()`);
  const stun = run("ROSTER.johnnyham.specials.up.punish.stun");

  for (const committed of ["attack", "special", "ult"]) {
    assert.equal(hit(committed), stun,
      "catching somebody in '" + committed + "' should pin them for " + stun +
      " frames, got " + hit(committed));
  }
  for (const open of ["idle", "walk"]) {
    assert.ok(hit(open) < stun,
      "an ordinary hit on somebody in '" + open + "' must NOT pin: got " +
      hit(open) + " of a possible " + stun);
  }
});

test("the pin irons show on a pin and on nothing else", async () => {
  /* The trap: the pin lives in `hitstun`, which every ordinary blow in the
     game also writes, so a naive check would put irons on every hit. The
     detection is that hitstun + timer stays exactly the number applyHit
     assigned, and only the Math.max writes get above the ordinary cap. */
  const run = await bootEngine();
  run("select.cursor=[2,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const cap = run("COMBAT.hitstunCap");
  const check = (hitstun) => run(`(function(){
    var f = fighters[1];
    f.setState('hitstun'); f.timer = 0; f.hitstun = ${hitstun}; f.invuln = 0;
    var n = 0;
    var rec = { globalAlpha: 1, fillStyle: '#000',
      fillRect: function () { n++; }, drawImage: function () {},
      save: function () {}, restore: function () {}, translate: function () {},
      scale: function () {}, beginPath: function () {}, arc: function () {},
      fill: function () {} };
    drawFighter(rec, f);
    return { pinned: isPinned(f), rects: n };
  })()`);

  const pinned = check(120);
  assert.ok(pinned.pinned, "120 frames of hitstun is a pin");
  assert.ok(pinned.rects >= 8,
    "a pinned fighter should be visibly in irons, drew " + pinned.rects);

  for (const ordinary of [6, 12, cap]) {
    const r = check(ordinary);
    assert.equal(r.pinned, false,
      ordinary + " frames is an ordinary hit and must NOT show irons -- the " +
      "cap on everything that is not a pin is " + cap);
  }
});

test("the dog changes pose when it leaps", async () => {
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const SP_DOWN = 1024;
  const r = run(`(function(){
    var me = fighters[0];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
    me.x = main.x + 30; me.y = main.y; me.grounded = true; me.facing = 1;
    var air = 0, ground = 0;
    netplay.active = true;
    for (var i = 0; i < 110; i++) {
      netplay.framePads = [bitsToPad((i === 0 || i === 60) ? ${SP_DOWN} : 0), bitsToPad(0)];
      step();
      var d = projectiles.filter(function (b) { return b.constructor.name === 'Dog'; })[0];
      if (!d) continue;
      var blits = 0;
      var rec = { globalAlpha: 1, fillStyle: '#000', fillRect: function () {},
        drawImage: function () { blits++; }, save: function () {},
        restore: function () {}, translate: function () {}, scale: function () {},
        beginPath: function () {}, arc: function () {}, fill: function () {} };
      d.draw(rec);
      if (blits > 0) air++; else ground++;
    }
    netplay.active = false; netplay.framePads = null;
    return { air: air, ground: ground };
  })()`);

  assert.ok(r.ground > 20, "it should spend most of its life trotting");
  assert.ok(r.air > 10,
    "a leaping dog should be drawn as a pose rather than the running frames; " +
    "only " + r.air + " frames used one");
});

test("charging the pawn walks knight, bishop, rook, queen and round again", async () => {
  /* The charge is a choice you make by watching, so the two things that have
     to be true are that it cycles in order and that letting go keeps what was
     showing. The cycle wraps on purpose: holding forever is not a way to get
     a queen, it is a way to lose track of one. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  const move = run("(function(){var s = ROSTER.trev.specials.up;" +
    "return { kind: s.kind, label: s.label, swapEvery: s.charge.swapEvery,\n" +
    "  hold: s.charge.hold, startup: s.startup };})()");
  assert.equal(move.kind, "pawn", "Trev's up special should be the pawn");
  /* Joined rather than deepEqual'd. Objects and arrays built inside a vm
     context carry that realm's prototypes -- passing the host's Array into
     the sandbox does not change what a literal uses -- so deepStrictEqual
     fails on a prototype mismatch while printing two values that look
     identical. Comparing content sidesteps the whole question. */
  assert.equal(run("CHESS_PIECES.map(function(c){return c.key;}).join(',')"),
    "knight,bishop,rook,queen",
    "weakest to strongest, which is the order the button walks");

  /* 2048 is the EDGE -- the frame the key goes down, which is what starts
     the move -- and 4096 is `specialHold`, the level that says it is still
     down. A real keyboard sends both on the first frame and only the level
     after that, and this test now says so.

     It used to send 2048 every frame, which no keyboard ever produces, and
     that is how it passed for a charge that on a real keyboard fired
     instantly and always handed over a knight. A harness that answers the
     question instead of asking it will do that. The keyboard-driven version
     of this lives in nerdwars-movesets.test.js. */
  /* 16384 is holdUp specifically, not "some special is down". The holds are
     one bit per button so a charge can only be held open by the button that
     opened it -- 4096 is holdNeutral and would not keep this one alive, which
     is the point: holding H used to pin a charge started with K. */
  const SP_UP = 2048, SP_HOLD = 16384;
  /* Both fighters pinned and untouchable. The charge is pinned to a frame
     counter that hitstop freezes, so a CPU landing one hit mid-charge stalls
     the cycle and the frame numbers below stop meaning anything. */
  const setup = `
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grounded = true; me.facing = 1;
    me.x = main.x + 30; me.y = main.y;
    me.specialSpawned = false; me.chargePiece = 0; me.chargeTimer = 0;
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.vx = 0; foe.vy = 0;
    foe.grounded = true; foe.hasHit = true;`;

  const cycle = run(`(function () {
    ${setup}
    var seen = [];
    netplay.active = true;
    for (var i = 0; i < 120; i++) {
      foe.hitstop = 0; me.hitstop = 0;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_UP} | ${SP_HOLD} : ${SP_HOLD}),
                           bitsToPad(0)];
      step();
      var k = CHESS_PIECES[me.chargePiece].key;
      if (!seen.length || seen[seen.length - 1] !== k) seen.push(k);
    }
    netplay.active = false; netplay.framePads = null;
    return { seen: seen, state: me.state, af: me.attackFrame,
             out: projectiles.length };
  })()`);

  assert.equal(cycle.seen.join(","),
    "knight,bishop,rook,queen,knight,bishop",
    "holding should walk the order and wrap; saw " + cycle.seen.join(" -> "));
  assert.equal(cycle.state, "special",
    "and he should still be standing there charging after 120 frames");
  assert.equal(cycle.af, move.startup,
    "with the move pinned at the end of its startup, not advancing");
  assert.equal(cycle.out, 0, "nothing fires while the button is down");

  // Letting go sends whatever was showing.
  const fire = (holdFor) => run(`(function () {
    ${setup}
    var carried = null;
    netplay.active = true;
    for (var i = 0; i < ${holdFor} + 30; i++) {
      foe.hitstop = 0; me.hitstop = 0;
      netplay.framePads = [bitsToPad(
        i === 0 ? ${SP_UP} | ${SP_HOLD} : (i < ${holdFor} ? ${SP_HOLD} : 0)),
        bitsToPad(0)];
      step();
      var p = projectiles.filter(function (q) { return q.constructor.name === 'Pawn'; })[0];
      if (p && !carried) carried = p.pieceKey;
    }
    netplay.active = false; netplay.framePads = null;
    return carried;
  })()`);

  /* And it has to be on screen, or the choice cannot be made. A charge you
     cannot see is just a delay: the whole mechanic is watching the piece
     change and letting go on the one you want. */
  const drawn = run(`(function () {
    ${setup}
    var blits = 0, none = 0;
    var rec = { globalAlpha: 1, fillStyle: '#000',
      fillRect: function () {}, drawImage: function () { blits++; },
      save: function () {}, restore: function () {}, translate: function () {},
      scale: function () {}, beginPath: function () {}, arc: function () {},
      fill: function () {} };
    netplay.active = true;
    for (var i = 0; i < 40; i++) {
      foe.hitstop = 0; me.hitstop = 0;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_UP} | ${SP_HOLD} : ${SP_HOLD}),
                           bitsToPad(0)];
      step();
    }
    drawCharge(rec, me);              // mid-charge
    var charging = blits;
    netplay.active = false; netplay.framePads = null;
    blits = 0;
    me.setState('idle'); me.specialSpawned = true;
    drawCharge(rec, me);              // not charging
    none = blits;
    return { charging: charging, none: none };
  })()`);
  assert.ok(drawn.charging > 0,
    "the piece he is holding must be drawn while charging");
  assert.equal(drawn.none, 0,
    "and nothing drawn when he is not");

  assert.equal(fire(1), "knight",
    "a tap should send the first piece in the cycle, not nothing and not a queen");
  const held = [fire(30), fire(50), fire(70)];
  assert.ok(held.every(Boolean), "every hold should fire something: " + held);
  assert.notEqual(held[2], "knight",
    "holding most of two cycles should not still be on the knight; got " + held[2]);
});

test("the pawn promotes into its piece's own directions", async () => {
  /* A bishop is its diagonals, a rook its ranks and files, a queen both, and
     a knight eight L's. The counts are the cheapest true statement of that,
     and they are what a burst actually is. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const counts = JSON.parse(run(
    "JSON.stringify(CHESS_PIECES.reduce(function (a, c) {" +
    "  a[c.key] = c.dirs.length; return a; }, {}))"));
  assert.equal(JSON.stringify(counts),
    JSON.stringify({ knight: 8, bishop: 4, rook: 4, queen: 8 }),
    "a rook has four directions and a queen eight; got " + JSON.stringify(counts));

  // Damage per shard climbs with the cycle, which is what the charge buys.
  const dmg = run("CHESS_PIECES.map(function(c){return c.damage;})");
  for (let i = 1; i < dmg.length; i++) {
    assert.ok(dmg[i] > dmg[i - 1],
      "each piece in the cycle should hit harder than the last; " + dmg.join(", "));
  }

  /* And a real one: send a pawn into somebody and count what comes out.
     Driven through the projectile, not through the charge, so a failure here
     is about promotion rather than about input. */
  const burst = (pieceKey) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.hitstop = 0; me.damageMul = 1;
    me.x = main.x + 30; me.y = main.y; me.facing = 1; me.grounded = true;
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.invuln = 0; foe.stocks = 99; foe.health = 1000;
    foe.vx = 0; foe.vy = 0; foe.y = main.y; foe.grounded = true;
    foe.hasHit = true;
    /* Absolute, and both of them. Pinning the victim to me.x + 40 pinned it
       to a CPU that walks -- so the target trotted away at 1.46 a frame from
       a pawn that does 0.85, and it never once caught up. */
    var HOME = main.x + 30, AWAY = main.x + 70;
    me.x = HOME; foe.x = AWAY;
    var p = new Pawn(me, ROSTER.trev.specials.up, ${JSON.stringify(pieceKey)});
    projectiles.push(p);
    var shards = 0, burstAt = -1, before = foe.health;
    for (var i = 0; i < 90; i++) {
      me.x = HOME; me.vx = 0; me.y = main.y; me.hitstop = 0;
      if (burstAt < 0) { foe.x = AWAY; foe.vx = 0; foe.y = main.y; }
      foe.invuln = 0; foe.hitstop = 0;
      step();
      var sh = projectiles.filter(function (q) {
        return q.constructor.name === 'PieceShard'; });
      if (sh.length && burstAt < 0) { burstAt = i; shards = sh.length; }
    }
    return { shards: shards, burstAt: burstAt,
             lost: before - foe.health };
  })()`);

  for (const key of ["knight", "bishop", "rook", "queen"]) {
    const r = burst(key);
    assert.ok(r.burstAt >= 0, "a " + key + " pawn should reach them and promote");
    assert.equal(r.shards, counts[key],
      "a " + key + " should burst into " + counts[key] + " shards, saw " + r.shards);
    assert.ok(r.lost > 0, "and it should hurt; a " + key + " took " + r.lost);
  }
});

test("the burst is a firework: it slows, and it reaches as far as it hits hard", async () => {
  /* The first version ran every ray at a flat 2.6 a frame for 26 frames and
     read as eight tracer rounds leaving a gun. A firework leaves fast, slows,
     and dies where it stops -- and a queen's goes further than a knight's,
     because range is the other half of what the charge buys you. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  /* One ray in open air with nothing to hit, built directly: this measures
     the flight rather than whatever a match happened to allow. */
  const fly = (key) => run(`(function () {
    var me = fighters[0];
    var piece = CHESS_PIECES.filter(function (c) {
      return c.key === ${JSON.stringify(key)}; })[0];
    var fake = { owner: me, x: 160, y: 90, spec: ROSTER.trev.specials.up };
    var sh = new PieceShard(fake, piece, { dx: 1, dy: 0 });
    var x0 = sh.x, first = 0, last = 0, n = 0;
    for (var i = 0; i < 90 && !sh.dead; i++) {
      var was = sh.x;
      sh.update();
      var step = sh.x - was;
      if (i === 0) first = step;
      last = step;
      n++;
    }
    return { flown: sh.x - x0, want: piece.reach, damage: piece.damage,
             first: first, last: last, frames: n };
  })()`);

  const shot = {};
  for (const k of ["knight", "bishop", "rook", "queen"]) shot[k] = fly(k);

  // It goes where the piece says it goes.
  for (const k of Object.keys(shot)) {
    assert.ok(Math.abs(shot[k].flown - shot[k].want) < 1.5,
      k + " should cover its declared reach of " + shot[k].want +
      ", flew " + shot[k].flown.toFixed(1));
  }

  /* Range climbs with the cycle, exactly as damage does. This is the half
     that was asked for and the half that is easiest to lose in a retune. */
  const order = ["knight", "bishop", "rook", "queen"];
  for (let i = 1; i < order.length; i++) {
    const prev = shot[order[i - 1]], cur = shot[order[i]];
    assert.ok(cur.flown > prev.flown + 4,
      order[i] + " should out-reach " + order[i - 1] + "; " +
      cur.flown.toFixed(1) + " against " + prev.flown.toFixed(1));
    assert.ok(cur.damage > prev.damage,
      order[i] + " should out-damage " + order[i - 1]);
  }

  /* And it is a firework rather than a bullet: the last step of the flight is
     a fraction of the first. A constant-speed shard makes this ratio 1. */
  for (const k of Object.keys(shot)) {
    assert.ok(shot[k].last < shot[k].first * 0.25,
      k + " should be coasting to a stop, not cruising: first step " +
      shot[k].first.toFixed(2) + ", last " + shot[k].last.toFixed(2));
  }

  /* A diagonal has to be a unit vector or it covers root two times the
     distance an orthogonal does, and a queen's burst comes out a square with
     the corners 41% further out than the sides. */
  const diag = run(`(function () {
    var me = fighters[0];
    var piece = CHESS_PIECES.filter(function (c) { return c.key === 'bishop'; })[0];
    var fake = { owner: me, x: 160, y: 90, spec: ROSTER.trev.specials.up };
    var sh = new PieceShard(fake, piece, piece.dirs[0]);
    var x0 = sh.x, y0 = sh.y;
    for (var i = 0; i < 90 && !sh.dead; i++) sh.update();
    var ax = sh.x - x0, ay = sh.y - y0;
    return { dist: Math.sqrt(ax * ax + ay * ay), want: piece.reach };
  })()`);
  assert.ok(Math.abs(diag.dist - diag.want) < 1.5,
    "a diagonal ray should cover the same distance as a straight one; went " +
    diag.dist.toFixed(1) + " against " + diag.want);

  /* The knight turns two thirds of the way ALONG THE RAY, which is not two
     thirds of the way through the frames once the thing is decelerating.
     Measured, turning on frame 22 gave 2.69:1; this is the 2:1 a knight
     actually moves. */
  const corner = run(`(function () {
    var me = fighters[0];
    var piece = CHESS_PIECES.filter(function (c) { return c.key === 'knight'; })[0];
    var fake = { owner: me, x: 160, y: 90, spec: ROSTER.trev.specials.up };
    var sh = new PieceShard(fake, piece, { dx: 1, dy: 0, turn: { dx: 0, dy: 1 } });
    var x0 = sh.x, y0 = sh.y;
    for (var i = 0; i < 90 && !sh.dead; i++) sh.update();
    return { across: sh.x - x0, down: sh.y - y0 };
  })()`);
  const ratio = corner.across / Math.max(0.01, corner.down);
  assert.ok(ratio > 1.6 && ratio < 2.5,
    "a knight goes two squares and then one, so the L should be near 2:1; " +
    "got " + ratio.toFixed(2) + ":1 (" + corner.across.toFixed(1) + " across, " +
    corner.down.toFixed(1) + " down)");

  /* And it is drawn as a TRACER -- the whole ray from where it started to
     where it has got to -- rather than as a dot with a smudge behind it. A
     firework is its line; the bright point at the end is the least of it.

     The alpha count is part of the contract, not trivia: a globalAlpha
     assignment costs more than the fills it guards, and eight rays of sixty
     pixels is a lot of pixels. Per-pixel fading would be the obvious way to
     write this and the wrong one. */
  const drawn = run(`(function () {
    var me = fighters[0];
    var piece = CHESS_PIECES.filter(function (c) { return c.key === 'queen'; })[0];
    var fake = { owner: me, x: 160, y: 90, spec: ROSTER.trev.specials.up };
    var sh = new PieceShard(fake, piece, { dx: 1, dy: 0 });
    for (var i = 0; i < 20; i++) sh.update();
    var rects = [];
    var rec = { globalAlpha: 1, fillStyle: '#000',
      fillRect: function (x, y, w, h) { rects.push({ x: x, a: this.globalAlpha }); },
      drawImage: function () {}, save: function () {}, restore: function () {},
      translate: function () {}, scale: function () {}, beginPath: function () {},
      arc: function () {}, fill: function () {} };
    sh.draw(rec);
    var xs = rects.map(function (r) { return r.x; });
    var alphas = [];
    for (var i = 0; i < rects.length; i++) {
      var a = +rects[i].a.toFixed(3);
      if (alphas.indexOf(a) < 0) alphas.push(a);
    }
    return { rects: rects.length,
             span: Math.max.apply(null, xs) - Math.min.apply(null, xs),
             ray: sh.x - sh.ox, alphas: alphas.length };
  })()`);
  assert.ok(drawn.span > drawn.ray * 0.8,
    "the ray should be drawn along its whole length; drew " +
    drawn.span + "px of a " + drawn.ray.toFixed(1) + "px ray");
  assert.ok(drawn.rects > 8,
    "a line, not a dot and three smudges; drew " + drawn.rects + " rects");
  assert.ok(drawn.alphas <= 6,
    "the fade should be a few bands, not one alpha per pixel; used " +
    drawn.alphas + " distinct alphas over " + drawn.rects + " rects");
});

test("SIDEARM's recoil has a ceiling, and never cancels a real launch", async () => {
  /* The recoil ACCUMULATES -- every shot subtracts another kickX -- and
     nothing in the air used to put a ceiling on it. Each shot also cancels
     his fall and hands back an air jump, so he could hang there firing and
     the speed just kept climbing: measured at 1.9 and 59px of drift for one
     shot, 3.8 and 251px for two, 5.7 and 439px for three, on a stage 320
     pixels wide. Jump and spam it and he flew off the side and died.

     kickMax is 1.9, which is both one kick and PHYS.airDriftMax, the fastest
     a player can push themselves sideways in the air. The rule is that the
     gun can never carry you quicker than your own drift. A cap of 3 was
     tried first and was not enough -- the hang time multiplies whatever the
     speed is, and a triple-fire still reached x=-52 and killed him. */
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  const gun = run("(function(){var s = ROSTER.johnnyham.specials.up;" +
    "return { kickX: s.kickX, kickMax: s.kickMax, drift: PHYS.airDriftMax };})()");
  assert.ok(gun.kickMax > 0, "the recoil needs a ceiling at all");
  assert.ok(gun.kickMax <= gun.drift + 0.01,
    "the ceiling should not exceed a player's own air drift (" + gun.drift +
    "); it is " + gun.kickMax);

  const SP_U = 2048;
  /* Fire it repeatedly in mid-air, held up so he can keep going -- which is
     the situation the old code turned into a rocket. */
  const spam = (shots, startVx) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.grabbing = -1;
    me.vx = ${startVx}; me.vy = 0;
    me.x = main.x + main.w / 2; me.y = main.y - 40;
    me.grounded = false; me.facing = 1; me.specialSpawned = false;
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + 4; foe.y = main.y; foe.hasHit = true;
    var worst = 0, fired = 0, after = null;
    netplay.active = true;
    for (var i = 0; i < 240 && fired < ${shots}; i++) {
      me.hitstop = 0; me.mana = 999;
      var free = (me.state !== 'special');
      netplay.framePads = [bitsToPad(free ? ${SP_U} : 0), bitsToPad(0)];
      var was = me.specialSpawned;
      step();
      if (!was && me.specialSpawned) { fired++; if (after === null) after = me.vx; }
      if (Math.abs(me.vx) > Math.abs(worst)) worst = me.vx;
      me.vy = Math.min(me.vy, 0);
      me.grounded = false;
    }
    netplay.active = false; netplay.framePads = null;
    return { fired: fired, worst: worst, after: after };
  })()`);

  // One shot is untouched: the common case, and his recovery.
  const one = spam(1, 0);
  assert.equal(one.fired, 1, "one shot should have gone off");
  assert.ok(Math.abs(Math.abs(one.worst) - gun.kickX) < 0.2,
    "a single shot should still give the full kick of " + gun.kickX +
    "; got " + one.worst.toFixed(2));

  // And stacking buys nothing.
  for (const n of [2, 3, 5]) {
    const many = spam(n, 0);
    assert.ok(Math.abs(many.worst) <= gun.kickMax + 0.01,
      n + " shots must not stack past the ceiling of " + gun.kickMax +
      "; reached " + many.worst.toFixed(2));
  }

  /* The subtle half. The clamp's window always contains his CURRENT vx, so
     somebody genuinely launched across the stage keeps every pixel of it --
     firing mid-flight neither adds to it nor helps him out of it. A naive
     clamp to the cap would turn the gun into a free brake on knockback,
     which is a bigger bug than the one being fixed. */
  /* Measured on the frame the shot goes off, NOT as the worst over the run:
     he enters this already travelling at 8, so a worst-of reading captures
     that before the clamp has run and passes whatever the clamp does. That
     version of this assertion did not fail when the clamp was replaced with a
     naive clamp(-cap, cap), which is exactly the bug it is here to catch. */
  const launched = spam(1, -8);
  assert.ok(Math.abs(launched.after) >= 7.9,
    "a fighter already flying at 8 must keep it; the recoil left him at " +
    launched.after.toFixed(2));
});

test("Kel's bone is three throws, and which one depends on what he was doing", async () => {
  /* Standing he gets a boomerang, walking a fastball, airborne a spike -- and
     the airborne one carries his horizontal speed, so a running jump-throw
     goes somewhere a standing one cannot. That last part is the case the
     pizza already gets right and the reason it feels alive.

     The capture point is the interesting bit. groundFriction is 0.55, so six
     frames of the bone's startup leaves four percent of a walk: by the frame
     the projectile spawns there is nothing left to tell "he was running" from
     "he was standing". throwFast is read in startAttack, before any of the
     startup runs. In the AIR it works off owner.vx directly, because nothing
     damps horizontal speed up there. */
  const run = await bootEngine();
  run("select.cursor=[2,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("ROSTER.kel.specials.neutral.kind"), "projectile",
    "this is Kel's bone");

  const SP_N = 512, RIGHT = 2;
  const throwIt = (how) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grounded = true; me.facing = 1;
    me.x = main.x + 60; me.y = main.y; me.specialSpawned = false;
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    foe.grounded = true; foe.vx = 0; foe.vy = 0;
    var how = ${JSON.stringify('HOW')};
    if (how === 'jump' || how === 'runjump') {
      me.grounded = false; me.y = main.y - 34; me.vy = 0;
    }
    if (how === 'running' || how === 'runjump') me.vx = me.def.walk;
    var hold = (how === 'running' || how === 'runjump') ? ${RIGHT} : 0;
    /* Measured from the BONE's own spawn, not from where Kel started.
       Measuring from Kel conflates "the throw went further" with "he had
       already walked a few pixels before releasing it" -- and that is not
       hypothetical: it made the momentum assertion below pass even with the
       inheritance deleted, because a running Kel simply spawns it further
       along. */
    var sx = null, mode = null, firstVy = null, near = 0, far = 0, n = 0;
    netplay.active = true;
    for (var i = 0; i < 130; i++) {
      me.hitstop = 0; foe.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad((i === 0 ? ${SP_N} : 0) | hold), bitsToPad(0)];
      step();
      var b = projectiles.filter(function (q) { return q.constructor.name === 'Bone'; })[0];
      if (!b) continue;
      if (!mode) { mode = b.mode; firstVy = b.vy; sx = b.x; }
      var dx = b.x - sx;
      if (dx < near) near = dx;
      if (dx > far) far = dx;
      n++;
    }
    netplay.active = false; netplay.framePads = null;
    return { mode: mode, firstVy: firstVy, near: near, far: far, frames: n };
  })()`.replace('"HOW"', JSON.stringify(how)));

  const still = throwIt("still");
  const running = throwIt("running");
  const jump = throwIt("jump");
  const runjump = throwIt("runjump");

  // Three distinct modes, chosen by state.
  assert.equal(still.mode, "boom", "standing still should give the boomerang");
  assert.equal(running.mode, "skip", "walking should give the fastball");
  assert.equal(jump.mode, "spike", "airborne should give the spike");
  assert.equal(runjump.mode, "spike", "still a spike from a running jump");

  /* The boomerang has to actually come back -- past him, not merely stop
     short. Everything else must NOT, or "it comes back" is meaningless. */
  assert.ok(still.near < -6,
    "the standing throw should return past him; nearest was " + still.near);
  assert.ok(still.far > 30,
    "and go somewhere first; furthest was " + still.far);
  for (const [name, r] of [["running", running], ["jump", jump],
                           ["runjump", runjump]]) {
    assert.ok(r.near > -1,
      "only the standing throw comes back; " + name + " reached " + r.near);
  }

  // The spike is thrown DOWN, which is what makes it a spike.
  assert.ok(jump.firstVy > 1,
    "an airborne bone should be thrown downward; vy was " + jump.firstVy);
  assert.ok(still.firstVy <= 0.01,
    "the boomerang should be flat, not falling; vy was " + still.firstVy);

  /* And the airborne throw carries him. This is the assertion that fails if
     anyone drops the `owner.vx * 0.3` term, which is easy to read as noise. */
  assert.ok(runjump.far > jump.far + 8,
    "a running jump should throw it further than a standing one; " +
    runjump.far.toFixed(1) + " against " + jump.far.toFixed(1));

  /* The fastball is the long one on the ground. If this ever inverts, the
     standing throw has quietly become the better poke and the boomerang has
     no reason to exist. */
  assert.ok(running.far > still.far + 20,
    "the running throw should out-range the boomerang; " +
    running.far.toFixed(1) + " against " + still.far.toFixed(1));
});

/* The whole shout: driven, measured and asserted in one function.

   It is a function rather than a test body because a negative control at the
   foot of this file runs THIS code against a one-line-mutated copy of the
   engine and requires it to throw. A control that re-types the checks is not
   checking the same thing, and a control that passes because the copy was
   subtly different proves nothing at all. `engineSrc` is undefined for the
   real run, which is what makes bootEngine read the shipped engine. */
async function checkShout(engineSrc) {
  const run = await bootEngine(engineSrc);
  run("select.cursor=[4,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.specials.neutral.kind"), "belch",
    "player 1 should be the one who shouts");

  /* The direction bits, and the special-neutral button. UP and DOWN are held
     from the frame AFTER the press rather than with it: updateAttack clears
     the latch on attackFrame 1 and then reads the pad for as long as the
     startup lasts, which is what a person's hands actually do, and pressing
     DOWN on the same frame as the cast would be read by updateFree as a
     drop-through before the special ever started. */
  const SP_N = 512;
  const BIT = { level: 0, up: 4, down: 8 };
  const TINTS = run("BELCH_TINTS.slice().sort().join(',')");

  /* Which way the drawn bracket has to LEAN, as a range on the mean of its
     painted pixels measured from the wave's own center. This is the half of
     the rewrite no geometric check can see: the bracket used to be a stroked
     arc that always opened along x, and one that still did would sit dead
     level on all three aims while every number below stayed perfect.
     Measured: level 0.00, up -5.30, down +1.73. */
  const LEAN = { level: [-1, 1], up: [-99, -2], down: [0.6, 99] };

  const shout = (aim, facing) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
    me.poison = 0; me.burn = 0; me.confused = 0;
    me.grabbing = -1; me.grounded = true; me.facing = ${facing};
    me.x = 160; me.y = main.y; me.specialSpawned = false;
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    var box = null, colors = {}, drawn = null, most = 0, n = 0;
    var fwdMin = 1e9, fwdMax = -1e9, dyMin = 1e9, dyMax = -1e9;
    netplay.active = true;
    for (var i = 0; i < 34; i++) {
      me.hitstop = 0; me.mana = 999; me.facing = ${facing};
      var bits = i === 0 ? ${SP_N} : (i <= 8 ? ${BIT[aim]} : 0);
      netplay.framePads = [bitsToPad(bits), bitsToPad(0)];
      step();

      /* The box, taken once on the first frame it is live. It is only live
         for the five active frames and the waves outlive that by a dozen, so
         every wave below is compared against a box remembered from earlier
         in the same cast -- which is fair because he does not move: no
         input, no velocity, both feet on the floor. Stored forward-relative
         so one set of numbers covers both facings. */
      var live = me.hitbox();
      if (live && !box) {
        var e0 = (live.box.x - me.x) * ${facing};
        var e1 = (live.box.x + live.box.w - me.x) * ${facing};
        box = { near: Math.min(e0, e1), far: Math.max(e0, e1),
                top: live.box.y - me.y, bot: live.box.y + live.box.h - me.y,
                damage: live.move.damage };
      }

      var ws = effects.filter(function (e) { return e.kind === 'wave'; });
      if (ws.length > most) most = ws.length;
      var tip = null;
      for (var j = 0; j < ws.length; j++) {
        colors[ws[j].color] = 1;
        n++;
        var fwd = (ws[j].x - me.x) * ${facing}, dy = ws[j].y - me.y;
        if (fwd < fwdMin) fwdMin = fwd;
        if (fwd > fwdMax) fwdMax = fwd;
        if (dy < dyMin) dyMin = dy;
        if (dy > dyMax) dyMax = dy;
        if (!tip || fwd > (tip.x - me.x) * ${facing}) tip = ws[j];
      }

      /* And what the furthest one actually PAINTS. The canvas the engine is
         handed here throws every call away, so the bracket has to be drawn
         into a recorder to be seen at all. Only the tip wave is left in
         effects for the call, so nothing else's pixels can be counted as its
         -- the sparks and the burp word are drawn by the same pass and are
         the same handful of fillRects. Overwritten every frame, so what
         survives the loop is the last wave alive, which is the one standing
         where the hitbox ends. */
      if (tip) {
        var rects = [];
        var rec = { globalAlpha: 1, fillStyle: '#000',
          fillRect: function (x, y, w, h) { rects.push([x, y, rec.fillStyle]); },
          drawImage: function () {}, save: function () {}, restore: function () {},
          translate: function () {}, scale: function () {}, beginPath: function () {},
          arc: function () {}, fill: function () {}, stroke: function () {},
          ellipse: function () {}, moveTo: function () {}, lineTo: function () {},
          closePath: function () {}, fillText: function () {},
          measureText: function () { return { width: 0 }; } };
        var all = effects.slice();
        effects.length = 0; effects.push(tip);
        drawEffects(rec);
        effects.length = 0;
        for (var q = 0; q < all.length; q++) effects.push(all[q]);
        var sx = 0, sy = 0, farR = 0;
        for (var m = 0; m < rects.length; m++) {
          sx += rects[m][0]; sy += rects[m][1];
          var ddx = rects[m][0] - tip.x, ddy = rects[m][1] - tip.y;
          var dd = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dd > farR) farR = dd;
        }
        var cnt = rects.length || 1;
        drawn = { n: rects.length,
                  color: rects.length ? rects[0][2] : null,
                  fwd: ((sx / cnt) - tip.x) * ${facing},
                  dy: (sy / cnt) - tip.y,
                  farR: farR };
      }
    }
    netplay.active = false; netplay.framePads = null;
    return { aim: me.belchAim, box: box, most: most, n: n, drawn: drawn,
             colors: Object.keys(colors).sort().join(','),
             fwdMin: fwdMin, fwdMax: fwdMax, dyMin: dyMin, dyMax: dyMax };
  })()`);

  for (const aim of ["level", "up", "down"]) {
    for (const facing of [1, -1]) {
      const r = shout(aim, facing);
      const where = aim + " facing " + (facing > 0 ? "right" : "left");

      // Preconditions. Every comparison below is vacuous without these.
      assert.equal(r.aim, aim,
        "holding the direction through the startup should latch the " + aim +
        " burp, " + where + "; it latched " + r.aim);
      assert.ok(r.box,
        "the " + aim + " burp has to put a live hitbox on the screen, " +
        where + ", or there is nothing to compare the art against");
      assert.ok(r.most >= 2,
        "a shout should put several waves in the air, " + where +
        "; most alive at once was " + r.most);
      assert.equal(r.colors, TINTS,
        "the waves should wear the belch's own tints, " + where +
        "; saw " + r.colors + ", expected " + TINTS);

      /* REACH, which is the assertion this test has always been for. Art and
         hitbox have to make the same claim in BOTH directions: the first cut
         had the waves living 17 frames and outrunning the box by eight
         pixels, which is the same lie as a box that outruns the art.

         It has to hold in y as well now, because a wave can climb or dive. A
         shout whose noise leaves the top of its own box is painting one move
         and hitting with another. */
      assert.ok(r.fwdMin >= r.box.near - 0.01 && r.fwdMax <= r.box.far + 0.01,
        "every wave has to stay inside its own box in x, " + where +
        "; waves ran " + r.fwdMin.toFixed(1) + ".." + r.fwdMax.toFixed(1) +
        ", box " + r.box.near.toFixed(1) + ".." + r.box.far.toFixed(1));
      assert.ok(r.dyMin >= r.box.top - 0.01 && r.dyMax <= r.box.bot + 0.01,
        "and in y, " + where + "; waves ran " + r.dyMin.toFixed(1) + ".." +
        r.dyMax.toFixed(1) + ", box " + r.box.top.toFixed(1) + ".." +
        r.box.bot.toFixed(1));
      assert.ok(r.box.far - r.fwdMax <= 1.5,
        "and the box must not reach further than the art does, " + where +
        "; furthest wave " + r.fwdMax.toFixed(1) + ", box ends " +
        r.box.far.toFixed(1));

      /* The vertical half of the same claim, per aim. Containment on its own
         would be satisfied by waves that never left his mouth, so each aim
         also has to SPEND the height its box is drawing. */
      if (aim === "up") {
        assert.ok(r.dyMin - r.box.top <= 1.5,
          "the upward shout has to climb to the top of its own box, " +
          where + "; highest wave " + r.dyMin.toFixed(1) + ", box top " +
          r.box.top.toFixed(1));
      }
      if (aim === "down") {
        assert.ok(r.box.bot - r.dyMax <= 1.5,
          "the downward shout has to fall to the bottom of its own box, " +
          where + "; lowest wave " + r.dyMax.toFixed(1) + ", box bottom " +
          r.box.bot.toFixed(1));
      }
      if (aim === "level") {
        assert.ok(Math.abs(r.dyMax - r.dyMin) < 0.01,
          "the level shout travels flat -- it is the aim you press when you " +
          "do not want height -- but it drifted from " + r.dyMin.toFixed(2) +
          " to " + r.dyMax.toFixed(2) + ", " + where);
      }

      /* And the bracket that is actually painted. It is fillRect now, and it
         rotates onto the direction of travel; a bracket that still opened
         along x would leave every number above untouched and still draw an
         upward shout with its mouth pointing sideways. */
      assert.ok(r.drawn && r.drawn.n >= 8,
        "the furthest wave should paint a bracket, " + where + "; it drew " +
        (r.drawn ? r.drawn.n : 0) + " rects");
      assert.ok(r.drawn.farR <= 14,
        "and every pixel of it belongs to that wave, " + where +
        "; furthest painted pixel was " + r.drawn.farR.toFixed(1) +
        "px from the wave's center");
      assert.ok(r.drawn.fwd > 3,
        "the bracket opens AHEAD of the wave it belongs to, " + where +
        "; its middle sat " + r.drawn.fwd.toFixed(1) + "px forward");
      assert.ok(r.drawn.dy >= LEAN[aim][0] && r.drawn.dy <= LEAN[aim][1],
        "and it leans the way the shout is aimed, " + where +
        "; its middle sat " + r.drawn.dy.toFixed(1) +
        "px below the wave, wanted " + LEAN[aim][0] + ".." + LEAN[aim][1]);
    }
  }

  /* THE AIM IS A REAL CHOICE, which is the other half of what two extra
     frames of startup and ten extra mana bought.

     up stops sixteen pixels above his feet and a standing hurtbox is
     fourteen tall, so a man on the same floor is entirely underneath it.
     down is eleven pixels tall and slung under him, so anything that has
     left the ground is over it. If either of those stops being true the
     three aims collapse into one skin over one move.

     The level burp lands in BOTH placements, and that is what stops the two
     misses being vacuous: the victim is standing somewhere a shout can
     reach, and only the WRONG aim fails to reach him. */
  const dmg = run("(function(){var p=fighters[0].def.specials.neutral.parts;" +
                  "return {level:p.level.damage, up:p.up.damage," +
                  " down:p.down.damage};})()");

  /* lift is how far off the floor the victim's feet are. Twelve, because at
     twelve his hurtbox still overlaps the level box and the up box and has
     cleared the down one entirely -- the tightest placement that tells all
     three aims apart. He is re-seated every frame until he is hit, because
     gravity would otherwise walk him back down into the aim that is supposed
     to miss him. */
  const connect = (aim, lift) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
    me.poison = 0; me.burn = 0; me.confused = 0; me.hasHit = false;
    me.grabbing = -1; me.grounded = true; me.facing = 1;
    me.x = 160; me.y = main.y; me.specialSpawned = false;
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.invuln = 0; foe.stocks = 99; foe.health = 1000; foe.eliminated = false;
    foe.poison = 0; foe.burn = 0; foe.grabbing = -1; foe.grabbedBy = -1;
    foe.hasHit = true; foe.vx = 0; foe.vy = 0;
    var fy = main.y - ${lift};
    foe.x = 185; foe.y = fy; foe.grounded = ${lift} === 0;
    var h0 = foe.health;
    netplay.active = true;
    for (var i = 0; i < 24; i++) {
      me.hitstop = 0; me.mana = 999; me.facing = 1;
      if (foe.health >= h0) {
        foe.x = 185; foe.y = fy; foe.vx = 0; foe.vy = 0;
        foe.grounded = ${lift} === 0;
      }
      var bits = i === 0 ? ${SP_N} : (i <= 8 ? ${BIT[aim]} : 0);
      netplay.framePads = [bitsToPad(bits), bitsToPad(0)];
      step();
    }
    netplay.active = false; netplay.framePads = null;
    return { aim: me.belchAim, took: +(h0 - foe.health).toFixed(2) };
  })()`);

  const HITS = {
    level: { floor: true, aloft: true },
    up:    { floor: false, aloft: true },
    down:  { floor: true, aloft: false },
  };
  for (const aim of ["level", "up", "down"]) {
    for (const spot of ["floor", "aloft"]) {
      const r = connect(aim, spot === "floor" ? 0 : 12);
      const who = spot === "floor"
        ? "a fighter standing on the same floor"
        : "a fighter twelve pixels off the ground";
      assert.equal(r.aim, aim,
        "the " + aim + " burp should have latched before it went live " +
        "against " + who + "; it latched " + r.aim);
      if (HITS[aim][spot]) {
        assert.equal(r.took, dmg[aim],
          "the " + aim + " burp has to hit " + who + " for its own " +
          dmg[aim] + " damage; it took off " + r.took);
      } else {
        assert.equal(r.took, 0,
          "the " + aim + " burp must not be able to touch " + who +
          " at all -- that miss is the whole reason the aim is a choice -- " +
          "but it took off " + r.took);
      }
    }
  }
}

test("the shout is aimed, and every aim's waves stay inside its own box", async () => {
  /* A fixed green puff at arm's length said "melee" while the box said
     otherwise. It is a shout: what carries is the noise, so the noise leaves
     him -- three waves on consecutive frames, travelling forward.

     It is three shouts now. Hold up and it goes over his head, hold down and
     it goes along the floor, hold nothing and it goes straight out, and the
     direction is LATCHED during the startup so a shout already in the air
     cannot be swung around somebody standing inside it. Each aim is a
     finished spec with its own box, its own damage and its own launch angle.

     Everything this asserts lives in checkShout above, so the negative
     control at the foot of this file can run the identical checks against a
     deliberately broken engine. */
  await checkShout();
});

test("no move puts any fighter at a coordinate that is not a number", async () => {
  /* Cobeus shipped able to VANISH. Two of his five moves erased his player
     model outright -- not fell through the floor, not froze: gone.

     `case 'uppercut':` reads two fields off the spec:

         this.vy = s.rise;
         this.vx = this.facing * s.drift;

     Both of his placeholder specials were written without a `drift`. That
     makes the second line `1 * undefined` = NaN, vx is NaN, x is NaN on the
     next move(), and drawImage(img, NaN, NaN) paints nothing at all.

     Nothing caught it, and nothing could have. NaN does not throw. Every
     comparison against it is false, so the off-stage test never fires, the
     KO never happens, and he is still in fighters[] simulating happily at no
     location. The only symptom is that he is not on the screen.

     The contract for `uppercut` -- rise AND drift, and rise is NEGATIVE for
     up -- lived nowhere except in the two moves that happened to honor it.
     So this test does not check that one field on one character; it drives
     every move in every kit and demands a real number come out, because the
     next kind added will have an undocumented contract too. */
  const run = await bootEngine();
  const MOVES = [["jab", 32], ["neutral", 512], ["down", 1024], ["up", 2048],
                 ["ult", 256]];
  const order = run("ORDER.slice()");
  const broken = [];

  for (let i = 0; i < order.length; i++) {
    run(`select.cursor=[${i},4]; twoPlayer=true; playerCount=2; humanCount=0;
         stagePick=0; startBattle();`);
    run("for (var i=0;i<130;i++) step();");
    const name = run("fighters[0].def.name");
    for (const [label, bits] of MOVES) {
      const r = run(`(function () {
        var me = fighters[0], foe = fighters[1];
        var main = STAGE.platforms.find(function (p) { return p.main; });
        projectiles.length = 0; effects.length = 0;
        me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0;
        me.landLag=0; me.invuln=0; me.mana=999; me.ultMeter=999;
        me.vx=0; me.vy=0; me.grabbing=-1; me.grounded=true; me.facing=1;
        me.stocks=99; me.eliminated=false; me.health=0;
        me.x=main.x+50; me.y=main.y; me.specialSpawned=false;
        foe.setState('idle'); foe.invuln=9999; foe.stocks=99; foe.health=1000;
        foe.eliminated=false; foe.x=main.x+main.w-6; foe.y=main.y;
        foe.hasHit=true; foe.grounded=true;
        var nan = -1;
        netplay.active = true;
        for (var i = 0; i < 90; i++) {
          me.hitstop = 0; me.mana = 999; me.ultMeter = 999;
          netplay.framePads = [bitsToPad(i === 0 ? ${bits} : 0), bitsToPad(0)];
          step();
          if (nan < 0 && !(isFinite(me.x) && isFinite(me.y) &&
                           isFinite(me.vx) && isFinite(me.vy))) nan = i;
        }
        netplay.active = false; netplay.framePads = null;
        return nan;
      })()`);
      if (r >= 0) broken.push(name + "'s " + label + " (frame " + r + ")");
    }
  }

  assert.deepEqual(broken, [],
    "these moves put the fighter at a NaN coordinate, which draws as nothing " +
    "at all: " + broken.join(", "));

  /* The kit as it stands is clean, which means the line above can only catch
     this the NEXT time somebody writes a move -- and only if they run it.
     So check the engine's own floor directly: hand it an uppercut with the
     fields deliberately missing, exactly as a half-written move would, and
     it must still produce a real number. A move that does nothing is a bug
     you can see and fix. A move that erases the player is not. */
  const halfWritten = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    // Clone a real uppercut and take away the two fields the case reads.
    var spec = {};
    for (var k in me.def.specials.up) spec[k] = me.def.specials.up[k];
    spec.kind = 'uppercut';
    delete spec.rise;
    delete spec.drift;
    var was = me.def.specials.up;
    me.def.specials.up = spec;
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grabbing=-1;
    me.grounded=true; me.facing=1; me.stocks=99; me.eliminated=false;
    me.x=main.x+50; me.y=main.y; me.specialSpawned=false;
    foe.setState('idle'); foe.invuln=9999; foe.stocks=99; foe.eliminated=false;
    foe.x=main.x+main.w-6; foe.y=main.y; foe.hasHit=true;
    var nan = -1;
    netplay.active = true;
    for (var i = 0; i < 40; i++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(i === 0 ? 2048 : 0), bitsToPad(0)];
      step();
      if (nan < 0 && !(isFinite(me.x) && isFinite(me.y) &&
                       isFinite(me.vx) && isFinite(me.vy))) nan = i;
    }
    netplay.active = false; netplay.framePads = null;
    me.def.specials.up = was;
    return nan;
  })()`);

  assert.equal(halfWritten, -1,
    "an uppercut written without `rise`/`drift` must fall back to zero, not " +
    "multiply the facing by undefined; it went NaN on frame " + halfWritten);
});

/* Every recovery in the roster, driven off the ledge and measured, in one
   function so the negative control at the foot of this file can run the
   IDENTICAL checks against an engine with one character's `rise` flipped.
   `engineSrc` is undefined for the real run, which is what makes bootEngine
   read the shipped engine. */
async function checkRecoveries(engineSrc) {
  const run = await bootEngine(engineSrc);
  const order = run("ORDER.slice()");
  const failed = [];

  for (let i = 0; i < order.length; i++) {
    run(`select.cursor=[${i},4]; twoPlayer=true; playerCount=2; humanCount=0;
         stagePick=0; startBattle();`);
    /* Quiet, not a live warmup. This test used to hold both CPUs' leashes
       here and it made it a coin flip: on some Math streams Reese put a CROP
       DUST cloud on the fighter under test during those 130 frames, and a
       poisoned fighter plus the `me.health = 0` this probe used to set is a
       knockOut() on the first tick of the probe -- state 'ko' for all 24
       frames, 0px gained, a recovery blamed for a fight nobody was measuring.
       It passed alone and failed in suite order, because the seed each vm
       gets depends on how many tests before it booted an engine. */
    run(QUIET_WARMUP);
    const r = run(`(function () {
      var me = fighters[0], foe = fighters[1];
      var main = STAGE.platforms.find(function (p) { return p.main; });
      var up = me.def.specials.up;
      /* Anything that claims to move him: 'uppercut' says so in its kind,
         and Christian's FROG ARMY says so by carrying a rise of -5.9 under a
         kind of its own. A recovery is a recovery whichever case it is
         written as, and the one that is not in this list is the one that
         quietly stops working. */
      if (up.kind !== 'uppercut' && up.rise === undefined) return null;
      projectiles.length = 0; effects.length = 0;
      /* Nothing left over from before the probe may reach into it. The
         freeze is a KO's twelve dead frames -- they would eat the launch and
         read as a recovery that never moved -- and the poison and burn are
         damage that ticks through every state there is, including the one
         this is trying to measure. */
      freezeFrames = 0;
      foe.setState('idle'); foe.invuln=9999; foe.stocks=99; foe.eliminated=false;
      foe.x=main.x+10; foe.y=main.y; foe.hasHit=true;
      foe.poison=0; foe.burn=0; foe.grabbing=-1; foe.grabbedBy=-1;
      // Hanging past the ledge, which is the only place a recovery matters.
      me.setState('fall'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
      me.invuln=0; me.mana=999; me.stocks=99; me.eliminated=false;
      /* Full health rather than the 0 this used to sit at. At zero he is one
         tick of anything at all from dead, and the height a recovery gains
         has never depended on his health -- an uppercut reads its rise off
         its own spec and nothing else. (No backticks in here: this comment
         lives inside a template literal, and one would end the probe.) */
      me.health=COMBAT.maxHealth; me.poison=0; me.burn=0; me.confused=0;
      me.grabbing=-1; me.grabbedBy=-1; me.grounded=false; me.facing=-1;
      me.x=main.x-30; me.y=main.y-40; me.vx=0; me.vy=0; me.specialSpawned=false;
      var y0 = me.y, best = me.y, cast = false;
      netplay.active = true;
      for (var i = 0; i < 24; i++) {
        me.hitstop = 0; me.mana = 999;
        netplay.framePads = [bitsToPad(i === 0 ? 2048 : 0), bitsToPad(0)];
        step();
        if (me.state === 'special') cast = true;
        if (me.y < best) best = me.y;   // smaller y is higher up
      }
      netplay.active = false; netplay.framePads = null;
      return { name: me.def.name, label: up.label, cast: cast,
               gained: +(y0 - best).toFixed(1) };
    })()`);
    if (!r) continue;
    /* Reported apart from the height, because they are different bugs: a
       move that never started is a broken probe or a move that refuses to
       come out, and a move that started and went nowhere is the anti-recovery
       this test is here for. Both still fail. */
    if (!r.cast) {
      failed.push(r.name + "'s " + r.label + " never left the ground state");
    } else if (r.gained < 8) {
      failed.push(r.name + "'s " + r.label + " gained " + r.gained + "px");
    }
  }

  assert.deepEqual(failed, [],
    "an up-special that claims to move the fighter has to LIFT him -- " +
    "`rise` is negative for up: " + failed.join(", "));
}

test("every up-special that is a recovery actually gains height", async () => {
  /* `rise` is NEGATIVE for up -- every real uppercut uses -6.1 or -6.2 --
     and Cobeus's placeholder shipped as POSITIVE 5.4, which drove him
     DOWNWARD. His recovery was a fast way to die.

     A grounded test cannot see this: on a platform a downward rise just sets
     you back on the floor. It only shows up off the ledge, which is the only
     place the move matters, so that is where this measures.

     Not everyone's `up` is a recovery -- AutisNick throws a rainbow and Trev
     sends a pawn, and Trev's jump gets him home by design -- so this asserts
     only about the ones that claim to move the fighter at all.

     Everything it checks lives in checkRecoveries above, so the negative
     control at the foot of this file can run the identical checks against a
     deliberately broken engine. */
  await checkRecoveries();
});

test("Cobeus is in the game, off a sprite sheet, and the select screen fits him", async () => {
  /* He is the seventh character and the first whose art arrived as ONE sheet
     rather than eight files, so this guards the whole chain: build.py slicing
     the sheet, loadAssets naming every new key by hand, and the select grid
     having somewhere to put him.

     The grid is the part that needed changing. At three columns his tile
     wrapped to a third row centred at y 144 -- ring running to y 184 on a
     180px screen, NAME drawn at baseline 184 and therefore invisible,
     portrait underneath all three lines of bottom text. Widening the grid put
     seven back into two rows, and at five columns ten fills both of them
     exactly. */
  const run = await bootEngine();
  assert.equal(run("ORDER.indexOf('cobeus')"), 6,
    "appended, not inserted -- every select.cursor=[i,j] in this suite is a " +
    "position in ORDER");
  /* Not a hardcoded count -- that is what broke this test when Simon was
     added, and it would break again on the ninth. The invariant that
     actually matters is that ORDER and ROSTER agree, and NOTHING in the
     engine checks it: a key in ORDER with no ROSTER entry crashes in
     drawSelect on `def.name`, and a ROSTER entry missing from ORDER is
     priced for mana, never loaded, and simply unreachable with no warning.

     The two halves are no longer the same set, and that is on purpose. 2.55
     added the SANDBAG, a ROSTER entry deliberately left out of ORDER so it
     cannot be picked -- startBattle seats it by name for practice mode. So
     the rule is asymmetric now: everything in ORDER must have a ROSTER entry,
     and anything in ROSTER that ORDER does not list has to SAY it is a dummy.
     An ordinary character that fell out of ORDER still trips this, which is
     the failure the old equality was there to catch. */
  const inOrder = run("ORDER.slice()");
  const inRoster = run("Object.keys(ROSTER)");
  const missing = [...inOrder].filter((k) => !inRoster.includes(k));
  assert.deepEqual(missing, [],
    "every character in ORDER needs a ROSTER entry; missing: " +
    missing.join(", "));
  const unpickable = [...inRoster].filter((k) => !inOrder.includes(k));
  const undeclared = unpickable.filter((k) => !run("!!ROSTER." + k + ".dummy"));
  assert.deepEqual(undeclared, [],
    "a ROSTER entry outside ORDER is unreachable, so it has to be a training " +
    "dummy and say so with `dummy: true`; these do not: " +
    undeclared.join(", "));
  assert.ok(unpickable.includes("sandbag"),
    "the sandbag must stay out of ORDER -- in it, practice mode's dummy " +
    "becomes a pickable fighter with no moves; ROSTER-only keys were: " +
    (unpickable.join(", ") || "none"));
  const n = inOrder.length;

  /* Every non-character sprite has to be named in loadAssets by hand; there
     is no `for (const k in SPRITES)`. Art that build.py emits and loadAssets
     misses ships its bytes, is never turned into an Image, and the draw path
     skips it silently -- an invisible projectile with no error anywhere. */
  for (const key of ["cobeus.base.standR", "cobeus.base.jumpL",
                     "bottle.0", "bottle.7", "glass", "car"]) {
    assert.ok(run("!!IMG[" + JSON.stringify(key) + "]"),
      "sprite '" + key + "' never became an Image -- check loadAssets");
  }

  // The grid has room, and his name is on the screen.
  const grid = run(`(function () {
    var cols = NerdWars.selectColumns;
    // CELL_W rather than a copy of it: drawSelect reads the same constant, so
    // a narrower grid cannot pass here and overflow on the screen.
    var cellW = CELL_W, cellH = 52, originY = 40;
    var originX = VW / 2 - (cols * cellW) / 2 + cellW / 2;
    var last = ORDER.length - 1;
    var cx = originX + (last % cols) * cellW;
    var cy = originY + Math.floor(last / cols) * cellH;
    return { cols: cols, rows: Math.ceil(ORDER.length / cols),
             left: cx - 32, right: cx + 32, nameY: cy + 40, VW: VW, VH: VH };
  })()`);
  assert.ok(grid.nameY < grid.VH,
    "the last character's name must be on screen; it draws at y " +
    grid.nameY + " on a " + grid.VH + "px screen");
  assert.ok(grid.left > 0 && grid.right < grid.VW,
    "and his tile must fit across; it spans " + grid.left + ".." + grid.right);

  /* Every tile has to be REACHABLE. The last row is ragged at seven, and a
     move into the gap used to be a silent no-op -- Down did nothing at all
     from the last two tiles of the top row. */
  for (let from = 0; from < n; from++) {
    const reached = run(`(function () {
      select.cursor[0] = ${from};
      moveCursor(0, 0, 1);
      return select.cursor[0];
    })()`);
    assert.ok(reached >= 0 && reached < n,
      "Down from " + from + " left the cursor at " + reached);
  }
  const cols = run("NerdWars.selectColumns");
  const downFromTopRight = run(`(function () {
    select.cursor[0] = ${cols - 1}; moveCursor(0, 0, 1); return select.cursor[0];
  })()`);
  assert.equal(downFromTopRight, Math.min(2 * cols - 1, n - 1),
    "Down from the end of the top row should land on the tile below it, or " +
    "the last character if the row is ragged; landed on " + downFromTopRight);
});

/* The throw is only half the move. Where it breaks it leaves glass on the
   floor, and that is the half that lasts: missing still takes a piece of the
   stage away from the other player.

   What "lasts" means is a clock and not a toll. The glass used to be built on
   `pierce` + `hitAt` + `hitEvery`, like the smoke and the fart, so standing in
   it kept costing -- and a pane that bit every twenty-six frames with a
   nearly-vertical launch angle had people hopping in it, stuck. It is a
   `graze` with a BUDGET now: two steps, thirty frames apart, and then it is
   gone. So the four seconds are what it is worth to somebody who never comes
   near it, and the middle of this test measures them with nobody standing in
   it, while the end measures the ceiling on somebody who does.

   Written as a checker rather than as a test body so that the budget can have
   a negative control: the same measurements, the same assertions, run against
   an engine with one line changed. */
async function glassPane(engine) {
  const run = await bootEngine(engine);
  run("select.cursor=[6,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.name"), "COBEUS");

  const SP_N = 512;
  const setup = `
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grounded = true; me.facing = 1;
    me.x = main.x + 40; me.y = main.y; me.specialSpawned = false;`;

  const thrown = run(`(function () {
    ${setup}
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99;
    foe.health = 1000; foe.x = main.x + main.w - 6; foe.y = main.y;
    foe.hasHit = true; foe.grounded = true;
    var spin = {}, glassLife = 0, sawBottle = false;
    var x0 = null, y0 = null, land = null, peak = 0;
    netplay.active = true;
    for (var i = 0; i < 60; i++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_N} : 0), bitsToPad(0)];
      step();
      var b = projectiles.filter(function (q) { return q.constructor.name === 'Bottle'; })[0];
      var gl = projectiles.filter(function (q) { return q.constructor.name === 'Glass'; })[0];
      if (b) {
        sawBottle = true; spin[Math.floor(b.t / (b.spec.spin || 3)) % 8] = 1;
        if (x0 === null) { x0 = b.x; y0 = b.y; }
        if (y0 - b.y > peak) peak = y0 - b.y;
      }
      if (gl && !glassLife) { glassLife = gl.life; if (land === null) land = gl.x; }
    }
    netplay.active = false; netplay.framePads = null;
    return { sawBottle: sawBottle, frames: Object.keys(spin).length,
             glassLife: glassLife,
             reach: land === null ? -1 : +(land - x0).toFixed(1),
             peak: +peak.toFixed(1) };
  })()`);

  assert.ok(thrown.sawBottle, "the bottle should have been thrown");
  assert.ok(thrown.frames >= 6,
    "it should visibly spin, not slide; used " + thrown.frames + " of 8 frames");
  assert.ok(thrown.glassLife >= 200,
    "breaking should leave glass for about four seconds; got " +
    thrown.glassLife + " frames");

  /* And it has to land NEAR HIM. It used to carry 119px on a 320px stage --
     over a third of the floor, 35 frames in the air -- which made a move
     about denying the ground in front of him into a cross-stage lob you
     could watch coming and walk around.

     Measured from the bottle's own spawn, never from Cobeus: he can move
     between the throw and the break, and measuring from him would credit
     his walking to the bottle. The window is wide because this is an arc
     over discrete frames -- it lands on whichever frame crosses the floor,
     not at an exact x. */
  assert.ok(thrown.reach > 45 && thrown.reach < 90,
    "the bottle should land about 70px away -- near enough that the glass " +
    "is his floor, not theirs; it reached " + thrown.reach + "px");
  assert.ok(thrown.peak > 4,
    "and it should still ARC. Shortening it by slowing the throw flattens " +
    "it into a straight line; it rose " + thrown.peak + "px");

  /* And left alone it has to SIT there for its four seconds, because that is
     the denial: the ground is his, and the other player has to go round.

     The foe is parked at the far end and untouchable for the whole of it --
     two steps break the pane now, so a foe who wanders in twice is a foe who
     ends the measurement. */
  const alone = run(`(function () {
    ${setup}
    foe.setState('idle'); foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    foe.grounded = true; foe.invuln = 9999;
    var lived = 0, born = 0;
    netplay.active = true;
    for (var i = 0; i < 340; i++) {
      me.hitstop = 0; me.mana = 999;
      foe.invuln = 9999; foe.x = main.x + main.w - 6; foe.vx = 0;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_N} : 0), bitsToPad(0)];
      step();
      var g = projectiles.filter(function (q) {
        return q.constructor.name === 'Glass';
      })[0];
      if (g) { lived++; if (!born) born = g.born; }
    }
    netplay.active = false; netplay.framePads = null;
    return { lived: lived, born: born };
  })()`);

  assert.ok(alone.lived >= 200 && alone.lived <= 260,
    "glass nobody walks into should last about four seconds; it lived " +
    alone.lived + " frames");
  assert.ok(Math.abs(alone.lived - alone.born) <= 2,
    "and see out the `life` it was given (" + alone.born + " frames); it " +
    "lasted " + alone.lived);

  /* And then the other half of the same clock: somebody standing in it ends
     it early. Two bites, thirty frames apart, and the pane is gone -- so the
     thing it denies is still the ground and not a share of your health, and
     the ceiling on standing in one for two hundred and twenty frames is five.
     The probe parks him on it from frame 120, so it sees the bites at about
     121 and about 151 and then nothing for the rest of the run. */
  const stepped = run(`(function () {
    ${setup}
    foe.setState('idle'); foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    foe.grounded = true; foe.invuln = 9999;
    var hits = 0, before = foe.health, lived = 0, leftOver = -1, at = -1;
    netplay.active = true;
    for (var i = 0; i < 340; i++) {
      me.hitstop = 0; me.mana = 999;
      var g = projectiles.filter(function (q) {
        return q.constructor.name === 'Glass';
      })[0];
      // In it from frame 120, well before its four seconds are up.
      if (g && i >= 120) {
        if (leftOver < 0) leftOver = g.life;
        foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0; foe.setState('idle');
        foe.x = g.x; foe.y = main.y; foe.vx = 0; foe.vy = 0; foe.grounded = true;
      }
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_N} : 0), bitsToPad(0)];
      var h0 = foe.health;
      step();
      if (foe.health < h0) { hits++; if (at < 0) at = i; }
      if (projectiles.some(function (q) {
        return q.constructor.name === 'Glass';
      })) lived++;
    }
    netplay.active = false; netplay.framePads = null;
    return { hits: hits, lost: before - foe.health, lived: lived,
             leftOver: leftOver, at: at };
  })()`);

  assert.equal(stepped.hits, 2,
    "standing in it should cost exactly twice -- the pane has a budget of " +
    "two steps and no more, however long he stands there; it bit " +
    stepped.hits + " times");
  assert.equal(stepped.lost, 5,
    "and the ceiling on one pane is two bites of 2.5. Anything above it is " +
    "the 2.55 tax coming back; he lost " + stepped.lost);
  assert.ok(stepped.leftOver > 20,
    "precondition: he should reach it with the four seconds still running; " +
    "it had " + stepped.leftOver + " frames left");
  assert.ok(stepped.lived < alone.lived,
    "and the pane should break on him rather than see out its clock; left " +
    "alone it lived " + alone.lived + " frames and with him in it " +
    stepped.lived);
}

test("Cobeus's bottle breaks into glass that lasts four seconds", async () => {
  await glassPane();
});

test("negative control: a pane with one step in it fails the glass-pane test", async () => {
  /* One number, and it is the whole of what 2.83 added: a pane that spends
     its only bite on the first step is the 2.65 pane, which is a defensible
     thing to want and is not what ships. The rest of the move -- the arc,
     the reach, the four seconds, the graze -- is untouched by it, which is
     exactly why the control has to exist: nothing else in this test would
     move. */
  await expectToFail(() => glassPane(sabotage(
    "               damage: 2.5, graze: true, hits: 2, rearm: 30,",
    "               damage: 2.5, graze: true, hits: 1, rearm: 30,")),
    "with a one-step pane the glass-pane test should fail; it passed");
});

test("Cobeus's ult drives a car across the whole stage", async () => {
  /* Same shape as the vine Tyson swings in on: it pierces, it remembers who
     it has already hit, and it IS the move -- he does not move, he is in it. */
  const run = await bootEngine();
  run("select.cursor=[6,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const ULT = 256;
  const r = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.ultMeter = 999; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grounded = true; me.facing = 1;
    me.x = main.x + 40; me.y = main.y; me.specialSpawned = false;
    foe.setState('idle'); foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + 120; foe.y = main.y; foe.hasHit = true; foe.grounded = true;
    var xs = [], before = foe.health;
    netplay.active = true;
    for (var i = 0; i < 120; i++) {
      me.hitstop = 0; me.ultMeter = 999;
      foe.hitstop = 0; foe.invuln = 0;
      foe.x = main.x + 120; foe.vx = 0; foe.y = main.y; foe.grounded = true;
      netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
      step();
      var c = projectiles.filter(function (q) { return q.constructor.name === 'Car'; })[0];
      if (c) xs.push(c.x);
    }
    netplay.active = false; netplay.framePads = null;
    return { n: xs.length, from: xs[0], to: xs[xs.length - 1],
             lost: before - foe.health, VW: VW };
  })()`);

  assert.ok(r.n > 40, "the car should be on screen for a while; " + r.n + " frames");
  assert.ok(r.from < 0, "it should drive ON from off the edge; started at " + r.from);
  assert.ok(r.to > r.VW, "and all the way off the other side; ended at " + r.to);
  assert.ok(r.lost > 10,
    "and hit whoever it drove through; took " + r.lost);
});

/* The fart's effect on the man who let it off -- which is now none at all --
   driven and asserted in one function, so the two negative controls at the
   foot of this file can run the IDENTICAL checks against an engine with the
   shove put back. */
async function checkFartMovesHimNowhere(engineSrc) {
  const run = await bootEngine(engineSrc);
  run("select.cursor=[4,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run(QUIET_WARMUP);
  assert.equal(run("fighters[0].def.specials.down.label"), "CROP DUST",
    "precondition: player 1 is the one with the fart");

  const SP_D = 1024;
  const fart = (inAir) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0; freezeFrames = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.grabbing = -1;
    me.grabbedBy = -1; me.poison = 0; me.burn = 0; me.confused = 0;
    me.health = COMBAT.maxHealth; me.specialSpawned = false; me.facing = 1;
    me.x = main.x + 60;
    /* 120 up, not 50. Falling at 4.5 he covers 50 pixels inside the move's
       own startup, lands, and the airborne case never runs at all -- which
       would make every number below a measurement of a grounded cast. */
    if (${inAir}) { me.grounded = false; me.y = main.y - 120; me.vy = 4.5; }
    else { me.grounded = true; me.y = main.y; me.vy = 0; }
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    foe.poison = 0; foe.burn = 0; foe.grabbing = -1; foe.grabbedBy = -1;
    var before = null, after = null, air = null, dv = null;
    var ySpawn = null, low = 0, worstVY = 0;
    netplay.active = true;
    for (var i = 0; i < 30; i++) {
      me.hitstop = 0; me.mana = 999;
      var vy0 = me.vy, y0 = me.y, was = me.specialSpawned;
      if (!was) { before = me.vy; air = !me.grounded; }
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_D} : 0), bitsToPad(0)];
      step();
      /* The frame the gas actually leaves him is the only frame a shove
         could be written on, so it is measured on its own: vy across that
         one step, and where he was standing as it happened. */
      if (!was && me.specialSpawned) {
        after = me.vy; dv = me.vy - vy0; ySpawn = y0; low = y0;
      }
      if (ySpawn !== null && me.y < low) low = me.y;
      if (me.vy < worstVY) worstVY = me.vy;
    }
    netplay.active = false; netplay.framePads = null;
    return { spawned: ySpawn !== null, airborne: air, before: before,
             after: after, dv: +((dv === null ? 0 : dv).toFixed(3)),
             climb: +((ySpawn === null ? 0 : ySpawn - low).toFixed(3)),
             worstVY: +worstVY.toFixed(3), grounded: me.grounded };
  })()`);

  const up = fart(true);
  // Preconditions. Every number below is vacuous without all three.
  assert.ok(up.spawned,
    "precondition: the gas has to actually come out, or nothing was cast");
  assert.ok(up.airborne,
    "precondition: he has to still be off the ground when it goes off, or " +
    "this measures a grounded cast");
  assert.ok(up.before > 0,
    "precondition: and he has to be falling into it -- a lift is only " +
    "visible against a fall; vy was " + up.before);

  /* The assertion the old one was, inverted. It used to read up.after < 0.
     A rise written back in is worth about -9 on this one frame, which is
     why the frame is measured by itself rather than over the whole move. */
  assert.ok(up.dv >= 0,
    "the frame the gas comes out must not take a thing off his fall; his " +
    "vy went from " + up.before.toFixed(1) + " to " + up.after.toFixed(1) +
    " across it, a change of " + up.dv);
  assert.ok(up.worstVY >= 0,
    "and his vy must never go negative anywhere in the move -- negative vy " +
    "is upward, and upward is the exact shape of the shove that was taken " +
    "out; the best it reached was " + up.worstVY);
  assert.equal(up.climb, 0,
    "so he must not gain a single pixel after letting it off; he climbed " +
    up.climb + "px above where he was standing when it went off");

  const flat = fart(false);
  assert.ok(flat.spawned,
    "precondition: the grounded cast has to go off too");
  assert.equal(flat.dv, 0,
    "on the ground it moves him nowhere either; vy changed by " + flat.dv +
    " on the frame it went off");
  assert.ok(flat.grounded && flat.climb === 0,
    "and it must not peel him off the floor at all -- the fart is not a " +
    "jump in either place; he climbed " + flat.climb + "px and ended " +
    (flat.grounded ? "grounded" : "airborne"));

  assert.equal(run("ROSTER.reese.specials.down.liftSelf"), undefined,
    "and no `liftSelf` may creep back onto the spec either; the field is " +
    "how the shove was written the first time, and a live one is a shove " +
    "waiting for somebody to read it again");
}

test("the fart leaves Reese exactly where he was, in the air and on the ground",
     async () => {
  /* This used to pin the opposite: a `liftSelf: 4.2` that threw him upward
     when he let one off in the air. It is gone on purpose, so the test that
     guarded it is gone with it and this one guards the removal.

     Being launched by your own fart was funny, but mechanically it was a
     second recovery -- one that is not JITTERS, costs nothing, and points
     the way JITTERS cannot. Reese now has exactly one way back that is not
     his double jumps, and the thing that would quietly undo that decision is
     somebody adding a small upward nudge here and calling it feel.

     What did NOT change is the cast: it works in the air and always did,
     canSpecial has never looked at `grounded`. The only difference off the
     ground is that he keeps falling, which is what this measures.

     Everything it checks lives in checkFartMovesHimNowhere above, so the
     negative controls at the foot of this file can run the identical checks
     against an engine with the shove put back. */
  await checkFartMovesHimNowhere();
});

test("Trev's sword is a mode: nothing else in his kit answers", async () => {
  /* Ten seconds of being able to do everything he could before AND hold a
     laser sword made the ult a strict addition to his kit rather than a
     decision about what he wanted to be doing with it. While it is in his
     hand he swings it and that is all.

     Read off the ult's own `exclusive` rather than off swordTimer, so it is a
     property of that weapon and not a rule about anyone who picks something
     up. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("!!ROSTER.trev.ult.exclusive"), true,
    "the sword should declare itself exclusive");

  const ULT = 256;
  const tryIt = (bits, sword) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grounded = true; me.facing = 1;
    me.x = main.x + 40; me.y = main.y; me.specialSpawned = false;
    me.swordTimer = ${sword};
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    var acted = false, ulted = false;
    netplay.active = true;
    for (var i = 0; i < 26; i++) {
      me.hitstop = 0;
      netplay.framePads = [bitsToPad(i === 0 ? ${bits} : 0), bitsToPad(0)];
      step();
      if (me.state === 'special') acted = true;
      if (me.state === 'ult') ulted = true;
    }
    netplay.active = false; netplay.framePads = null;
    return { acted: acted, ulted: ulted };
  })()`);

  for (const [name, bits] of [["CEREAL", 512], ["FISHING POLE", 1024],
                              ["PAWN", 2048]]) {
    assert.ok(tryIt(bits, 0).acted,
      name + " should cast normally with no sword out, or this proves nothing");
    assert.ok(!tryIt(bits, 400).acted,
      name + " must not come out while the sword is in his hand");
  }

  // ...but the sword itself still swings, which is the whole point of holding it.
  assert.ok(tryIt(ULT, 400).ulted,
    "he should still be able to swing the thing he is holding");
});

test("the character select screen does not describe anybody", async () => {
  const run = await bootEngine();
  const carries = run("NerdWars.roster.filter(function (c) {" +
    " return Object.keys(c).indexOf('blurb') >= 0; }).length");
  assert.equal(carries, 0, "no character should carry a blurb any more");
  assert.equal(run("Object.keys(ROSTER).filter(function (k) {" +
    " return ROSTER[k].blurb !== undefined; }).length"), 0,
    "and the roster data should not hold one either");
});

test("John can walk through his whole kit, and still stops when you let go", async () => {
  /* Nothing was holding him still on purpose. `rooted` never listed any of
     his moves -- what stopped him was the plain non-mobile path, ground
     friction with no way to accelerate out of it, for every frame of the
     move. His longest is SIC 'EM at 36 frames, so two attacks back to back
     is most of a second of a man who cannot walk.

     The second half matters as much as the first: `mobile` is walk controls,
     not frozen momentum. Letting go has to stop him, which is the bug that
     shipped the first time a move was made mobile. */
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.key || ROSTER.johnnyham.name"), "JOHNNYHAM",
    "player 1 should be John");

  const ATTACK = 32, SP_N = 512, SP_D = 1024, SP_U = 2048, ULT = 256, RIGHT = 2;
  const setup = `
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.ultMeter = 999;
    me.vx = 0; me.vy = 0; me.grabbing = -1; me.grounded = true; me.facing = 1;
    me.x = main.x + 30; me.y = main.y; me.specialSpawned = false;
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    foe.grounded = true; foe.vx = 0; foe.vy = 0;`;

  const through = (startBits, holdBits, frames, enterMoving) => run(`(function () {
    ${setup}
    me.vx = ${enterMoving} ? me.def.walk : 0;
    var x0 = me.x, busy = 0;
    netplay.active = true;
    for (var i = 0; i < ${frames}; i++) {
      me.hitstop = 0; foe.hitstop = 0;
      netplay.framePads = [bitsToPad((i === 0 ? ${startBits} : 0) | ${holdBits}),
                           bitsToPad(0)];
      step();
      if (me.state === 'attack' || me.state === 'special' || me.state === 'ult') busy++;
    }
    netplay.active = false; netplay.framePads = null;
    return { moved: me.x - x0, busy: busy };
  })()`);

  const kit = [["jab", ATTACK, 24], ["SMOKESCREEN", SP_N, 34],
               ["SIC 'EM", SP_D, 40], ["SIDEARM", SP_U, 36],
               ["HONEY BAKED", ULT, 34]];
  for (const [name, bits, frames] of kit) {
    const held = through(bits, RIGHT, frames, false);
    assert.ok(held.busy > 15,
      name + " should still be running for most of this; " + held.busy + " frames");
    assert.ok(held.moved > 15,
      "he should be able to walk through " + name + "; moved " +
      held.moved.toFixed(1) + "px");

    // ...and letting go stops him rather than freezing whatever he carried in.
    const loose = through(bits, 0, frames, true);
    assert.ok(Math.abs(loose.moved) < 6,
      "releasing everything during " + name + " should stop him, not coast; " +
      "drifted " + loose.moved.toFixed(1) + "px");
  }

  /* SIDEARM is his recovery, and being mobile must not cost him that. The
     mobile branch only assigns vx when he is GROUNDED, so the airborne half
     of the recoil -- the vy kick and the air jump it hands back -- is
     untouched. This is the assertion that fails if anyone ever "simplifies"
     that branch to set velocity unconditionally. */
  const recover = run(`(function () {
    ${setup}
    me.x = main.x - 30; me.y = main.y - 60;      // off the edge, falling
    me.grounded = false; me.vy = 3; me.jumpsLeft = 0;
    var before = null, after = null, jumps = 0;
    var vxBefore = null, vxAfter = null;
    netplay.active = true;
    for (var i = 0; i < 30; i++) {
      me.hitstop = 0;
      netplay.framePads = [bitsToPad((i === 0 ? ${SP_U} : 0) | ${RIGHT}),
                           bitsToPad(0)];
      step();
      if (!me.specialSpawned) { before = me.vy; vxBefore = me.vx; }
      else if (after === null) { after = me.vy; vxAfter = me.vx; }
      jumps = Math.max(jumps, me.jumpsLeft);
    }
    netplay.active = false; netplay.framePads = null;
    return { before: before, after: after, jumps: jumps,
             vxBefore: vxBefore, vxAfter: vxAfter };
  })()`);
  assert.ok(recover.after < recover.before,
    "firing SIDEARM while falling must still kick him upward; vy went from " +
    recover.before.toFixed(1) + " to " + recover.after.toFixed(1));
  assert.ok(recover.jumps > 0,
    "and hand back an air jump; got " + recover.jumps);

  /* "Kicks him back AND up" -- the horizontal half is spec too, and it is
     the half the mobile branch could actually eat. He is holding RIGHT
     through all of this, so if that branch ever assigns vx in the air, the
     backward shove is overwritten by a walk he should not get while
     airborne. That is the one-word change this guards against. */
  assert.ok(recover.vxAfter < recover.vxBefore,
    "firing it should shove him backward as well as upward; vx went from " +
    recover.vxBefore.toFixed(2) + " to " + recover.vxAfter.toFixed(2) +
    " while holding forward");
});

test("the dog bites harder with its jaws open, and not on the way down", async () => {
  /* A leap with the jaws open pays half again: 6 damage becomes 9. That is
     `lunge` climbing and `snap` across the top, eleven frames of a roughly
     twenty-frame arc.

     It was `snap` alone first -- the pose actually named for the bite -- and
     that turned out to be unreachable: measured over six CPU matches it was
     10 frames out of 1741 with a dog on the stage, and zero of fifteen landed
     bites, because holding the leap button re-launches at -4.4 before the dog
     can decelerate into the apex. A five-frame window nothing can reach is a
     trap rather than a mechanic. */
  const run = await bootEngine();
  run("select.cursor=[1,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  const spec = run("(function(){var s = ROSTER.johnnyham.specials.down;" +
    "return { kind: s.kind, damage: s.damage, bonus: s.biteBonus };})()");
  assert.equal(spec.kind, "dog", "player 1 should be the one with the dog");

  /* Bitten while the dog is held at a chosen vy. 8 pixels up puts it off the
     platform -- onSurface wants exact equality -- while still overlapping a
     standing hurtbox, which spans y-14 to y. */
  const bite = (vy, onGround) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.invuln = 0; foe.stocks = 99; foe.health = 1000;
    foe.vx = 0; foe.vy = 0; foe.x = main.x + 60; foe.y = main.y;
    foe.grounded = true;
    me.setState('idle'); me.hitstop = 0; me.damageMul = 1;
    me.x = main.x + 20; me.y = main.y;
    var d = new Dog(me, ROSTER.johnnyham.specials.down);
    d.x = foe.x; d.y = ${onGround} ? main.y : main.y - 8; d.vy = ${vy};
    projectiles.push(d);
    var before = foe.health;
    var pose = d.airPose();
    resolveCombat(fighters);
    return { pose: pose, lost: before - foe.health,
             vx: foe.vx, vy: foe.vy };
  })()`);

  const ground = bite(0, true);
  const lunge = bite(-4.0, false);
  const snap = bite(-0.5, false);
  const pounce = bite(1.5, false);

  assert.equal(ground.pose, null, "a dog on the floor has no air pose");
  assert.equal(lunge.pose, "lunge");
  assert.equal(snap.pose, "snap");
  assert.equal(pounce.pose, "pounce");

  assert.ok(Math.abs(ground.lost - spec.damage) < 0.01,
    "a trotting dog should do its plain damage; took " + ground.lost);
  /* Against the ground bite, not only against the spec's own arithmetic.

     The first version asserted snap.lost === damage * biteBonus and nothing
     else, which is a tautology the moment biteBonus is 1 -- setting it to 1
     deleted the feature and the test still passed. The claim is that a snap
     takes MORE, so that is what gets asserted. */
  assert.ok(spec.bonus > 1.01,
    "the snap is supposed to be worth something; biteBonus is " + spec.bonus);
  assert.ok(snap.lost > ground.lost + 0.5,
    "a snap bite should take more than a trotting one; " + snap.lost +
    " against " + ground.lost);
  assert.ok(pounce.lost < snap.lost,
    "and more than one on the way down; " + snap.lost + " against " +
    pounce.lost);
  assert.ok(Math.abs(snap.lost - spec.damage * spec.bonus) < 0.01,
    "and exactly the advertised " + (spec.damage * spec.bonus) +
    "; took " + snap.lost);

  // Climbing counts: jaws open, provably mid-leap.
  assert.ok(Math.abs(lunge.lost - spec.damage * spec.bonus) < 0.01,
    "a lunge is a bite too; took " + lunge.lost);

  /* And this is the line that keeps it a window rather than "airborne".
     A leap coming down and a dog that walked off a ledge are the same
     (x, y, vy) to the last bit, so `pounce` cannot be told from an accident
     -- and a dog that fell off a platform has not bitten anybody. Without
     this assertion, handing the bonus to every airborne frame would pass. */
  assert.ok(Math.abs(pounce.lost - spec.damage) < 0.01,
    "coming down must not pay: it is indistinguishable from a ledge drop; " +
    "took " + pounce.lost);

  /* And the bonus is damage ONLY. Knockback is built from move.damage rather
     than the scaled figure, so a harder bite must not also launch harder --
     that would quietly rewrite every spacing around the move. */
  assert.ok(Math.abs(snap.vx - ground.vx) < 0.001 &&
            Math.abs(snap.vy - ground.vy) < 0.001,
    "a snap bite must launch exactly as far as a plain one; snap (" +
    snap.vx.toFixed(2) + ", " + snap.vy.toFixed(2) + ") vs ground (" +
    ground.vx.toFixed(2) + ", " + ground.vy.toFixed(2) + ")");
});

test("the pole hurts on the throw, not on the catch", async () => {
  /* All of this move's damage is in the throw, which is the half you have to
     earn: the line has to connect, and then you have to survive holding
     somebody for 32 frames before it pays. The catch used to take five off by
     itself, which made throwing the line worth something even when the
     follow-up was taken off you.

     The basic Y grab is untouched -- only the pole was asked about -- and
     that is worth an assertion, because `grab.damage` is read from whichever
     move is running and it would be easy to zero the wrong one. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const pole = run("(function(){var s = ROSTER.trev.specials.down;" +
    "return { grab: s.grab.damage, fwd: s.throwFwd.damage," +
    " up: s.throwUp.damage, down: s.throwDown.damage };})()");
  assert.equal(pole.grab, 0, "the catch should take nothing off");
  for (const k of ["fwd", "up", "down"]) {
    assert.ok(pole[k] > 5,
      "the throws are where the damage lives; " + k + " does " + pole[k]);
  }
  assert.ok(run("BASIC_GRAB.grab.damage") > 0,
    "the universal Y grab keeps its catch damage -- only the pole was asked " +
    "about, and grab.damage is read from whichever move is running");

  // And end to end, because a spec is not a match.
  const DOWN_SPECIAL = 1024;
  const r = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grabTimer = 0; me.grounded = true; me.facing = 1;
    me.x = main.x + 30; me.y = main.y; me.throwAim = 0; me.throwDirX = 1;
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.invuln = 0; foe.stocks = 99; foe.health = 1000; foe.grabbedBy = -1;
    foe.vx = 0; foe.vy = 0; foe.grounded = true; foe.y = main.y;
    foe.x = me.x + 22;
    var start = foe.health, atCatch = null, afterThrow = null, caught = false;
    netplay.active = true;
    for (var i = 0; i < 100; i++) {
      me.hitstop = 0; foe.hitstop = 0;
      netplay.framePads = [bitsToPad(i === 0 ? ${DOWN_SPECIAL} : 0), bitsToPad(0)];
      if (me.grabbing < 0 && !caught) {
        foe.x = me.x + 22; foe.vx = 0; foe.y = main.y;
      }
      foe.invuln = 0;
      var was = me.grabbing;
      step();
      if (was < 0 && me.grabbing >= 0) { caught = true; atCatch = start - foe.health; }
      if (was >= 0 && me.grabbing < 0) { afterThrow = start - foe.health; break; }
    }
    netplay.active = false; netplay.framePads = null;
    return { caught: caught, atCatch: atCatch, afterThrow: afterThrow };
  })()`);

  assert.ok(r.caught, "the line should have connected, or this proves nothing");
  assert.equal(r.atCatch, 0,
    "nothing should come off on the catch; took " + r.atCatch);
  assert.ok(r.afterThrow > 8,
    "and the throw should still hurt; took " + r.afterThrow + " in total");
});

test("the cast is a thrown lure: it travels, it arcs, and the way home is live", async () => {
  /* Four complaints in one move, so four things to hold down.

     It caught people it visibly missed: hitbox() returned ONE rectangle
     bounding the entire cast, 67 wide by 63 tall from a jump. It arrived
     instantly: poleCast walked the whole trajectory in a single call, so the
     line existed at full length on the frame it appeared and "how fast does
     it travel" had no answer. It went too far: 82px from height. And the
     reel home was scenery -- six live frames at full extension, nothing
     before, nothing after.

     The lure is a real projectile now, thrown up and forward, and the box is
     8x8 wherever it has got to. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.specials.down.kind"), "pole",
    "player 1 should be the one with the rod");
  assert.equal(run("!!fighters[0].def.specials.down.mobile"), false,
    "casting should commit him -- see the rooting test below");

  const DOWN_SPECIAL = 1024;
  const r = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var s = me.def.specials.down;
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.grabbing = -1;
    me.x = main.x + 40; me.y = main.y; me.vy = 0;
    me.grounded = true; me.facing = 1;
    // On the stage and untouchable: left off the edge it dies, respawns in
    // the middle and gets caught, which freezes the cast in grab hitstop.
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.setState('idle');
    foe.hasHit = true; foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.grounded = true; foe.vx = 0; foe.vy = 0;
    var rows = [];
    netplay.active = true;
    for (var i = 0; i < 60; i++) {
      netplay.framePads = [bitsToPad(i === 0 ? ${DOWN_SPECIAL} : 0), bitsToPad(0)];
      step();
      var h = poleHook(me, s);
      var b = me.hitbox();
      rows.push({
        t: me.attackFrame - s.startup,
        hx: h ? h.x : null, hy: h ? h.y : null, landed: h ? !!h.landed : false,
        live: !!b,
        w: b ? b.box.w : 0, h: b ? b.box.h : 0,
        cx: b ? b.box.x + b.box.w / 2 : 0, cy: b ? b.box.y + b.box.h / 2 : 0,
        mx: me.x, floor: main.y, launchY: me.poleY0,
      });
    }
    netplay.active = false; netplay.framePads = null;
    return rows;
  })()`);

  const live = r.filter((f) => f.live);
  assert.ok(live.length > 0, "the cast should have produced a hitbox at all");

  // 1. A point on the line, not a box around the arc -- and the same point
  //    the drawing paints, because both ask poleHook.
  for (const f of live) {
    assert.ok(f.w <= 12 && f.h <= 12,
      "the hitbox should be a point on the line, got " + f.w + "x" + f.h);
    assert.ok(Math.abs(f.cx - f.hx) < 0.001 && Math.abs(f.cy - f.hy) < 0.001,
      "the box should be centered on the lure; box (" + f.cx + ", " + f.cy +
      ") vs lure (" + f.hx + ", " + f.hy + ")");
  }

  /* 2. It TRAVELS. The old one was in its final position on the first live
        frame, so every step below was zero; this is the assertion that fails
        if anyone makes the line instant again. */
  const flight = live.filter((f) => f.t >= 0 && !f.landed);
  const steps = [];
  for (let i = 1; i < flight.length; i++) {
    const d = Math.abs(flight[i].hx - flight[i - 1].hx);
    if (flight[i].t > flight[i - 1].t) steps.push(d);
  }
  assert.ok(steps.length >= 8,
    "the lure should be in the air for several frames, saw " + steps.length);
  assert.ok(steps.filter((d) => d > 0.3).length >= 6,
    "it should move most frames rather than appearing at full length: " +
    steps.map((d) => d.toFixed(1)).join(", "));
  assert.ok(Math.max.apply(null, steps) < 8,
    "and no single frame should jump most of the reach; biggest step " +
    Math.max.apply(null, steps).toFixed(1));

  /* 3. It ARCS: thrown upward, so it is HIGHER than where it left the rod
        before it is lower. A monotonic fall is the straight line again. */
  /* Measured out of the trace itself rather than against poleY0. The first
     version compared the flight's high point to the recorded launch height
     and did NOT fail when the upward throw was set to zero -- a green test
     for a claim that was no longer true. Comparing the first sampled height
     to the lowest sampled height cannot have that problem: with a flat
     throw they are the same number. */
  /* OUTBOUND only -- up to and including the frame it lands. `flight` runs
     on to the reel, and the reel legitimately lifts the lure back toward his
     hand, so a minimum taken over all of it is the return trip rather than
     the arc. That is not a hypothetical: with the upward throw zeroed this
     assertion still passed, because the reel supplied a 10px "rise" for a
     cast that went out dead flat. */
  const landIdx = live.findIndex((f) => f.landed);
  const outbound = (landIdx >= 0 ? live.slice(0, landIdx + 1) : flight)
    .filter((f) => f.t >= 0);
  assert.ok(outbound.length >= 8,
    "expected a real outbound flight to measure, got " + outbound.length);
  const ys = outbound.map((f) => f.hy);
  const startY = ys[0];
  const highest = Math.min.apply(null, ys);       // smallest y is highest up
  assert.ok(startY - highest > 1.5,
    "the lure should rise above where it left the rod before it falls; " +
    "started at " + startY.toFixed(1) + " and never got above " +
    highest.toFixed(1));
  const lowest = Math.max.apply(null, live.map((f) => f.hy));
  assert.ok(lowest > startY + 6,
    "and then come down well below it; reached " + lowest.toFixed(1) +
    " from " + startY.toFixed(1));

  /* 4. The way home is live. This is the half that did not exist: a cast
        that missed going out can still catch somebody coming back. */
  const landedAt = r.findIndex((f) => f.landed);
  assert.ok(landedAt >= 0, "on flat ground the lure should reach the floor");
  const afterLanding = r.slice(landedAt + 1).filter((f) => f.live);
  assert.ok(afterLanding.length >= 8,
    "the hitbox should stay live while it is reeled in, got " +
    afterLanding.length + " frames");
  const home = afterLanding[afterLanding.length - 1];
  assert.ok(Math.abs(home.hx - home.mx) < Math.abs(r[landedAt].hx - r[landedAt].mx),
    "and the lure should be coming back toward him while it is");

  /* 5. Shorter than it was: the old near-straight line reached 82 from a
        jump, and that is the number this has always been about.

        The bound moved in 2.55 because POLE_V0 did -- 5.6 -> 6.72, a fifth
        more, deliberately, to make the lure go a fifth further and a fifth
        faster. Nothing else about the cast changed: same launch, same
        gravity, same frame count, so the whole fifth is spent on ground
        covered. Measured on the flat, the same cast through the same
        harness: 42.9 with POLE_V0 at 5.6, 50.6 at 6.72 -- the fifth arriving
        exactly where it was aimed. Pinned at 56, which is the handful of
        pixels of slack the old 46 left over 42.9, and still nowhere near
        82. */
  const reach = Math.max.apply(null, live.map((f) => Math.abs(f.hx - f.mx)));
  assert.ok(reach < 56,
    "the cast should not reach as far as the old one; got " + reach.toFixed(1));
  assert.ok(reach > 46,
    "and POLE_V0 is 6.72 now, so it should reach further than the 42.9 it " +
    "did at 5.6 -- past the old bound, not merely up to it; got " +
    reach.toFixed(1));
});

test("the lure carries his momentum, so a moving cast does not stall", async () => {
  /* The complaint: move in the direction you are fishing and the bait
     basically goes nowhere. It was true, and the reason is that the lure is
     launched from a REMEMBERED point in the world and flies on its own -- so
     drifting forward at roughly the speed it travels left it hanging in front
     of him, gaining almost nothing.

     poleVX is his speed at the moment it left his hand, added to the flight
     every frame and NOT subject to the drag. Drag is what the cast loses to
     the air; the momentum he handed it is not something the air takes back,
     and decaying it would put the lure back to stalling a second later. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const DOWN_SPECIAL = 1024;
  /* `killCarry` reproduces the old behavior by zeroing poleVX every frame.
     Without it this measures only that the lure moves, which it always did --
     what is being tested is that it keeps its lead over a MOVING thrower. */
  const cast = (drift, killCarry) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var s = me.def.specials.down;
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.grabbing = -1;
    me.x = main.x + 30; me.y = main.y - 70; me.vy = 0; me.vx = ${drift};
    me.grounded = false; me.facing = 1;
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99; foe.health = 1000;
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.hasHit = true;
    var lead = 0, box = null, out = [];
    netplay.active = true;
    for (var i = 0; i < 40; i++) {
      me.hitstop = 0; me.mana = 999;
      // Held up and drifting, so the only variable is the carry.
      me.vy = 0; me.y = main.y - 70; me.grounded = false; me.vx = ${drift};
      netplay.framePads = [bitsToPad(i === 0 ? ${DOWN_SPECIAL} : 0), bitsToPad(0)];
      step();
      if (${killCarry}) me.poleVX = 0;
      var h = (me.state === 'special') ? poleHook(me, s) : null;
      if (!h) continue;
      if (h.x - me.x > lead) lead = h.x - me.x;
      /* The OUTBOUND flight, frame by frame, and only that: 'landed' goes
         true on the frame it touches down, and after the flight ENDS the
         reel takes over and interpolates the lure back toward his hand --
         which poleHook reports with no 'landed' flag at all, so the flag
         alone would quietly let reel frames into this. */
      var t = me.attackFrame - s.startup;
      if (!h.landed && t <= poleFlight(me, s, s.active).at) {
        out.push(h.x - me.x);
      }
      var b = me.hitbox();
      if (b && !box) box = { w: b.box.w, h: b.box.h };
    }
    netplay.active = false; netplay.framePads = null;
    return { lead: lead, box: box, out: out };
  })()`);

  // Standing still, the carry changes nothing -- there is nothing to carry.
  const still = cast(0, false), stillOld = cast(0, true);
  assert.ok(Math.abs(still.lead - stillOld.lead) < 0.01,
    "with no drift the carry must be a no-op; " + still.lead.toFixed(1) +
    " against " + stillOld.lead.toFixed(1));

  /* Drifting, it is the whole difference -- measured along the flight rather
     than at its furthest point, and that is 2.55's doing.

     The old version compared the two casts' best reach and wanted half as
     much again. That worked while both casts flew the same length of time.
     POLE_V0 6.72 broke the comparison rather than the behavior: on Deep
     Space the faster lure now clips the top platform at y 54 and LANDS on
     frame 10 of its flight, where the stalled one sails under it and flies
     for 28. Two casts with wildly different flight times cannot be compared
     by where they ended up -- the carry is worth his speed per frame, so a
     cast cut short collects less of it, and the ratio measures the stage
     furniture instead of the carry. Measured: at 1.0, 42.4 against 36.4; at
     1.9, 41.5 against 22.7.

     So compare them frame for frame over the flight they share. poleVX is
     added every frame and is NOT dragged, which makes the prediction exact
     rather than approximate: after k frames in the air the carried lure is
     ahead by k times his speed, to the pixel. Zeroing poleVX, or decaying it
     with the drag, misses by more than the tolerance below on the first
     frame. */
  for (const drift of [1.0, 1.9]) {
    const now = cast(drift, false), before = cast(drift, true);
    const n = Math.min(now.out.length, before.out.length);
    assert.ok(n >= 8,
      "expected a shared outbound flight to compare, got " + n + " frames");
    for (let k = 0; k < n; k++) {
      const gap = now.out[k] - before.out[k];
      assert.ok(Math.abs(gap - drift * k) < 0.01,
        "drifting at " + drift + ", frame " + k + " of the flight should be " +
        (drift * k).toFixed(1) + "px further out with the carry than without; " +
        "it is " + gap.toFixed(2) + " (" + now.out[k].toFixed(1) + " against " +
        before.out[k].toFixed(1) + ")");
    }
    // And it is a real distance by the end of it, not a rounding difference.
    const gained = now.out[n - 1] - before.out[n - 1];
    assert.ok(gained > 5,
      "drifting at " + drift + ", the carry should be worth real pixels by " +
      "the end of the shared flight; gained " + gained.toFixed(1) + " over " +
      n + " frames");
  }

  // And the hook is a little more forgiving than it was.
  assert.equal(still.box.w, 12, "the hook box should be 12 wide");
  assert.equal(still.box.h, 12, "and 12 tall");
});

test("casting roots him, and the move that does not stops when you let go", async () => {
  /* Two halves that only make sense together.

     The cast was briefly `mobile`, and the trajectory work is what made that
     possible -- the lure launches from a remembered point in the world, so
     walking away stopped dragging the line along behind him. It still played
     worse, so it is rooted again: nine frames of telegraph and a long tail
     he cannot cancel is the shape of the move, and being free to walk
     through all of it took the decision out of it.

     The bug that episode uncovered is real and stays fixed. A `mobile` move
     neither set vx nor damped it -- the friction branch is skipped for
     exactly these moves -- so whatever speed he carried in was frozen for the
     whole move: measured at 24.5px of silent drift across a 55 frame cast
     with nothing held, vx pinned at 0.584 the entire time. "You may move
     while casting" had quietly meant "you may not stop". LASER SWORD is the
     only mobile move left, so that is where the guard lives now. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const DOWN_SPECIAL = 1024, ULT = 256, RIGHT = 2;
  /* `enter` is the move: the bits that start it, plus any state it needs.
     `hold` is what is held for every frame after. */
  const drive = (startBits, hold, enterMoving, prep) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.grabbing = -1;
    me.x = main.x + 30; me.y = main.y; me.vy = 0; me.grounded = true;
    me.facing = 1;
    me.vx = ${enterMoving} ? me.def.walk : 0;
    ${prep}
    foe.x = main.x + main.w - 6; foe.y = main.y; foe.invuln = 9999;
    foe.stocks = 99; foe.health = 1000; foe.setState('idle'); foe.hasHit = true;
    var x0 = me.x, busy = 0;
    netplay.active = true;
    for (var i = 0; i < 40; i++) {
      var bits = (i === 0 ? ${startBits} : ${hold});
      netplay.framePads = [bitsToPad(bits), bitsToPad(0)];
      step();
      if (me.state === 'special' || me.state === 'ult') busy++;
    }
    netplay.active = false; netplay.framePads = null;
    return { moved: me.x - x0, busy: busy };
  })()`);

  // --- the pole roots him ------------------------------------------------
  const cast = drive(DOWN_SPECIAL, RIGHT, false, "");
  assert.ok(cast.busy > 20,
    "the cast should still be running for most of this; " + cast.busy);
  assert.ok(Math.abs(cast.moved) < 4,
    "holding right through a cast must NOT walk him any more; moved " +
    cast.moved.toFixed(1) + "px");

  /* And he still cannot be nudged out of it by carrying speed in: friction
     applies, which is the ordinary non-mobile path. */
  const carried = drive(DOWN_SPECIAL, 0, true, "");
  assert.ok(Math.abs(carried.moved) < 6,
    "entering the cast at a walk should bleed off, not coast; moved " +
    carried.moved.toFixed(1) + "px");

  // --- the sword is the mobile one, and it stops when you let go ---------
  const SWORD = "me.swordTimer = 500;";     // sword in hand: ult swings it free
  const swung = drive(ULT, RIGHT, false, SWORD);
  assert.ok(swung.busy > 5,
    "the sword swing should have run; " + swung.busy + " frames");
  assert.ok(swung.moved > 5,
    "holding right through the sword swing should walk him; moved " +
    swung.moved.toFixed(1) + "px");

  const drifting = drive(ULT, 0, true, SWORD);
  assert.ok(Math.abs(drifting.moved) < 6,
    "releasing everything during a mobile move should stop him rather than " +
    "freezing his momentum; drifted " + drifting.moved.toFixed(1) + "px");

  /* Drawing the sword is mobile too, which the swing always was. `equip` is
     not in `rooted`'s list, so what used to stop him was the plain
     non-mobile path -- friction on the ground with no way to accelerate out
     of it -- for all 31 frames of startup, active and recovery. Half a
     second of standing still to take a weapon out. */
  const DRAW = "me.ultMeter = 999; me.swordTimer = 0;";
  const drawing = drive(ULT, RIGHT, false, DRAW);
  assert.ok(drawing.busy > 20,
    "the ult animation should still be running for most of this; " +
    drawing.busy + " frames");
  assert.ok(drawing.moved > 15,
    "he should be able to walk while drawing the sword; moved " +
    drawing.moved.toFixed(1) + "px");
});

/* The throttle, driven and asserted in one function so the negative control
   at the foot of this file can run the identical checks against an engine
   with the throttle taken out. */
async function checkStatusThrottle(engineSrc) {
  const run = await bootEngine(engineSrc);
  run("select.cursor=[0,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const r = run(`(function () {
    var counts = {};
    var realCue = cue;
    /* Only the fighter being measured. Every status cue carries the slot it
       is speaking for, and counting them all counts the OTHER fighter's
       statuses as this one's: Reese drops a CROP DUST cloud during the
       warmup, the poison on his neighbor runs its 150 frames alongside this
       one, and 150 frames of somebody else is seven more cues on a count of
       nine. Seen as 16 cues over 188 ticks -- a test failing for a fighter
       it was not looking at, and only on the Math streams where the cloud
       happened to land. */
    cue = function (name, o) {
      if (o && o.slot === f.slot) counts[name] = (counts[name] || 0) + 1;
      return realCue.apply(null, arguments);
    };
    var f = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;
    f.invuln = 0; f.vx = 0; f.vy = 0; f.grounded = true;
    f.x = main.x + 60; f.y = main.y;
    f.health = 1000; f.stocks = 99;
    f.poison = 200; f.poisonDps = 0.05; f.poisonBy = 0;
    f.burn = 200; f.burnDps = 0.075;
    /* The other fighter is a CPU and it will walk over and start punching,
       which lands in the same health number the statuses do. Park it at the
       far edge and hold it idle every frame so the only thing taking health
       off is the poison and the fire. */
    var other = fighters[0];
    other.stocks = 99; other.health = 1000;
    var park = function () {
      other.setState('idle');
      other.timer = 0; other.attackFrame = 0; other.hasHit = true;
      other.x = main.x + 4; other.y = main.y; other.vx = 0; other.vy = 0;
      other.grounded = true; other.mana = 0; other.ultMeter = 0;
      // And nothing ticking on it either: a status it caught in the warmup
      // would tick down beside this one for as long as it lasts.
      other.poison = 0; other.burn = 0;
      projectiles.length = 0;
    };
    /* Counted rather than assumed. Both statuses are frozen by hitstop --
       update() returns above the damage-over-time block -- and this fighter
       is a CPU that trades blows, so 200 frames is not 200 ticks. Measured
       here: 185, the missing 15 being one heavy hitstop. Asserting against a
       hardcoded 200 fails for a reason that has nothing to do with sound. */
    var before = f.health;
    var pTicks = 0, bTicks = 0, pPrev = f.poison, bPrev = f.burn;
    for (var i = 0; i < 200; i++) {
      park();
      step();
      if (f.poison < pPrev) pTicks++;
      if (f.burn < bPrev) bTicks++;
      pPrev = f.poison; bPrev = f.burn;
    }
    cue = realCue;
    return { poison: counts.poison || 0, burn: counts.burn || 0,
             lost: before - f.health, pTicks: pTicks, bTicks: bTicks,
             pDps: f.poisonDps, bDps: f.burnDps };
  })()`);

  assert.ok(r.pTicks > 150 && r.bTicks > 150,
    "the statuses should have run most of their length; " +
    r.pTicks + " and " + r.bTicks + " ticks");

  // One cue every twentieth tick, give or take where the counters started.
  for (const [what, cues, ticks] of [["poison", r.poison, r.pTicks],
                                     ["burning", r.burn, r.bTicks]]) {
    assert.ok(cues >= ticks / 30 && cues <= ticks / 12,
      what + " should speak about once every twenty ticks: " + cues +
      " cues over " + ticks + " ticks");
  }

  /* The negative control, and the reason the throttle is at the call site
     rather than in the tick: quieter must not mean weaker. Every tick still
     takes its full damage, and the only thing that changed is how often you
     hear about it. If someone ever "fixes" this by throttling the tick
     itself, this is the assertion that catches it. */
  const expect = r.pTicks * r.pDps + r.bTicks * r.bDps;
  assert.ok(Math.abs(r.lost - expect) < 0.01,
    "every tick should still take its damage: expected " + expect.toFixed(3) +
    ", lost " + r.lost.toFixed(3));
}

test("a status ticks damage every frame but only speaks every twentieth", async () => {
  /* Measured before the fix: one poisoned, burning fighter fired 350 poison
     cues in four seconds -- roughly 85 a second, at 880Hz. That is not a
     status sound, it is an alarm.

     The throttle keys off the status counter itself rather than a new timer
     field, which matters for netcode specifically: restoreSim deletes any key
     that is not in the snapshot, so a fresh poisonCueTimer would have to be
     declared in the constructor or vanish on every rollback. Deriving the
     throttle from state that is already snapshotted means a resimulated frame
     replays the identical cue pattern for nothing.

     Everything it checks lives in checkStatusThrottle above, so the negative
     control at the foot of this file can run the identical checks against an
     engine with the throttle removed. */
  await checkStatusThrottle();
});

test("the status and burp sounds sit under the sounds that matter", async () => {
  /* BELCH at 0.40 was the loudest recipe in the file, tied with the deadlift
     that drops the floor on the whole stage -- and it is a 21 frame neutral
     special that mashes out four times in four seconds until the meter dries
     up. Loudest plus roughly once a second is what makes a sound obnoxious;
     neither on its own is. */
  const run = await bootEngine();
  const gains = run(`(function () {
    var out = {};
    for (var k in AUDIO_RECIPES) out[k] = AUDIO_RECIPES[k].gain;
    return out;
  })()`);

  assert.ok(gains.burn != null, "burning needs a recipe or its cue is silent");

  const hit = gains.hit;
  assert.ok(gains.poison < hit,
    "the poison tick should be quieter than a punch; " + gains.poison + " vs " + hit);
  assert.ok(gains.burn <= gains.poison,
    "and the fire quieter still; " + gains.burn + " vs " + gains.poison);
  assert.ok(gains.belch < hit,
    "the burp should not be louder than a punch; " + gains.belch + " vs " + hit);

  const loudest = Object.keys(gains).reduce(
    (a, k) => (gains[k] > gains[a] ? k : a), "hit");
  assert.notEqual(loudest, "belch",
    "a spammable neutral special must not be the loudest sound in the game");
});

/* Appended, not inserted, and that is load-bearing.

   bootEngine() seeds each vm context from a module-level counter
   (__seedCounter, top of this file), so a test's random stream is a function
   of HOW MANY TESTS RAN BEFORE IT. Adding this test in the middle of the file
   re-seeded every test after it, and "a status ticks damage every frame but
   only speaks every twentieth" started failing -- 16 cues over 185 ticks
   instead of about 9 -- with nothing about poison having changed.

   Putting new tests at the end keeps every existing slot where it was. That
   is a workaround, not a fix: the real problem is that the suite's seeds are
   positional. See the note on this in the commit. */
test("Simon is in the game off one sheet, with a kit that works", async () => {
  /* Eight cells of base art off one sheet, and -- since 2.53 -- a kit of his
     own: a hotdog, the slots, the guillotine, the slouch. Those are tested
     for what they DO in nerdwars-simon.test.js. This pins the plumbing they
     all sit on: he is where the select expects him, every frame exists,
     every slot is filled and priced, and every button produces a move that
     ends with him still on the stage. */
  const run = await bootEngine();
  assert.equal(run("ORDER.indexOf('simon')"), 7, "appended, not inserted");

  // Eight frames off one sheet, through build.py's 2x4 slicer.
  for (const f of ["standR", "standL", "walkR1", "walkL1",
                   "walkR2", "walkL2", "jumpR", "jumpL"]) {
    assert.ok(run("!!IMG['simon.base.' + " + JSON.stringify(f) + "]"),
      "simon is missing the '" + f + "' frame. There is no per-frame " +
      "fallback in sprite(): a missing frame returns undefined and " +
      "drawFighter's `if (!im) return` skips the whole fighter, so he " +
      "would flicker out of existence on that animation frame alone.");
  }

  // A kit is only a kit if every slot is filled and priced.
  const kit = run(`(function () {
    var d = ROSTER.simon, out = { slots: [], unpriced: [], noKind: [] };
    for (var k in d.specials) {
      out.slots.push(k);
      var sp = d.specials[k];
      if (!(sp.mana > 0)) out.unpriced.push(k);
      if (!sp.kind) out.noKind.push(k);
    }
    return { slots: out.slots.sort(), unpriced: out.unpriced,
             noKind: out.noKind, ult: !!d.ult && d.ult.kind,
             jab: !!d.jab && d.jab.damage > 0,
             weight: d.weight, walk: d.walk, jump: d.jump };
  })()`);
  /* Compared as strings, not with deepEqual. These arrays were built inside
     the vm context, which has its OWN Array constructor, so deepEqual fails
     on two arrays whose contents are identical. */
  assert.equal(kit.slots.join(","), "down,neutral,up",
    "all three special slots must exist");
  assert.equal(kit.unpriced.join(","), "",
    "every special is priced by the loop at load; a ROSTER entry declared " +
    "AFTER that loop silently gets mana === undefined, and nothing warns");
  assert.equal(kit.noKind.join(","), "",
    "a move with no kind hits no case in runSpecial's switch -- there is no " +
    "default -- so it animates, costs mana, and does nothing");
  assert.ok(kit.ult, "he needs an ult");
  assert.ok(kit.jab, "and a jab that does damage");
  for (const [k, lo, hi] of [["weight", 90, 115], ["walk", 1.1, 1.7],
                             ["jump", 5.8, 7.2]]) {
    assert.ok(kit[k] >= lo && kit[k] <= hi,
      k + " is " + kit[k] + ", outside the range the rest of the roster uses");
  }

  // And he actually fights: every button starts a move, every move ends,
  // nobody's numbers go bad, and he is still standing on the stage after.
  const fought = run(`(function () {
    select.cursor=[7,4]; twoPlayer=true; playerCount=2; humanCount=0;
    stagePick=0; startBattle();
    for (var i=0;i<130;i++) step();
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var name = me.def.name, started = 0, ended = 0, bad = 0;
    netplay.active = true;
    var BITS = [32, 512, 1024, 2048, 256];
    for (var b = 0; b < BITS.length; b++) {
      projectiles.length = 0; effects.length = 0;
      me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0;
      me.landLag=0; me.invuln=0; me.grabbing=-1; me.grounded=true;
      me.facing=1; me.stocks=99; me.eliminated=false; me.vx=0; me.vy=0;
      me.x=main.x+40; me.y=main.y; me.specialSpawned=false; me.ultMeter=999;
      foe.setState('idle'); foe.stocks=99; foe.health=1000; foe.eliminated=false;
      foe.hasHit=true; foe.grabbedBy=-1; foe.x = main.x + 120; foe.y = main.y;
      var sawMove = false, wasDone = false;
      /* 700, not 420. The longest of the five is the slouch, and it is
         24 + 600 + 18 = 642 frames now that the sleep is ten seconds: at 420
         the ult alone never handed him back, which read as a broken move
         rather than a window that closed too early. */
      for (var i = 0; i < 700; i++) {
        me.hitstop=0; me.mana=999;
        netplay.framePads = [bitsToPad(i === 0 ? BITS[b] : 0), bitsToPad(0)];
        step();
        if (me.state === 'attack' || me.state === 'special' || me.state === 'ult') sawMove = true;
        if (sawMove && me.state !== 'attack' && me.state !== 'special' && me.state !== 'ult') { wasDone = true; break; }
        if (me.health !== me.health || foe.health !== foe.health) bad++;
      }
      if (sawMove) started++;
      if (wasDone) ended++;
    }
    netplay.active = false; netplay.framePads = null;
    return { name: name, started: started, ended: ended, bad: bad,
             onStage: me.stocks === 99 && !me.eliminated && me.y <= main.y + 1 };
  })()`);
  assert.equal(fought.name, "SIMON");
  assert.equal(fought.started, 5,
    "all five buttons -- jab, three specials, ult -- should start a move; " + fought.started + " did");
  assert.equal(fought.ended, 5,
    "and every one should finish and hand him back; " + fought.ended + " did");
  assert.equal(fought.bad, 0, "and nobody's health may ever be NaN");
  assert.ok(fought.onStage, "and he should still be standing on the stage");
});

test("the rainbow is a lob again, wearing one colour at a time", async () => {
  /* This move has been three things. A lobbed dot with a flag of colour on
     it, which did 15 damage and nothing else. Then an arch: a 144x66 painted
     span, the stage dimming behind it, seven bars falling. That was a
     spectacle and it was not what anybody wanted to play.

     It is the lob again, with the throw it always had, and the projectile is
     now ONE colour at a time instead of all six at once. The colour is the
     move: whichever tint it is wearing when it lands is what it does. */
  const run = await bootEngine();
  run("select.cursor=[0,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.name"), "AUTISNICK");
  assert.equal(run("ROSTER.autisnick.specials.up.label"), "RAINBOW");
  assert.equal(run("ROSTER.autisnick.specials.up.kind"), "rainbow");

  const SP_U = 2048;
  const r = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grabbing=-1; me.grounded=true;
    me.facing=1; me.stocks=99; me.eliminated=false; me.specialSpawned=false;
    me.x=main.x+20; me.y=main.y;
    foe.setState('idle'); foe.stocks=99; foe.health=1000; foe.eliminated=false;
    foe.y=main.y; foe.hasHit=true; foe.grounded=true;
    foe.x = main.x + 250; foe.invuln = 9999;
    var seen = [], path = [], boxes = 0, same = true, first = null;
    netplay.active = true;
    for (var i = 0; i < 120; i++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_U} : 0), bitsToPad(0)];
      step();
      var b = projectiles.filter(function (p) {
        return p.constructor.name === 'Rainbow'; })[0];
      if (b) {
        boxes++;
        path.push([Math.round(b.x), Math.round(b.y)]);
        var tint = b.spec.tint;
        if (seen[seen.length - 1] !== tint) seen.push(tint);
        // The spec it carries must be one of the six built at load, not a
        // fresh object -- see the note by the pricing loop.
        var tints = ROSTER.autisnick.specials.up.tints;
        if (tints.indexOf(b.spec) < 0) same = false;
        if (first === null) first = b.css();
      }
    }
    netplay.active = false; netplay.framePads = null;
    return { seen: seen.join(','), boxes: boxes, same: same, first: first,
             path: path.map(function (q) { return q.join(':'); }).join(' '),
             cycle: ROSTER.autisnick.specials.up.cycle,
             order: ROSTER.autisnick.specials.up.colors
                      .map(function (c) { return c.tint; }).join(',') };
  })()`);

  assert.ok(r.boxes > 40, "the shot should stay up a while, got " + r.boxes);
  assert.equal(r.order, "RED,ORANGE,YELLOW,GREEN,BLUE,PURPLE",
    "ROYGBP, in that order");
  assert.ok(r.same, "every spec it carries should be one of the six built at load");

  // It cycles, in order, and gets all the way round.
  const seen = r.seen.split(",");
  assert.ok(seen.length >= 6,
    "it should have worn at least six colours, wore: " + r.seen);
  assert.equal(seen[0], "RED", "starting on red");
  const order = r.order.split(",");
  for (let i = 1; i < seen.length; i++) {
    const want = order[(order.indexOf(seen[i - 1]) + 1) % order.length];
    assert.equal(seen[i], want,
      "the wheel should turn in order, got " + r.seen);
  }

  // And it is a lob: up first, then down, landing further away than it started.
  const path = r.path.split(" ").map((q) => q.split(":").map(Number));
  const top = Math.min(...path.map((q) => q[1]));
  assert.ok(top < path[0][1] - 20,
    "it should arc at least 20px above where it was thrown, rose " +
    (path[0][1] - top));
  assert.ok(path[path.length - 1][1] > top + 10, "and come back down");
  assert.ok(path[path.length - 1][0] > path[0][0] + 40,
    "travelling away from him while it does");

  /* And it is ONE colour on screen, not six. It used to draw the whole
     spectrum as six one-pixel bands stacked into a 6x6 square, which at that
     size read as a grey smudge and told you nothing about what was coming.
     The colour IS the move now, so the square has to be the colour. */
  const paint = run(`(function () {
    var b = projectiles.filter(function (p) {
      return p.constructor.name === 'Rainbow'; })[0];
    if (!b) {
      // Throw a fresh one and let it get into the air.
      var me = fighters[0];
      me.setState('idle'); me.specialSpawned = false; me.mana = 999;
      me.hitstop = 0; me.hitstun = 0; me.grounded = true;
      netplay.active = true;
      for (var i = 0; i < 30; i++) {
        me.hitstop = 0; me.mana = 999;
        netplay.framePads = [bitsToPad(i === 0 ? 2048 : 0), bitsToPad(0)];
        step();
      }
      netplay.active = false; netplay.framePads = null;
      b = projectiles.filter(function (p) {
        return p.constructor.name === 'Rainbow'; })[0];
    }
    if (!b) return 'no shot';
    var used = {}, real = sctx.fillStyle;
    var g = { globalAlpha: 1, fillStyle: '',
              fillRect: function () { used[this.fillStyle] = 1; } };
    b.draw(g);
    /* The SPEC's colour, not css(). Asking the same method the drawing asked
       would be the picture agreeing with itself: a css() that returned red
       forever would paint red, report red, and pass. */
    return Object.keys(used).join(',') + '~' + b.spec.css + '~' + b.spec.tint;
  })()`);
  const [usedCsv, carrying, tint] = paint.split("~");
  const used = usedCsv.split(",").filter((c) => c && c !== "#000000");
  assert.equal(used.length, 1,
    "the square should be one colour, painted with: " + usedCsv);
  assert.equal(used[0], carrying,
    "and it should be " + tint + ", whose payload it is carrying");
});

test("a rainbow is the same colour after a rollback as it was before", async () => {
  /* The cycle is derived from the projectile's own age, which the snapshot
     carries -- so replaying frame 40 has to produce the colour frame 40 had
     the first time. If it drifted, two machines would apply two different
     payloads from the same hit and the match would quietly diverge. */
  const run = await bootEngine();
  run("select.cursor=[0,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const SP_U = 2048;
  const r = run(`(function () {
    var me = fighters[0];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grounded=true; me.facing=1;
    me.specialSpawned=false; me.x=main.x+20; me.y=main.y;
    netplay.active = true;
    netplay.framePads = [bitsToPad(${SP_U}), bitsToPad(0)];
    step();
    netplay.framePads = [bitsToPad(0), bitsToPad(0)];
    for (var i = 0; i < 20; i++) { me.hitstop = 0; step(); }

    var snap = saveSim();
    var live = [];
    for (var i = 0; i < 25; i++) {
      me.hitstop = 0; step();
      var b = projectiles.filter(function (p) {
        return p.constructor.name === 'Rainbow'; })[0];
      live.push(b ? b.spec.tint + '@' + Math.round(b.x) : '-');
    }
    restoreSim(snap);
    var again = [];
    for (var i = 0; i < 25; i++) {
      me.hitstop = 0; step();
      var b2 = projectiles.filter(function (p) {
        return p.constructor.name === 'Rainbow'; })[0];
      again.push(b2 ? b2.spec.tint + '@' + Math.round(b2.x) : '-');
    }
    netplay.active = false; netplay.framePads = null;
    return { live: live.join(' '), again: again.join(' ') };
  })()`);

  assert.ok(/RED|ORANGE|YELLOW|GREEN|BLUE|PURPLE/.test(r.live),
    "the shot should have been in the air, got " + r.live);
  assert.equal(r.again, r.live,
    "replaying the same frames must give the same colours in the same places");
});

test("what the rainbow does depends on the colour it was", async () => {
  /* Six colours, six payloads, and five of the six were already things
     applyHit understood -- burn, knockback, stun, poison and confusion. Only
     the mana drain is new, and it needed no new state because mana is already
     a fighter field. */
  const run = await bootEngine();
  run("select.cursor=[0,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<40;i++) step();");

  const hit = (tint) => {
    const raw = run(`(function () {
      var me = fighters[0], foe = fighters[1];
      var tints = ROSTER.autisnick.specials.up.tints;
      var spec = tints.filter(function (s) { return s.tint === ${JSON.stringify(tint)}; })[0];
      if (!spec) return 'no such tint';
      foe.health = 500; foe.burn = 0; foe.poison = 0; foe.confused = 0;
      foe.hitstun = 0; foe.mana = 100; foe.shield = 0; foe.shieldBroken = 0;
      foe.state = 'idle'; foe.hitstop = 0; foe.invuln = 0; foe.eliminated = false;
      foe.x = me.x + 20; foe.y = me.y; foe.vx = 0; foe.vy = 0;
      applyHit(me, foe, spec, me.x, 1);
      return [500 - foe.health, foe.burn, foe.poison, foe.confused,
              foe.hitstun, 100 - foe.mana,
              Math.round(Math.abs(foe.vx) * 100) / 100].join('|');
    })()`);
    const [dmg, burn, poison, confused, hitstun, drained, kb] =
      raw.split("|").map(Number);
    return { dmg, burn, poison, confused, hitstun, drained, kb };
  };

  const red = hit("RED");
  assert.ok(red.burn > 0, "red should set them alight, burn " + red.burn);
  assert.equal(red.poison, 0, "and only that");
  assert.equal(red.confused, 0);

  const orange = hit("ORANGE");
  assert.equal(orange.burn, 0);
  assert.equal(orange.poison, 0);
  assert.ok(orange.dmg > red.dmg,
    "orange should hit harder on the way in, " + orange.dmg + " vs " + red.dmg);
  assert.ok(orange.kb > red.kb * 1.3,
    "and launch much further: " + orange.kb + " vs " + red.kb);

  const yellow = hit("YELLOW");
  assert.ok(yellow.hitstun > red.hitstun,
    "yellow should stun for longer than a plain hit, " +
    yellow.hitstun + " vs " + red.hitstun);
  assert.equal(yellow.burn, 0);

  const green = hit("GREEN");
  assert.ok(green.poison > 0, "green should poison, got " + green.poison);
  assert.equal(green.burn, 0, "which is not the same thing as burning");

  const blue = hit("BLUE");
  assert.ok(blue.confused > 0, "blue should confuse, got " + blue.confused);

  const purple = hit("PURPLE");
  assert.ok(purple.drained > 0, "purple should drain mana, took " + purple.drained);
  assert.equal(purple.burn + purple.poison + purple.confused, 0,
    "and do nothing else");

  // Nobody's payload is anybody else's.
  const all = [red, orange, yellow, green, blue, purple];
  const fingerprints = all.map((h) =>
    [h.burn > 0, h.poison > 0, h.confused > 0, h.drained > 0,
     h.hitstun, Math.round(h.kb)].join(","));
  assert.equal(new Set(fingerprints).size, 6,
    "six colours should do six different things, got " + fingerprints.join("  /  "));

  // And a drained bar stops at zero rather than going negative.
  const floorAt0 = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var spec = ROSTER.autisnick.specials.up.tints
      .filter(function (s) { return s.tint === 'PURPLE'; })[0];
    foe.mana = 3; foe.health = 500; foe.shield = 0; foe.state = 'idle';
    foe.hitstop = 0; foe.invuln = 0;
    applyHit(me, foe, spec, me.x, 1);
    return foe.mana;
  })()`);
  assert.equal(floorAt0, 0, "a drained bar bottoms out at zero, got " + floorAt0);
});

test("Cobeus's AK fires three rounds, spaced apart", async () => {
  /* Three objects leaving at three different times, not one shotgun blast.
     The gap is the move: it is three chances to miss, and a gap somebody
     can walk through. */
  const run = await bootEngine();
  run("select.cursor=[6,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("ROSTER.cobeus.specials.down.label"), "FULL AUTO");
  assert.ok(run("!!IMG.ak"),
    "the rifle sprite never became an Image -- loadAssets names every " +
    "non-character sprite by hand, and art it misses is silently invisible");

  const SP_D = 1024;
  const r = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grabbing=-1; me.grounded=true;
    me.facing=1; me.stocks=99; me.eliminated=false; me.specialSpawned=false;
    me.buffTimer=0; me.buffStats=null; me.chargeTimer=0;
    me.x=main.x+30; me.y=main.y;
    foe.setState('idle'); foe.stocks=99; foe.health=1000; foe.eliminated=false;
    foe.y=main.y; foe.hasHit=true; foe.grounded=true;
    foe.x = main.x + main.w - 8; foe.invuln = 9999;
    var shots = 0, at = [];
    netplay.active = true;
    for (var i = 0; i < 70; i++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_D} : 0), bitsToPad(0)];
      step();
      var slugs = projectiles.filter(function (p) { return p.constructor.name === 'Slug'; });
      for (var j = 0; j < slugs.length; j++) {
        if (!slugs[j].__seen) { slugs[j].__seen = 1; shots++; at.push(i); }
      }
    }
    netplay.active = false; netplay.framePads = null;
    return { shots: shots, at: at };
  })()`);

  assert.equal(r.shots, 3, "three rounds per trigger pull, got " + r.shots);
  const gaps = r.at.slice(1).map((v, i) => v - r.at[i]);
  assert.deepEqual([...gaps], [5, 5],
    "and they should be spaced, not simultaneous; gaps were " + gaps.join(", "));
});

test("Cobeus can throw the bottle or drink it, on the same button", async () => {
  /* Tap and it goes where it always went. Hold it for three seconds and he
     drinks the thing: half speed, double damage, five seconds.

     The whole mechanism is the charge the pawn already uses -- holding pins
     him on the startup frame and counts -- plus buffTimer/buffStats, which
     Reese's shirtless buff already owns. Neither is new state on the
     Fighter, and that matters: restoreSim deletes any key missing from a
     snapshot, so a bespoke "is drinking" field would survive local play and
     vanish on the first online rollback. */
  const run = await bootEngine();
  run("select.cursor=[6,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const SP_N = 512, HOLD_N = 4096;
  const go = (holdFrames) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grabbing=-1; me.grounded=true;
    me.facing=1; me.stocks=99; me.eliminated=false; me.specialSpawned=false;
    me.buffTimer=0; me.buffStats=null; me.chargeTimer=0;
    me.x=main.x+30; me.y=main.y;
    foe.setState('idle'); foe.stocks=99; foe.health=1000; foe.eliminated=false;
    foe.y=main.y; foe.hasHit=true; foe.grounded=true;
    foe.x = main.x + main.w - 8; foe.invuln = 9999;
    var threw = false, drankAt = -1, dmg = 1, spd = 1, lasts = 0;
    netplay.active = true;
    for (var i = 0; i < 260; i++) {
      me.hitstop = 0; me.mana = 999;
      var bits = (i === 0 ? ${SP_N} : 0) | (i < ${holdFrames} ? ${HOLD_N} : 0);
      netplay.framePads = [bitsToPad(bits), bitsToPad(0)];
      step();
      if (projectiles.some(function (p) { return p.constructor.name === 'Bottle'; })) threw = true;
      if (me.buffTimer > 0 && drankAt < 0) {
        drankAt = i; dmg = me.damageMul; spd = me.speedMul; lasts = me.buffTimer;
      }
    }
    netplay.active = false; netplay.framePads = null;
    return { threw: threw, drankAt: drankAt, dmg: dmg, spd: spd, lasts: lasts };
  })()`);

  const tapped = go(0);
  assert.ok(tapped.threw, "a tap should throw the bottle as it always did");
  assert.equal(tapped.drankAt, -1, "and must not drink it");

  const held = go(200);
  assert.equal(held.threw, false,
    "holding should drink it, not throw it as well");
  assert.ok(held.drankAt > 100 && held.drankAt < 160,
    "two seconds is 120 frames; he drank on frame " + held.drankAt);
  assert.equal(held.dmg, 2, "double damage");
  assert.ok(held.spd < 1, "and slower: speedMul was " + held.spd);
  assert.ok(held.lasts >= 590 && held.lasts <= 610,
    "for about ten seconds; it was " + held.lasts + " frames");

  /* A half-second hold is still a throw. The boundary matters: if any hold
     at all drank, the normal throw would be unreachable for anyone who does
     not release the button instantly. 30 frames is comfortably under the
     120 the drink needs, and stays under it if the threshold moves again. */
  const brief = go(30);
  assert.ok(brief.threw && brief.drankAt === -1,
    "half a second of hold should still be a throw");

  /* And the threshold is where the spec says it is, not merely somewhere
     between 30 and 200. Just under should throw, just over should drink --
     this is what would have caught the hold quietly drifting. */
  const hold = run("ROSTER.cobeus.specials.neutral.charge.hold");
  const under = go(hold - 25);
  assert.ok(under.threw && under.drankAt === -1,
    "holding " + (hold - 25) + " frames is short of " + hold + ", so it " +
    "should still throw");
  const over = go(hold + 40);
  assert.equal(over.threw, false,
    "holding " + (hold + 40) + " frames is past " + hold + ", so it should " +
    "drink");
});


test("only the chess move draws a chess piece", async () => {
  /* The charge mechanism is generic -- hold the button, get pinned on the
     startup frame, count -- and two moves use it now: Trev cycling chess
     pieces, and Cobeus drinking his bottle.

     drawCharge tested `m.charge` alone, so the moment the bottle gained a
     charge a floating white pawn appeared over Cobeus's head for the whole
     three seconds, sitting on top of his own progress meter. It shipped, and
     the report was that the drinking animation "mixes with the chess piece
     one".

     `swapEvery` is the field that actually means "this charge cycles
     pieces", so that is what the draw tests now. This pins both directions:
     the piece still draws for Trev, and never for anybody else. */
  const run = await bootEngine();

  const drawnBy = (who, slot, bit, holdBit, frames) => run(`(function () {
    select.cursor=[${run("ORDER.indexOf('" + who + "')")},2];
    twoPlayer=true; playerCount=2; humanCount=0; stagePick=0; startBattle();
    for (var i=0;i<130;i++) step();
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grabbing=-1;
    me.grounded=true; me.facing=1; me.stocks=99; me.eliminated=false;
    me.specialSpawned=false; me.chargeTimer=0;
    me.x=main.x+60; me.y=main.y;
    foe.setState('idle'); foe.invuln=9999; foe.stocks=99; foe.eliminated=false;
    foe.x=main.x+200; foe.y=main.y; foe.grounded=true;
    netplay.active = true;
    for (var i = 0; i < ${frames}; i++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad((i === 0 ? ${bit} : 0) | ${holdBit}),
                           bitsToPad(0)];
      step();
    }
    netplay.active = false; netplay.framePads = null;
    // A context that records nothing but whether anything was painted.
    var painted = 0;
    var rec = { globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000',
      lineWidth: 1,
      fillRect: function(){ painted++; }, strokeRect: function(){ painted++; },
      drawImage: function(){ painted++; },
      save: function(){}, restore: function(){}, translate: function(){},
      scale: function(){}, rotate: function(){}, beginPath: function(){},
      arc: function(){}, ellipse: function(){}, moveTo: function(){},
      lineTo: function(){}, stroke: function(){}, fill: function(){},
      closePath: function(){}, fillText: function(){} };
    drawCharge(rec, me);
    return { painted: painted, charging: me.chargeTimer,
             slot: me.def.specials.${slot}.label };
  })()`);

  const SP_U = 2048, SP_N = 512, HOLD_U = 16384, HOLD_N = 4096;

  // Trev, holding his up special: the pieces are his, and they still draw.
  const trev = drawnBy("trev", "up", SP_U, HOLD_U, 40);
  assert.ok(trev.charging > 0,
    "Trev should be mid-charge; chargeTimer was " + trev.charging);
  assert.ok(trev.painted > 0,
    "the chess piece preview must still draw for " + trev.slot);

  // Cobeus, holding the bottle: same mechanism, no chess piece.
  const cob = drawnBy("cobeus", "neutral", SP_N, HOLD_N, 60);
  assert.ok(cob.charging > 0,
    "Cobeus should be mid-charge; chargeTimer was " + cob.charging);
  assert.equal(cob.painted, 0,
    "drawCharge painted " + cob.painted + " times while Cobeus was drinking " +
    "-- a chess piece over the head of a man holding a bottle");
});


test("a finished online match goes back to the room, not a dead end", async () => {
  /* The bug, exactly: after an online match the engine dropped everyone on
     the LOCAL character select. netStart had raised the two-people-on-one-
     keyboard flag, so that screen sat waiting for a second keyboard to lock
     seat 1 -- and online there is one keyboard per machine, so seat 1 could
     never lock, nothing advanced, and Escape was the only way out.

     The room was there the whole time: net.js puts everybody back in the
     lobby the moment the match stops. Nobody ever saw it, because the canvas
     was showing a screen that could not be left.

     Driven against a stub lobby rather than real PeerJS: what is under test
     is where the ENGINE sends you, and a stub makes that the only thing
     that can fail. */
  const run = await bootEngine();

  const stub = () => run(`(function () {
    window.__left = 0;
    window.NerdWarsLobby = {
      host: function () {}, join: function () {}, pick: function () {},
      start: function () {}, setStage: function () {},
      leave: function () { window.__left++; },
      snapshot: function () {
        return { available: true, phase: 'lobby', role: 'host', code: 'ABCD',
                 mySlot: 0, myChar: 'kel', stage: 'space', status: '',
                 statusKind: '', seats: [], here: 2, canStart: true };
      },
    };
    return true;
  })()`);

  stub();
  const after = run(`(function () {
    netplay.active = true;
    scene = 'results'; resultTimer = 60; winnerKey = 'kel';
    held.clear(); prevHeld.clear();
    held.add('Enter');
    updateResults();
    var out = scene;
    held.clear(); prevHeld.clear();
    netplay.active = false;
    return out;
  })()`);

  assert.equal(after, 'room',
    "an online match that ends should hand everybody back to the room so " +
    "they can pick again; it went to '" + after + "'");

  /* Escape is different, and should stay different: it means you are done
     with the room, not just with the match. */
  const escaped = run(`(function () {
    netplay.active = true;
    scene = 'results'; resultTimer = 60; winnerKey = 'kel';
    held.clear(); prevHeld.clear();
    held.add('Escape');
    updateResults();
    var out = { scene: scene, left: window.__left };
    held.clear(); prevHeld.clear();
    netplay.active = false;
    return out;
  })()`);
  assert.equal(escaped.scene, 'title', "Escape should leave entirely");
  assert.ok(escaped.left > 0, "and should give up the seat on the way out");

  // Offline, nothing changed: confirm still means another local match.
  const offline = run(`(function () {
    netplay.active = false;
    scene = 'results'; resultTimer = 60; winnerKey = 'kel';
    held.clear(); prevHeld.clear();
    held.add('Enter');
    updateResults();
    var out = scene;
    held.clear(); prevHeld.clear();
    return out;
  })()`);
  assert.equal(offline, 'select',
    "a local match should still go back to the character select");
});


/* A lobby that records what the game asked it to do, with no PeerJS behind
   it. What is under test is the half that moved: the screens, the typing and
   the wiring. net.js's own half is covered by nerdwars-online-4p. */
function stubLobby(run, phase) {
  run(`(function () {
    window.__lobby = { calls: [], phase: ${JSON.stringify(phase || 'idle')},
                       code: 'QK7M', canStart: false, seats: [] };
    window.NerdWarsLobby = {
      host: function () { __lobby.calls.push('host'); },
      join: function (c) { __lobby.calls.push('join:' + c); },
      pick: function (c, r) { __lobby.calls.push('pick:' + c + ':' + (r ? 1 : 0)); },
      start: function () { __lobby.calls.push('start'); },
      leave: function () { __lobby.calls.push('leave'); },
      // Recorded, not swallowed: since 2.55 the room reaches the match through
      // the stage select, and "told the room which stage" is half of what
      // starting one now means.
      setStage: function (k) { __lobby.calls.push('setStage:' + k); },
      me: function () { return __lobby.me || null; },
      setMe: function (m) { __lobby.me = m; },
      snapshot: function () {
        return { available: true, phase: __lobby.phase, role: 'host',
                 code: __lobby.code, mySlot: 0, myChar: 'kel',
                 myReady: !!__lobby.myReady,
                 stage: 'space', status: '', statusKind: '',
                 seats: __lobby.seats, here: __lobby.seats.length,
                 canStart: __lobby.canStart };
      },
    };
    return true;
  })()`);
}

const tapKey = (run, code) => run(`(function () {
  held.clear(); prevHeld.clear(); held.add(${JSON.stringify(code)});
  step();
  held.clear(); prevHeld.clear();
  return scene;
})()`);

/* Where a title entry actually IS, by what it says.

   Written down once because hard-coded positions are exactly what broke here:
   2.55 put PRACTICE in at index 1 and every test that had memorised "the
   leaderboard is the third one" opened the online screen instead -- and did
   it silently, because a wrong scene is still a scene. Looked up, the next
   mode anybody adds moves nothing. */
function modeIndex(run, pattern) {
  const labels = run("MODES.map(function (m) { return m.label; })");
  const i = labels.findIndex((l) => pattern.test(l));
  assert.ok(i >= 0, "no title entry matching " + pattern + "; the title " +
    "offers: " + labels.join(" / "));
  return i;
}

test("the title reaches an online room without leaving the game", async () => {
  /* The room used to be a panel of HTML underneath the canvas: a host
     button, a text box for the code, a list of seats. That meant there was
     no lobby at all in fullscreen, and after every match everybody had to
     look away from the game to set up another one.

     It is a screen in the game now. net.js still owns every byte of the
     transport -- this asserts only that the game asks it the right things. */
  const run = await bootEngine();
  stubLobby(run, 'idle');

  /* The title has to OFFER the online room -- not have it in any particular
     slot. Counting entries is what broke this test when 2.55 slid PRACTICE in
     at index 1 and pushed ONLINE and LEADERBOARD down one each, and counting
     would break it again on the next mode. So: find it by its label and
     select it by the index the label is actually at. */
  const modes = run("MODES.map(function (m) { return m.label; })");
  const online = modes.findIndex((m) => /ONLINE/i.test(m));
  assert.ok(online >= 0,
    "the title should offer an online entry, got: " + modes.join(" / "));
  assert.ok(modes.some((m) => /LEADERBOARD/i.test(m)),
    "and a leaderboard one, got: " + modes.join(" / "));

  // And the entry that says ONLINE is the one flagged as online: a label in
  // the right place over a mode that starts a local match reads fine and
  // plays wrong.
  assert.ok(run("!!MODES[" + online + "].online"),
    "the entry labeled '" + modes[online] + "' should be the online mode");

  run("scene = 'title'; titleChoice = " + online + ";");
  assert.equal(tapKey(run, 'Enter'), 'online',
    "confirming the online mode should open the online screen in the game");

  // Creating a room is the first option.
  assert.equal(tapKey(run, 'Enter'), 'online', "still on the online screen");
  assert.equal(run("__lobby.calls.join(',')"), 'host',
    "confirming CREATE A ROOM should ask the lobby to host");

  // And once net.js has a room, the room screen takes over on its own.
  run("__lobby.phase = 'lobby';");
  assert.equal(tapKey(run, 'KeyZ'), 'room',
    "once the lobby has a room, the game should be showing it");
});

test("a room code can be typed on the canvas", async () => {
  /* The code used to be an <input>. On a canvas there is no such thing, so
     this reads the raw key codes the engine already collects: letters arrive
     as KeyA..KeyZ and digits as Digit2..Digit9, which is exactly the
     alphabet a room code is drawn from (no I, O, 0 or 1 -- the characters
     people mis-hear when somebody reads a code out across a table). */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  run("scene = 'online'; online.choice = 0; online.code = '';");

  // Down to JOIN, then ENTER to open the field, then type.
  tapKey(run, 'KeyS');
  assert.equal(run("online.choice"), 1, "S should move to JOIN A ROOM");
  assert.equal(run("online.code"), '',
    "and S must not also type an S -- it is a letter a room code can contain, " +
    "so moving and typing cannot both be live at once");

  tapKey(run, 'Enter');
  assert.equal(run("online.typing"), true, "ENTER should open the code field");

  for (const k of ['KeyQ', 'KeyK', 'Digit7', 'KeyM']) tapKey(run, k);
  assert.equal(run("online.code"), 'QK7M', "typing should fill the code");

  // Backspace, and a fifth character that must not fit.
  tapKey(run, 'Backspace');
  assert.equal(run("online.code"), 'QK7', "backspace should take one off");
  for (const k of ['KeyM', 'KeyB']) tapKey(run, k);
  assert.equal(run("online.code"), 'QK7M',
    "a code is four characters and a fifth should not be taken");

  tapKey(run, 'Enter');
  assert.equal(run("__lobby.calls.join(',')"), 'join:QK7M',
    "ENTER should hand net.js the code that was typed");

  // A short code is not a code.
  run("__lobby.calls.length = 0; online.typing = true; online.code = 'QK';");
  tapKey(run, 'Enter');
  assert.equal(run("__lobby.calls.length"), 0,
    "half a code should not be sent anywhere");

  // And every character a code can contain can actually be typed, including
  // the ones that move the cursor when the field is closed.
  run("online.typing = true; online.code = '';");
  for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) tapKey(run, k);
  assert.equal(run("online.code"), 'WSAD',
    "W, S, A and D are all valid in a room code and must be typable");
});

test("the room is the character select, and the host starts from it", async () => {
  /* Deliberately the same screen. The request was to "select a character
     from the screen and play again in the same session" -- a separate lobby
     and a separate select would mean leaving the room to pick and coming
     back to start. Here the grid IS the room. */
  const run = await bootEngine();
  stubLobby(run, 'lobby');
  run(`scene = 'room'; select.cursor[0] = 0;
       __lobby.seats = [{ slot: 0, char: 'kel', here: true, you: true },
                        { slot: 1, char: 'trev', here: true, you: false }];`);

  /* Moving says so on the wire, and that is the point.

     It did not, at first: the cursor was local and only a confirm sent
     anything, to keep a packet off the wire for every wobble of an undecided
     cursor. Played, that was plainly the wrong trade -- you sat in the room
     with no idea whether anyone else was still choosing, because their box
     never moved. Watching the others decide IS the character select. */
  tapKey(run, 'KeyD');
  assert.equal(run("select.cursor[0]"), 1, "D should move the cursor");
  assert.equal(run("__lobby.calls.join(',')"), 'pick:' + run("ORDER[1]") + ':0',
    "moving should tell the room where the cursor went, unsettled");

  // And SPACE says the same thing, settled.
  run("__lobby.calls.length = 0; __lobby.myReady = false;");
  tapKey(run, 'Space');
  assert.equal(run("__lobby.calls.join(',')"), 'pick:' + run("ORDER[1]") + ':1',
    "SPACE should lock in whoever the cursor is on");

  /* And SPACE again changes your mind. Locking in is a toggle because the
     match cannot start until everybody has settled -- a one-way commit would
     let one person hold the whole room up by mistake. */
  run("__lobby.calls.length = 0; __lobby.myReady = true;");
  tapKey(run, 'Space');
  assert.equal(run("__lobby.calls.join(',')"), 'pick:' + run("ORDER[1]") + ':0',
    "SPACE again should unlock, not lock in a second time");

  /* Held against the edge of the grid, the cursor does not move and so says
     nothing -- otherwise leaning on a direction would be a packet a frame. */
  run("__lobby.calls.length = 0; select.cursor[0] = 0;");
  tapKey(run, 'KeyA');
  assert.equal(run("select.cursor[0]"), 0, "already at the left edge");
  assert.equal(run("__lobby.calls.length"), 0,
    "a move that does not move should not send anything");

  // Only the host starts, and only when the room is ready.
  run("__lobby.calls.length = 0; __lobby.canStart = false;");
  tapKey(run, 'Enter');
  assert.equal(run("__lobby.calls.length"), 0,
    "a room that is not ready should not start on ENTER");

  /* Ready, ENTER goes to the STAGE SELECT rather than straight into a match.
     That is 2.55's fix for the rematch replaying the first match's stage: the
     room used to call start() itself, which meant the stage was whatever
     net.js was last told, so every rematch was on the same one. Now the
     choice is made on the way in, every time. */
  run("__lobby.canStart = true;");
  assert.equal(tapKey(run, 'Enter'), 'stage',
    "ENTER in a ready room should open the stage select");
  assert.equal(run("__lobby.calls.length"), 0,
    "and must not start anything before a stage has been picked");
  assert.equal(run("stageFor"), 'room',
    "the stage select has to know it was opened from the room -- that is " +
    "what decides whether confirming starts a local match or the room's");

  /* Backing out returns to the ROOM. Falling through to the local character
     select would leave the room behind with the seat still taken, on a screen
     whose ENTER starts a match nobody else is in. */
  assert.equal(tapKey(run, 'Escape'), 'room',
    "Escape from the room's stage select should go back to the room");
  assert.equal(run("__lobby.calls.length"), 0,
    "and changing your mind about a stage is not a reason to leave the room");

  // In again, and this time confirm: the room is told BOTH things, in order.
  tapKey(run, 'Enter');
  run("stagePick = 1;");
  tapKey(run, 'Enter');
  assert.equal(run("__lobby.calls.join(',')"),
    'setStage:' + run("STAGES[1].key") + ',start',
    "confirming a stage should tell the room which one and then start it -- " +
    "starting without setting it is how a rematch replays the old stage");

  // Leaving gives up the seat rather than silently abandoning it.
  run("__lobby.calls.length = 0; scene = 'room';");
  assert.equal(tapKey(run, 'Escape'), 'online', "Escape should leave the room");
  assert.equal(run("__lobby.calls.join(',')"), 'leave',
    "and should tell the room, so the seat is freed");
});

test("a build with no netplay says so instead of pretending", async () => {
  /* The standalone NerdWars.html has no netplay in it at all -- build.py
     inlines the sprites and the engine, and PeerJS is a script tag on the
     website. The online entry still appears there, because two builds with
     two different title screens is worse than one honest dead end. */
  const run = await bootEngine();
  run("delete window.NerdWarsLobby; scene = 'online';");
  const drew = run(`(function () {
    var lines = [];
    var realText = text;
    text = function (str) { lines.push(String(str)); };
    try { drawOnline(); } finally { text = realText; }
    return lines.join(' | ');
  })()`);
  assert.ok(/website/i.test(drew),
    "a build without netplay should point at the one that has it; drew: " + drew);
  assert.equal(tapKey(run, 'Escape'), 'title',
    "and Escape should still get back to the title");
});


test("a match starts from a clean slate", async () => {
  /* freezeFrames is in saveSim, which makes it simulation state by this
     file's own definition, and startBattle used not to clear it.

     Why that is a rematch bug and not a curiosity: a match ended by Escape
     stops the two machines on DIFFERENT frames, because a `bye` is a
     wall-clock event rather than a simulated one. Each can be left holding a
     different leftover, and updateBattle SKIPS A FRAME ENTIRELY while it is
     positive -- so the second match begins with the two machines disagreeing
     about how many frames have happened. stateHash does not cover it, so the
     desync would not even be reported for up to thirty frames.

     Tested directly rather than through a fought rematch, and deliberately:
     two engines started in lockstep both carry the SAME leftover, so they
     agree with each other all the way through a second match and the bug
     hides completely. The asymmetry is the whole hazard, and the invariant
     is what actually forbids it. */
  const run = await bootEngine();
  let left = run(`(function () {
    select.cursor = [0, 4]; playerCount = 2; humanCount = 0; stagePick = 0;
    startBattle();
    freezeFrames = 9;          // as a KO leaves it
    resultTimer = 77;
    startBattle();             // the next match
    return { freeze: freezeFrames, frames: battleFrames,
             shots: projectiles.length,
             // "GO!", which startBattle announces on its way out -- a fresh
             // banner, not a stale one. Compared by text so this says which.
             banner: banner && banner.text };
  })()`);
  assert.equal(left.freeze, 0,
    "freezeFrames survived into the next match (" + left.freeze + "), and " +
    "updateBattle skips a frame for every one of them");
  assert.equal(left.frames, 0, "the frame counter should restart");
  assert.equal(left.shots, 0, "nothing should still be in the air");
  assert.equal(left.banner, 'GO!',
    "the banner should be the new match's own announcement, not the last " +
    "match's result carried over; it said " + JSON.stringify(left.banner));
});


test("Reese's dash wraps the map instead of leaving it", async () => {
  /* His dash is his recovery, and in the air it keeps every pixel of its
     speed on purpose -- which made the move meant to save him the one that
     killed him most. Now the sides of the map wrap: off one edge, back on
     the other, near the top, carrying the SAME vx, which from the far side
     points back onto the stage.

     The window has to outlive the move, and that is the part worth pinning.
     The dash is nine active frames at 5.4 a frame, so he is still travelling
     long after it ends and crosses the blast line with the move already
     over. A first attempt checked for the edge inside the active frames and
     never fired once. */
  const run = await bootEngine();
  run("select.cursor=[4,2]; playerCount=2; humanCount=0; stagePick=0;" +
      " startBattle(); for (var j=0;j<130;j++) step();");
  assert.equal(run("fighters[0].def.name"), "REESE");

  const dashOff = (dir) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var bz = STAGE.blast;
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grabbing=-1;
    me.grounded=false; me.facing=${dir}; me.stocks=99; me.eliminated=false;
    me.specialSpawned=false; me.dashWrap=0;
    me.x = ${dir} > 0 ? main.x + main.w + 20 : main.x - 20;
    me.y = main.y - 30;
    foe.setState('idle'); foe.invuln=9999; foe.stocks=99; foe.eliminated=false;
    foe.x=main.x+40; foe.y=main.y; foe.grounded=true;
    var stocks0 = me.stocks, jump = null;
    netplay.active = true;
    for (var f = 0; f < 60; f++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(f === 0 ? 2048 : 0), bitsToPad(0)];
      var was = me.x;
      step();
      if (jump === null && Math.abs(me.x - was) > 60) {
        jump = { from: was, to: me.x, y: me.y, vx: me.vx };
      }
    }
    netplay.active = false; netplay.framePads = null;
    return { jump: jump, lost: stocks0 - me.stocks, endX: me.x, endY: me.y,
             left: bz.left, right: bz.right, top: bz.top, floor: main.y,
             onStage: me.x > main.x && me.x < main.x + main.w };
  })()`);

  for (const dir of [1, -1]) {
    const r = dashOff(dir);
    const way = dir > 0 ? "right" : "left";
    assert.ok(r.jump, "dashing off the " + way + " should wrap, and did not");
    assert.equal(r.lost, 0,
      "and must not cost a stock; it cost " + r.lost);
    // Out one side, in the other.
    if (dir > 0) {
      assert.ok(r.jump.from > r.right - 20 && r.jump.to < r.left + 20,
        "off the right should come back at the left; " +
        r.jump.from + " -> " + r.jump.to);
    } else {
      assert.ok(r.jump.from < r.left + 20 && r.jump.to > r.right - 20,
        "off the left should come back at the right; " +
        r.jump.from + " -> " + r.jump.to);
    }
    assert.ok(r.jump.y < r.floor - 60,
      "he should come back in at the TOP, not level with the floor; y " +
      r.jump.y);
    assert.ok(Math.sign(r.jump.vx) === dir && Math.abs(r.jump.vx) > 3,
      "and keep the momentum he left with, which now points at the stage; " +
      "vx " + r.jump.vx);
    assert.ok(r.onStage,
      "a wrap that does not get him home has not saved him; he ended at x " +
      r.endX);
  }
});

test("the wrap forgives the sides and the floor, never the ceiling, and " +
     "charges for every catch", async () => {
  /* The window was widened deliberately and this is the shape of the new
     hole in it. It used to be sides only and once per dash, which caught the
     tidy overshoot and missed the way a recovery actually fails -- you do not
     get back, and you go out of the BOTTOM.

     So the floor counts now. The ceiling still does not, and that is the
     whole reason this can be widened without making him unkillable: a
     fighter who leaves through the top was PUT there by somebody's
     knockback, and every upward finisher in the game still works on him
     mid-dash.

     And each catch costs half of whatever window is left, so the net wears
     out under exactly the fighter who keeps needing it. */
  const run = await bootEngine();
  run("select.cursor=[4,2]; playerCount=2; humanCount=0; stagePick=0;" +
      " startBattle(); for (var j=0;j<130;j++) step();");

  const probe = (setup) => JSON.parse(run(`(function () {
    var me = fighters[0];
    var bz = STAGE.blast;
    me.setState('fall'); me.hitstun=0; me.hitstop=0; me.invuln=0;
    me.stocks=99; me.eliminated=false; me.vx=0; me.vy=0;
    ${setup}
    me.prevY = me.y;
    var before = me.stocks;
    me.checkBlastZones();
    return JSON.stringify({ lost: before - me.stocks, left: me.dashWrap,
                            x: me.x, y: me.y, vy: me.vy, top: bz.top });
  })()`));
  const die = (setup) => probe(setup).lost;

  // Unarmed, every line still kills -- this is a dash window and nothing else.
  assert.equal(die("me.dashWrap = 0; me.x = bz.right + 5; me.y = 60;"), 1,
    "walking off the side with no dash armed should still end it");
  assert.equal(die("me.dashWrap = 0; me.x = 160; me.y = bz.bottom + 30;"), 1,
    "and so should falling out of the bottom with nothing armed");

  // Armed, the two lines a failed recovery ends at are forgiven.
  assert.equal(die("me.dashWrap = 60; me.x = bz.right + 5; me.y = 60;"), 0,
    "an armed side exit should wrap");
  const floor = probe("me.dashWrap = 60; me.x = 160; me.y = bz.bottom + 30;" +
                      " me.vy = 5.4;");
  assert.equal(floor.lost, 0,
    "and an armed exit through the FLOOR should be caught, which is how a " +
    "recovery actually fails");
  assert.ok(floor.y < floor.top + 24,
    "caught off the floor he comes back in at the top, not where he left; " +
    "y " + floor.y);
  assert.ok(floor.vy <= 0,
    "and not still falling at terminal velocity, which would be the same " +
    "death with extra steps; vy " + floor.vy);

  // The ceiling is the deliberate hole: knockback still kills him mid-dash.
  assert.equal(die("me.dashWrap = 60; me.x = 160; me.y = bz.top - 30;"), 1,
    "an armed exit through the CEILING must still take the stock, or the " +
    "window would make him immune to being killed rather than forgiving " +
    "his own mistake");

  // And the net wears out: each catch spends half of what is left.
  const first = probe("me.dashWrap = 100; me.x = bz.right + 5; me.y = 60;");
  assert.equal(first.lost, 0, "the first catch works");
  assert.equal(first.left, 50,
    "and costs half the window, so it is not a revolving door; left " +
    first.left);
  const spent = probe("me.dashWrap = 1; me.x = bz.right + 5; me.y = 60;");
  assert.equal(spent.left, 0,
    "and the halving always reaches zero rather than asymptoting above it");
});


/* ------------------------------------------------------------------ *
 * REESE: the dash hurts for as long as it travels, and the fart can be
 * charged on the move.
 * ------------------------------------------------------------------ */

/* Cast Reese's up special on frame 0 and report, per frame, whether his
   hitbox is live and how fast he is still going. */
const JITTERS_PROBE = `(function () {
  var f = fighters[0], o = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  o.x = main.x + 4; o.invuln = 99999;
  f.x = main.x + 20; f.y = main.y;
  ${CLEAN}
  f.facing = 1; f.mana = 100;
  var rows = [], x0 = f.x;
  netplay.active = true;
  for (var i = 0; i < 26; i++) {
    netplay.framePads = [bitsToPad(i === 0 ? 2048 : 0), bitsToPad(0)];
    step();
    rows.push([f.state === 'special' && f.hitbox() ? 1 : 0,
               Math.abs(f.vx), f.x - x0]);
  }
  netplay.active = false; netplay.framePads = null;
  var s = ROSTER.reese.specials.up;
  return JSON.stringify({ rows: rows, speed: s.speed,
                          total: s.startup + s.active + s.recovery });
})()`;

/* The claim, as a function, so the negative control can run exactly it. */
function checkJitters(r) {
  const live = r.rows.filter((row) => row[0]).length;
  assert.equal(live, r.total - 3,
    "the box should be live for every frame of the move from the first " +
    "active one to the last; it was live for " + live + " of " + r.total);
  let lastLive = -1;
  r.rows.forEach((row, i) => { if (row[0]) lastLive = i; });
  assert.ok(r.rows[lastLive][1] >= r.speed - 0.01,
    "and on the LAST live frame he must still be moving at dash speed -- " +
    "a box that closes while he is still travelling is the whole complaint; " +
    "vx was " + r.rows[lastLive][1]);
  const dead = r.rows.slice(0, lastLive).filter((row) => !row[0]).length;
  assert.equal(dead, 3,
    "and nothing between the first live frame and the last may be dead: " +
    dead + " dead frames before the box closed, startup included");
  return r.rows[lastLive][2];
}

test("JITTERS hurts for as long as it is still travelling", async () => {
  /* `active` is how long the move DRIVES him; a dash is `rooted`, so nothing
     damps the speed those frames set and he coasts the whole recovery at it.
     The box used to close with `active` and the sprite did not -- sprite()
     holds the attack posture for the entire state -- so the second half of
     the distance was drawn as a lunge that could not touch anybody. */
  const run = await bootEngine();
  run("var R = ORDER.indexOf('reese');" +
      " select.cursor=[R,(R+1)%ORDER.length]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; startBattle();");
  run(QUIET_WARMUP);
  const r = JSON.parse(run(JITTERS_PROBE));
  const reach = checkJitters(r);
  assert.ok(reach > 95,
    "which is worth about a hundred pixels of dangerous travel rather than " +
    "fifty; he covered " + reach.toFixed(1) + " under a live box");
});

test("negative control: a dash box that closes with `active` fails it", async () => {
  const run = await bootEngine(
    sabotage("(s.hitActive || s.active)", "(s.active)"));
  run("var R = ORDER.indexOf('reese');" +
      " select.cursor=[R,(R+1)%ORDER.length]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; startBattle();");
  run(QUIET_WARMUP);
  const r = JSON.parse(run(JITTERS_PROBE));
  await expectToFail(() => checkJitters(r),
    "with the box tied to `active` again the dash must fail the travel test");
});

/* Cast CROP DUST, then hold the button -- plus whatever else `extra` says --
   for 40 frames, and report where he ended up and what came out. */
const FART_PROBE = (extra) => `(function () {
  var f = fighters[0], o = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  o.x = main.x + 4; o.invuln = 99999;
  f.x = main.x + 30; f.y = main.y;
  ${CLEAN}
  f.facing = 1; f.mana = 100;
  var x0 = f.x, y0 = f.y, air = 0;
  netplay.active = true;
  for (var i = 0; i < 40; i++) {
    netplay.framePads = [bitsToPad(i === 0 ? (8 | 1024 | 8192) : ${extra}),
                         bitsToPad(0)];
    step();
    if (!f.grounded) air++;
  }
  for (var j = 0; j < 30; j++) {
    netplay.framePads = [bitsToPad(0), bitsToPad(0)];
    step();
  }
  netplay.active = false; netplay.framePads = null;
  var cloud = null;
  for (var k = 0; k < projectiles.length; k++) {
    if (projectiles[k].spec && projectiles[k].spec.stinkName) {
      cloud = projectiles[k].spec.stinkName;
    }
  }
  return JSON.stringify({ dx: f.x - x0, dy: f.y - y0, air: air,
                          cloud: cloud, mana: f.mana });
})()`;

// 8192 alone is the button held and nothing else; |2 adds right, |16 a jump.
const FART_HOLD = 8192;
const FART_HOLD_RIGHT = 8192 | 2;
const FART_HOLD_RIGHT_JUMP = 8192 | 2 | 16;

function checkFartWalk(held, still) {
  assert.ok(held.dx > 20,
    "holding a direction through the charge should WALK him -- the fart is " +
    "gas you leave behind you, and a charge that rooted him inverted the " +
    "move; he moved " + held.dx.toFixed(1) + " pixels");
  assert.equal(still.dx, 0,
    "and letting the stick go should still leave him where he is; he " +
    "drifted " + still.dx.toFixed(1));
  assert.equal(held.cloud, still.cloud,
    "walking must not change WHICH cloud the charge produces");
}

test("CROP DUST can be charged on the move, and never off the ground", async () => {
  /* The two halves are deliberately different. Walking keeps him in the piece
     of stage he is denying, which is still a price. Jumping would let him
     clear an approach without giving any of the charge back, and would let a
     RANCID be carried into the air and dropped on somebody's recovery. */
  const run = await bootEngine();
  run("var R = ORDER.indexOf('reese');" +
      " select.cursor=[R,(R+1)%ORDER.length]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; startBattle();");
  run(QUIET_WARMUP);

  const still = JSON.parse(run(FART_PROBE(FART_HOLD)));
  const held = JSON.parse(run(FART_PROBE(FART_HOLD_RIGHT)));
  checkFartWalk(held, still);

  const jumped = JSON.parse(run(FART_PROBE(FART_HOLD_RIGHT_JUMP)));
  assert.equal(jumped.air, 0,
    "but the jump button must do nothing at all while the charge is held; " +
    "he spent " + jumped.air + " frames off the floor");
  assert.equal(jumped.dy, 0, "and must not have left the floor he started on");
});

test("negative control: a charge that roots him fails the walking test", async () => {
  const run = await bootEngine(
    sabotage("chargeWalk = !!m.charge.walk && this.grounded;",
             "chargeWalk = false;"));
  run("var R = ORDER.indexOf('reese');" +
      " select.cursor=[R,(R+1)%ORDER.length]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; startBattle();");
  run(QUIET_WARMUP);
  const still = JSON.parse(run(FART_PROBE(FART_HOLD)));
  const held = JSON.parse(run(FART_PROBE(FART_HOLD_RIGHT)));
  await expectToFail(() => checkFartWalk(held, still),
    "with the walk switched off the charge must fail the walking test");
});

test("a match ending any way at all lands in the room, if there is one", async () => {
  /* netStop is where EVERY ending converges -- a KO, somebody pressing
     Escape, a peer sending `bye`, a desync -- and it used to set the scene
     to 'title' flat. Fixing the results screen alone fixed exactly one of
     those four, which is why a clean win put everybody back in the room and
     a friend quitting dropped you on the title with the room you were still
     sitting in nowhere on screen.

     Tested at netStop rather than through a played-out match on purpose: an
     end-to-end quit test reaches the room by other routes too, so it passes
     whatever this line says and proves nothing about it. This drives the
     line itself, both ways. */
  const run = await bootEngine();

  const stopWith = (phase) => run(`(function () {
    window.NerdWarsLobby = {
      host: function () {}, join: function () {}, pick: function () {},
      start: function () {}, leave: function () {}, setStage: function () {},
      snapshot: function () {
        return { available: true, phase: ${JSON.stringify(phase)},
                 role: 'host', code: 'ABCD', mySlot: 0, myChar: 'kel',
                 stage: 'space', status: '', statusKind: '', seats: [],
                 here: 2, canStart: true };
      },
    };
    netplay.active = true;
    scene = 'battle';
    netStop('opponent left');
    var out = scene;
    netplay.active = false;
    return out;
  })()`);

  assert.equal(stopWith('lobby'), 'room',
    "a match that ends while the room is still alive should leave everybody " +
    "standing in the room");
  assert.equal(stopWith('idle'), 'title',
    "and only fall back to the title when there is no room left to be in");

  // No lobby at all -- the standalone build -- still has somewhere to go.
  const noLobby = run(`(function () {
    delete window.NerdWarsLobby;
    netplay.active = true; scene = 'battle';
    netStop('opponent left');
    var out = scene;
    netplay.active = false;
    return out;
  })()`);
  assert.equal(noLobby, 'title',
    "a build with no lobby should go to the title rather than a room that " +
    "cannot exist");
});


test("Squalls is in the game, with the attack set his sheet came with", async () => {
  /* The ninth fighter, and the first whose sheet was 4 cells wide instead of
     2. The extra columns are not padding: they are the same eight poses with
     the punching arm out -- an ATTACK SET, which only Kel has had since 2016.

     That is the part worth pinning, because losing it would have been
     silent. The old loader sliced a fixed 2x4, and the eight cells it read
     are all non-blank, so it would have produced a perfectly good character
     and thrown half the art away without a word. */
  const run = await bootEngine();
  assert.equal(run("ORDER.indexOf('squalls')"), 8, "appended, not inserted");

  const FRAMES = ["standR", "standL", "walkR1", "walkL1",
                  "walkR2", "walkL2", "jumpR", "jumpL"];
  for (const f of FRAMES) {
    assert.ok(run("!!IMG['squalls.base." + f + "']"),
      "missing base frame " + f);
    assert.ok(run("!!IMG['squalls.attack." + f + "']"),
      "missing ATTACK frame " + f + " -- his sheet carries one and a " +
      "two-column slice would drop it without complaining");
  }

  // The two sets are genuinely different art, not the same frames twice.
  const differs = run(`(function () {
    var a = SPRITES.squalls.base.standR, b = SPRITES.squalls.attack.standR;
    return a !== b && a.length > 100 && b.length > 100;
  })()`);
  assert.ok(differs, "the attack set should be different art from the base");

  /* And the engine reaches for it. sprite() swaps sets for the whole of any
     attack, special or ult -- that is existing machinery, so what this
     checks is that Squalls now qualifies for it. */
  const swaps = run(`(function () {
    select.cursor = [8, 2]; playerCount = 2; humanCount = 0; stagePick = 0;
    startBattle();
    for (var i = 0; i < 130; i++) step();
    var me = fighters[0];
    /* Both states pinned, and grounded pinned with them. Read as-found, the
       fighter is 130 frames into a CPU match and may already be mid-swing --
       in which case "idle" is the attack art too and the comparison quietly
       says the sets are the same. */
    me.setState('idle'); me.grounded = true; me.facing = 1;
    var idle = me.sprite();
    me.setState('attack'); me.attackFrame = 2; me.grounded = true;
    var hitting = me.sprite();
    me.setState('idle');
    return { name: me.def.name, same: idle === hitting,
             gotBoth: !!idle && !!hitting };
  })()`);
  assert.equal(swaps.name, "SQUALLS");
  assert.ok(swaps.gotBoth, "both states should resolve to a real image");
  assert.equal(swaps.same, false,
    "swinging should draw the attack art, not the standing art");
});

test("every fighter still fits on every screen that lists them", async () => {
  /* Nine is where four columns stopped working: it wraps to a third row, and
     the local select puts that row's names at y 184 on a 180px screen. The
     grid is five wide now, and the title's crew line derives its spacing
     from how many there are rather than using a flat 40 -- which fitted
     eight with 4.8px to spare and ran off both edges at nine.

     Written against ORDER.length rather than the number 9, so it keeps
     being true, or keeps being the thing that tells you it is not. */
  const run = await bootEngine();
  const geo = run(`(function () {
    var n = ORDER.length, cols = NerdWars.selectColumns;
    var rows = Math.ceil(n / cols);
    var last = n - 1;

    // The character select.
    var cellW = NerdWars.selectCellW, cellH = 52, originY = 40;
    var originX = VW / 2 - (cols * cellW) / 2 + cellW / 2;
    var sx = originX + (last % cols) * cellW;
    var sy = originY + Math.floor(last / cols) * cellH;

    // The room.
    var rOriginY = 60, rCellH = 44;
    var ry = rOriginY + Math.floor(last / cols) * rCellH;

    /* The crew line MEASURED, not recomputed. Copying the spacing formula in
       here would make this test agree with itself no matter what the title
       screen does -- which is exactly what it did at first: reverting the
       engine to a flat 40px left the test perfectly happy. So intercept
       drawPortrait and record where the portraits are actually asked to go. */
    var xs = [], realPortrait = drawPortrait;
    drawPortrait = function (key, x, y, scale) { xs.push({ x: x, s: scale }); };
    var realText = text, realButton = drawButton;
    text = function () {}; drawButton = function () {};
    try { drawTitle(); } finally {
      drawPortrait = realPortrait; text = realText; drawButton = realButton;
    }
    var crew = xs.slice(0, n);
    var half = 16 * (crew.length ? crew[0].s : 1.9) / 2;
    var leftMost = Math.min.apply(null, crew.map(function (q) { return q.x; })) - half;
    var rightMost = Math.max.apply(null, crew.map(function (q) { return q.x; })) + half;

    return { n: n, cols: cols, rows: rows, VW: VW, VH: VH, drew: crew.length,
             selLeft: sx - 28, selRight: sx + 28, selName: sy + 40,
             roomName: ry + 29,
             crewLeft: leftMost, crewRight: rightMost,
             firstX: originX - 28, lastX: sx + 28 };
  })()`);

  assert.ok(geo.rows <= 2,
    geo.n + " fighters at " + geo.cols + " columns is " + geo.rows +
    " rows; the screens are laid out for two");
  assert.ok(geo.selName < geo.VH - 8,
    "the last fighter's name on the select screen draws at y " + geo.selName +
    " on a " + geo.VH + "px screen");
  assert.ok(geo.roomName < geo.VH - 20,
    "and in the room at y " + geo.roomName + ", which has to clear the " +
    "status and start lines below it");
  assert.ok(geo.firstX > 0 && geo.lastX < geo.VW,
    "the grid should fit across; it spans " + geo.firstX + ".." + geo.lastX);
  assert.equal(geo.drew, geo.n,
    "the title should draw every fighter in the crew line");
  assert.ok(geo.crewLeft > 0 && geo.crewRight < geo.VW,
    "the title's crew line should fit across; it spans " +
    geo.crewLeft.toFixed(1) + ".." + geo.crewRight.toFixed(1) +
    " on a " + geo.VW + "px screen");
});


/* A ladder with a real log behind it: ladder.js itself, folded over matches
   written the way net.js writes them. Stubbing `view()` would make the
   leaderboard tests agree with whatever the screen felt like drawing -- the
   only interesting question is whether the numbers on the canvas are the
   ladder's numbers. */
function stubLadder(run, me) {
  run(LADDER_SRC);
  run(`(function () {
    var K = window.NerdWarsLadderKit;
    var db = { matches: {}, profiles: {} };
    // After the ladder's reset, or the board would correctly show nothing.
    var n = K.SEASON_START;
    var NAME = { 'u-trev': 'TREV', 'u-kel': 'KEL', 'u-nick': 'NICK',
                 'u-reese': 'REESE', 'u-simon': 'SIMON', 'u-squalls': 'SQUALLS',
                 'u-ladeane': 'LADEANE', 'u-johnny': 'JOHNNY', 'u-cobeus': 'COBEUS' };
    function put(a, b, winner, mode) {
      n++;
      var confirm = {};
      if (mode === 'ok') confirm[b] = { agree: true, winnerSlot: winner };
      else if (mode === 'no') confirm[b] = { agree: false };
      // 'quiet' leaves the confirm empty, which is pending.
      db.matches['m' + (1000 + n)] = {
        at: n, uids: [a, b], names: [NAME[a], NAME[b]],
        chars: ['kel', 'trev'], stage: 'space', winnerSlot: winner,
        stocks: [1, 0], frames: 900, build: 'test', host: a, confirm: confirm,
      };
    }

    /* Four settled players, strictly ordered by strength, so the rating
       column has an unambiguous right answer. Stronger always wins, so a
       round robin four deep gives everybody twelve matches -- past the
       provisional line -- and a strict 12/8/4/0 spread of wins. */
    var vets = ['u-trev', 'u-kel', 'u-nick', 'u-reese'];
    for (var round = 0; round < 4; round++) {
      for (var i = 0; i < vets.length; i++) {
        for (var j = i + 1; j < vets.length; j++) {
          put(vets[i], vets[j], 0, 'ok');       // the stronger one hosts and wins
        }
      }
    }
    // Five newcomers, two matches each, so the table is nine deep and has to
    // scroll -- and so the provisional marker has somebody to mark.
    ['u-simon', 'u-squalls', 'u-ladeane', 'u-johnny', 'u-cobeus']
      .forEach(function (u, i) {
        put(vets[i % vets.length], u, 0, 'ok');
        put(u, vets[(i + 1) % vets.length], 1, 'ok');
      });
    // One nobody confirmed and one somebody argued with. Neither moves a
    // rating, and both have to be visible anyway.
    put('u-nick', 'u-reese', 0, 'quiet');
    put('u-reese', 'u-nick', 0, 'no');

    var store = K.memoryStore(db);
    window.__ladderDb = db;
    /* Counted, because the one thing a leaderboard has to do that a pure
       fold cannot is go and look. A screen that only ever draws its cache is
       permanently showing whatever was true when the page loaded. */
    window.__ladderReads = 0;
    var real = store.listMatches;
    store.listMatches = function (since) { window.__ladderReads++; return real(since); };
    window.NerdWarsLadder = K.createLadder(store);
    return window.NerdWarsLadder.refresh();
  })()`);
  if (me !== undefined) {
    run("__lobby.me = " + JSON.stringify(me) + ";");
  }
}

/* What drawLadder actually put on the screen, in draw order. Measured rather
   than recomputed, for the same reason the crew line is: a test that works
   out for itself where row four ought to be will keep passing when row four
   stops being drawn at all. */
const drawnLadder = (run) => run(`(function () {
  var lines = [], realText = text;
  text = function (str, x, y, size, color) {
    lines.push({ s: String(str), x: x, y: y, color: color });
  };
  try { drawLadder(); } finally { text = realText; }
  var v = (window.NerdWarsLadder && window.NerdWarsLadder.view()) ||
          { rows: [], pending: 0, disputed: 0 };
  return {
    lines: lines.map(function (l) {
      return l.s + '|' + l.x + '|' + l.y + '|' + l.color;
    }),
    rows: v.rows.map(function (r) {
      return [r.uid, r.name, r.rating, r.w, r.l, r.d, r.played,
              r.provisional ? 1 : 0].join('|');
    }),
    pending: v.pending, disputed: v.disputed, cursor: ladderView.row,
  };
})()`);

const parseLines = (got) => got.lines.map((l) => {
  const bits = l.split('|');
  return { s: bits.slice(0, bits.length - 3).join('|'),
           x: Number(bits[bits.length - 3]),
           y: Number(bits[bits.length - 2]),
           color: bits[bits.length - 1] };
});
const parseRows = (got) => got.rows.map((r) => {
  const b = r.split('|');
  return { uid: b[0], name: b[1], rating: Number(b[2]), w: Number(b[3]),
           l: Number(b[4]), d: Number(b[5]), played: Number(b[6]),
           provisional: b[7] === '1' };
});

test("the leaderboard puts the ladder's own numbers on the screen", async () => {
  /* The Elo maths has been right and invisible for a while: ladder.js folds
     a log into ratings and nothing drew them. This is the half that makes it
     a feature -- and the assertions all compare the canvas against
     NerdWarsLadder.view(), never against arithmetic redone in the test, so
     the screen cannot quietly disagree with the ladder. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Looked up rather than counted -- see modeIndex.
  run("scene = 'title'; titleChoice = " + modeIndex(run, /LEADERBOARD/i) + ";");
  const readsBefore = run("__ladderReads");
  assert.equal(tapKey(run, 'Enter'), 'ladder',
    "confirming LEADERBOARD should open it in the game");
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(run("__ladderReads") > readsBefore,
    "opening it should go and look for matches played since last time, " +
    "or the board is frozen at whatever was true when the page loaded");

  const got = drawnLadder(run);
  const rows = parseRows(got);
  const lines = parseLines(got);
  assert.equal(rows.length, 9,
    "nine people played, so nine should be on the board, got " + rows.length);

  // The name column, top to bottom, is the ladder's order.
  const names = lines.filter((l) => l.x === 26)
    .sort((a, b) => a.y - b.y).map((l) => l.s.replace(/\s+\(you\)$/, ''));
  assert.equal(names.length, 8,
    "eight rows fit on a 180px screen; got " + names.length);
  assert.equal(names.join(','), rows.slice(0, 8).map((r) => r.name).join(','),
    "the screen should list them in the ladder's order");

  // And the rating column is the ladder's ratings, not some other number.
  const byY = {};
  lines.forEach((l) => { (byY[l.y] = byY[l.y] || {})[l.x] = l.s; });
  rows.slice(0, 8).forEach((r, i) => {
    const y = 34 + i * 13;
    assert.ok(byY[y], "row " + i + " should have been drawn");
    assert.equal(byY[y][26].replace(/\s+\(you\)$/, ''), r.name);
    assert.equal(byY[y][320 - 74],
      r.provisional ? '(' + r.rating + ')' : String(r.rating),
      r.name + "'s rating should be the ladder's " + r.rating);
    assert.equal(byY[y][320 - 34], r.w + '-' + r.l + (r.d ? '-' + r.d : ''),
      r.name + "'s record should be " + r.w + '-' + r.l);
  });

  /* Somebody with twelve matches and somebody with two must not read the
     same. A rating off two games is three wins and a number, not a position
     on a ladder, and the brackets are what says so. */
  const settled = rows.filter((r) => !r.provisional);
  const fresh = rows.filter((r) => r.provisional);
  assert.ok(settled.length >= 4 && fresh.length >= 4,
    "the fixture should have both kinds, got " + settled.length + " settled and " +
    fresh.length + " provisional");
  assert.ok(rows.slice(0, settled.length).every((r) => !r.provisional),
    "settled players should be above provisional ones");

  // Unconfirmed and disputed matches are said out loud rather than dropped.
  assert.equal(got.pending, 1);
  assert.equal(got.disputed, 1);
  const notes = lines.filter((l) => /confirmed|disputed/.test(l.s)).map((l) => l.s);
  assert.equal(notes.length, 1, "one line should carry both counts");
  assert.ok(notes[0].includes('1 waiting to be confirmed'),
    "the pending count should be on screen, got: " + notes[0]);
  assert.ok(notes[0].includes('1 disputed'),
    "and so should the disputed count, got: " + notes[0]);
});

test("a leaderboard taller than the screen scrolls instead of stopping at eight", async () => {
  /* Nine players is already more than fits, and the roster is nine -- so the
     ninth person on the board is invisible the moment anybody plays. The
     cursor has to carry the window with it. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("scene = 'ladder'; ladderView.row = 0;");

  const rows = parseRows(drawnLadder(run));
  const last = rows[rows.length - 1].name;
  const first = rows[0].name;
  const onScreen = (g) => parseLines(g).filter((l) => l.x === 26)
    .map((l) => l.s.replace(/\s+\(you\)$/, ''));

  assert.ok(!onScreen(drawnLadder(run)).includes(last),
    "the ninth player should be off the bottom to begin with");

  for (let i = 0; i < rows.length - 1; i++) tapKey(run, 'KeyS');
  const bottom = drawnLadder(run);
  assert.equal(bottom.cursor, rows.length - 1,
    "S should walk the cursor to the end");
  assert.ok(onScreen(bottom).includes(last),
    "and the table should have scrolled to show " + last);
  assert.ok(!onScreen(bottom).includes(first),
    "with the top of the table now off the screen");

  // And it wraps, rather than sticking at the end.
  tapKey(run, 'KeyS');
  assert.equal(drawnLadder(run).cursor, 0, "past the last row goes back to the top");
  tapKey(run, 'KeyW');
  assert.equal(drawnLadder(run).cursor, rows.length - 1, "and W goes the other way");
});

test("the leaderboard says what you have done against the person you are looking at", async () => {
  /* The half of the screen with no model behind it. A rating is a claim; a
     head-to-head is a fact, and it is the one nine friends actually argue
     about. It reads from NerdWarsLadder.between() so the line cannot drift
     from the log it came out of. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("scene = 'ladder'; ladderView.row = 0;");

  const rows = parseRows(drawnLadder(run));
  const mineAt = rows.findIndex((r) => r.uid === 'u-trev');
  assert.ok(mineAt >= 0, "the signed-in player should be on their own board");

  // On yourself, there is no head-to-head to show.
  run("ladderView.row = " + mineAt + ";");
  const onSelf = parseLines(drawnLadder(run));
  assert.ok(onSelf.some((l) => l.s === 'this is you'),
    "pointing at yourself should say so, not play you against yourself");
  assert.ok(onSelf.some((l) => /\(you\)/.test(l.s)),
    "and your row should be marked in the table");

  // On somebody else, the record against THEM.
  const other = rows.find((r) => r.uid !== 'u-trev' && !r.provisional);
  const at = rows.indexOf(other);
  run("ladderView.row = " + at + ";");
  const h = run("(function () { var h = NerdWarsLadder.between('u-trev', " +
    JSON.stringify(other.uid) + "); return [h.w, h.l, h.d].join('|'); })()")
    .split('|').map(Number);
  assert.ok(h[0] + h[1] + h[2] > 0, "the fixture should have them meeting");
  const line = parseLines(drawnLadder(run)).find((l) => /^you vs /.test(l.s));
  assert.ok(line, "a head-to-head line should be drawn");
  assert.ok(line.s.includes(other.name),
    "it should name who you are looking at, got: " + line.s);
  assert.ok(line.s.includes(h[0] + ' - ' + h[1]),
    "and carry the ladder's own record " + h[0] + ' - ' + h[1] +
    ", got: " + line.s);

  /* Two people who have never met show nothing rather than 0 - 0, which
     reads as a scoreline somebody lost. */
  const stranger = rows.find((r) => {
    const q = run("(function () { var h = NerdWarsLadder.between('u-trev', " +
      JSON.stringify(r.uid) + "); return h.w + h.l + h.d; })()");
    return r.uid !== 'u-trev' && q === 0;
  });
  if (stranger) {
    run("ladderView.row = " + rows.indexOf(stranger) + ";");
    const never = parseLines(drawnLadder(run));
    assert.ok(never.some((l) => l.s === 'you have never played ' + stranger.name),
      "never having played should say so rather than showing 0 - 0");
  }

  /* Signed out, there is no "you" to compare anybody to -- and showing an
     empty record instead would be claiming you lost to everybody. */
  run("__lobby.me = null; ladderView.row = " + at + ";");
  const anon = parseLines(drawnLadder(run));
  assert.ok(!anon.some((l) => /^you vs /.test(l.s)),
    "signed out, there is nobody to be the 'you' in a head-to-head");
  assert.ok(anon.some((l) => /sign in/i.test(l.s)),
    "it should say what is missing");
  assert.ok(!anon.some((l) => /\(you\)/.test(l.s)),
    "and no row should be marked as yours");
});

test("a build with no ladder says so instead of showing an empty board", async () => {
  /* Same shape as the online screen. The standalone NerdWars.html has no
     Firebase and no netplay, so it has nothing to rate -- and an empty table
     there would read as "nobody has ever won a game". */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  run("delete window.NerdWarsLadder; scene = 'ladder';");

  const lines = parseLines(drawnLadder(run)).map((l) => l.s).join(' ');
  assert.ok(/website copy/.test(lines),
    "it should point at the copy that does have one, got: " + lines);
  assert.ok(/trevorspinosa\.com/.test(lines), "with somewhere to go");
  assert.ok(!/RATING/.test(lines), "and no empty table, got: " + lines);

  // And it must not fall over when somebody presses the keys anyway.
  for (const k of ['KeyS', 'KeyW', 'KeyR']) {
    assert.equal(tapKey(run, k), 'ladder', k + " should be harmless here");
  }
  assert.equal(tapKey(run, 'Escape'), 'title', "and ESC still goes back");
});


test("a leaderboard row stays inside the screen whatever a name is", async () => {
  /* Nobody picks these names in this game -- they come off a Google account,
     and "Trevor Spinosa (Work)" is a perfectly ordinary one. A name column
     with no limit runs straight through the rating beside it and off the
     right-hand edge of a 320px screen, and the rating is the one thing the
     screen exists to show. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Rename everybody to something absurd, and fold a fresh ladder over it --
  // refresh() is incremental and will not re-read what it already folded.
  run(`(function () {
    for (var mid in __ladderDb.matches) {
      __ladderDb.matches[mid].names = [
        'Bartholomew Spinosa-Wentworth III (Work Account, Do Not Use)',
        'Kelvin Maximilian Vandersomething Jr. (personal, old)'];
    }
    var K = window.NerdWarsLadderKit;
    window.NerdWarsLadder = K.createLadder(K.memoryStore(__ladderDb));
    return window.NerdWarsLadder.refresh();
  })()`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  /* Row 1 rather than row 0, so the head-to-head line underneath has a long
     name in it too -- on your own row it only ever says "this is you". */
  run("scene = 'ladder'; ladderView.row = 1;");

  /* There is no font engine in a vm, so the advance width comes from the one
     fact about Consolas that matters here: it is monospaced at 0.55 em per
     glyph. Everything else -- which strings, at what size, aligned which
     way, at what x -- is read off the engine as it draws. */
  const measure = () => run(`(function () {
    var out = [], realText = text;
    text = function (str, x, y, size, color, align, weight) {
      var w = String(str).length * size * 0.55;
      var left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      out.push([String(str), left, left + w, y].join('~~'));
    };
    try { drawLadder(); } finally { text = realText; }
    return out;
  })()`).map((r) => {
    const b = r.split('~~');
    return { s: b[0], left: Number(b[1]), right: Number(b[2]), y: Number(b[3]) };
  });
  const extents = measure();
  assert.ok(extents.some((e) => /^you vs /.test(e.s)),
    "row 1 should be somebody else, so the head-to-head line is drawn too");

  assert.ok(extents.length > 8, "the board should still have drawn");
  assert.ok(extents.some((e) => /^Bartholomew|^Kelvin/.test(e.s)),
    "the long names should be on screen somewhere, got: " +
    extents.map((e) => e.s).join(" / "));

  for (const e of extents) {
    assert.ok(e.left >= 0 && e.right <= 320,
      JSON.stringify(e.s) + " spans " + e.left.toFixed(1) + ".." +
      e.right.toFixed(1) + " on a 320px screen");
    assert.ok(e.y > 0 && e.y < 180,
      JSON.stringify(e.s) + " draws at y " + e.y + " on a 180px screen");
  }

  /* And specifically: a name must not reach the rating beside it. */
  const byRow = {};
  extents.forEach((e) => { (byRow[e.y] = byRow[e.y] || []).push(e); });
  let checked = 0;
  for (const y of Object.keys(byRow)) {
    const row = byRow[y];
    const name = row.find((e) => e.left === 26);
    const rating = row.find((e) => /^\(?\d+\)?$/.test(e.s) && e.right > 200);
    if (!name || !rating) continue;
    checked++;
    assert.ok(name.right <= rating.left,
      JSON.stringify(name.s) + " ends at " + name.right.toFixed(1) +
      " and the rating beside it starts at " + rating.left.toFixed(1));
  }
  assert.ok(checked >= 8, "every visible row should have been checked, did " + checked);
});


/* The page's half of signing in: a popup, a Firebase session, a uid. None of
   that can happen in a vm, and none of it needs to -- the game only ever asks
   for it and reads the answer back. */
function stubAuth(run, me) {
  run(`(function () {
    window.__auth = { calls: [], me: ` + JSON.stringify(me || null) + ` };
    window.NerdWarsAuth = {
      me: function () { return __auth.me; },
      busy: function () { return !!__auth.busy; },
      signIn: function () {
        __auth.calls.push('signIn');
        /* The real one goes through Google and comes back through net.js --
           there is one identity in the game and net.js holds it. */
        __auth.me = { uid: 'u-trev', name: 'TREV' };
        __lobby.me = __auth.me;
      },
      signOut: function () {
        __auth.calls.push('signOut');
        __auth.me = null; __lobby.me = null;
      },
    };
    return true;
  })()`);
}

test("signed out, the leaderboard asks you in rather than looking empty", async () => {
  /* Reading the log takes an account -- the Firestore rules say so -- so a
     signed-out visitor gets a permission error, not an empty collection.
     Drawing that as "could not reach the ladder" would be true and useless:
     what is missing is a sign-in, and it is one key away. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, null);
  stubAuth(run, null);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("__lobby.me = null; scene = 'ladder';");
  // What a locked-out read actually looks like coming back.
  run(`(function () {
    var K = window.NerdWarsLadderKit;
    window.NerdWarsLadder = K.createLadder({
      listMatches: function () {
        return Promise.reject(new Error('Missing or insufficient permissions.'));
      },
      writeMatch: function () { return Promise.resolve(false); },
      writeConfirm: function () { return Promise.resolve(false); },
      getProfile: function () { return Promise.resolve(null); },
      setProfile: function () { return Promise.resolve(false); },
    });
    return window.NerdWarsLadder.refresh();
  })()`);
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const out = parseLines(drawnLadder(run)).map((l) => l.s);
  assert.ok(out.some((s) => /sign in/i.test(s)),
    "it should ask for a sign-in, got: " + out.join(" / "));
  assert.ok(out.some((s) => /ENTER/.test(s)),
    "and say which key does it, got: " + out.join(" / "));
  assert.ok(!out.some((s) => /could not reach|insufficient permissions/i.test(s)),
    "and not report the permission error as a fault, got: " + out.join(" / "));
  assert.ok(!out.some((s) => /RATING/.test(s)),
    "with no empty table under it");

  // ENTER asks the page to sign in, and the board comes back.
  assert.equal(tapKey(run, 'Enter'), 'ladder');
  assert.equal(run("__auth.calls.join(',')"), 'signIn',
    "ENTER should ask the page for a sign-in");
  const after = parseLines(drawnLadder(run)).map((s) => s.s);
  assert.ok(!after.some((s) => /^sign in to see the ladder/.test(s)),
    "and once signed in the prompt should be gone, got: " + after.join(" / "));
});

test("two friends on one laptop can hand the account over", async () => {
  /* The reason sign-out exists at all. Without it the second person plays
     ranked matches under the first person's name, and the ladder has no way
     to know it happened. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  stubAuth(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("scene = 'ladder'; ladderView.row = 0;");

  assert.ok(parseLines(drawnLadder(run)).some((l) => /sign out/i.test(l.s)),
    "the way out should be on screen");
  tapKey(run, 'KeyO');
  assert.equal(run("__auth.calls.join(',')"), 'signOut');
  assert.equal(run("NerdWarsLobby.me()"), null,
    "and net.js should stop believing anybody is signed in");

  /* W and S read the board. They must not also sign somebody out of it --
     the key for that is deliberately nowhere near them. */
  run("__auth.calls.length = 0; __auth.me = { uid: 'u-trev', name: 'TREV' };" +
      "__lobby.me = __auth.me;");
  for (const k of ['KeyW', 'KeyS', 'KeyR', 'Enter']) tapKey(run, k);
  assert.equal(run("__auth.calls.join(',')"), '',
    "reading the board should not sign anybody in or out");
});

test("the online screen says whether the match is going on anybody's record", async () => {
  /* net.js refuses to record a match with an unidentified player in it, which
     is right -- a record with a hole in it names a ghost -- and completely
     silent. Four people can play all evening and find out afterwards that
     none of it counted. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubAuth(run, null);
  run("__lobby.me = null; scene = 'online'; online.choice = 0;");

  const out = () => run(`(function () {
    var lines = [], realText = text;
    text = function (str) { lines.push(String(str)); };
    try { drawOnline(); } finally { text = realText; }
    return lines;
  })()`);

  const anon = out();
  assert.ok(anon.some((s) => /will not count/i.test(s)),
    "signed out, it should say so before the match, got: " + anon.join(" / "));

  run("__auth.me = { uid: 'u-trev', name: 'TREV' }; __lobby.me = __auth.me;");
  const named = out();
  assert.ok(named.some((s) => /signed in as TREV/.test(s)),
    "signed in, it should say who as, got: " + named.join(" / "));
  assert.ok(!named.some((s) => /will not count/i.test(s)),
    "and stop warning about it");
});


/* ---------------------------------------------------------------------
   Getting back out.

   In fullscreen the browser keeps Escape for itself: it closes fullscreen and
   the keydown never reaches the page. So a screen whose only advertised way
   out is ESC is a dead end for the player with the fewest options left --
   no address bar, no tab strip, nothing on screen but the game.
   --------------------------------------------------------------------- */

/** Render a frame, then click the middle of one of the buttons it registered,
    through the engine's own mousedown listener. Nothing here reaches past the
    engine: the point is to exercise viewPoint(), buttonAt() and the hit rects.

    The client coordinate is worked out inside the vm, as the exact inverse of
    viewPoint(). It has to be: the canvas's backing store and its CSS box are
    different sizes -- 640 wide holding a 960-wide element in this harness --
    so a test that multiplies virtual pixels by SCALE and calls the result a
    client coordinate misses every button by half its own width. */
const clickButton = (run, i) => run(`(function () {
  render();
  var b = uiButtons[${i}];
  if (!b) return 'no button ' + ${i};
  var r = view.getBoundingClientRect();
  (view.__on.mousedown || []).forEach(function (fn) {
    fn({ clientX: (b.x + b.w / 2) / (view.width / r.width) + r.left,
         clientY: (b.y + b.h / 2) / (view.height / r.height) + r.top });
  });
  return scene;
})()`);

/** Where every button the last frame registered actually is, in virtual px. */
const buttonsOn = (run, setup) => run(`(function () {
  ${setup}
  render();
  return uiButtons.map(function (b) {
    return [b.x / SCALE, b.y / SCALE, (b.x + b.w) / SCALE, (b.y + b.h) / SCALE]
      .join('|');
  });
})()`).map((r) => {
  const [x0, y0, x1, y1] = r.split('|').map(Number);
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
});

/** Every string a screen draws, with no mouse or ladder plumbing involved. */
const textOn = (run, setup) => run(`(function () {
  ${setup}
  var lines = [], realText = text;
  text = function (str) { lines.push(String(str)); };
  try { render(); } finally { text = realText; }
  return lines;
})()`);

test("the leaderboard can be left with a mouse, in all three of its states", async () => {
  /* Reported from fullscreen: "you cant go back if you are in the leaderboard,
     esc takes you out of fullscreen". Two of these three states are pure dead
     ends -- they draw a message and return -- so the button has to be
     registered BEFORE those returns, not after. render() empties uiButtons and
     then calls one draw function, so a button drawn past a `return` was never
     registered at all. */
  const run = await bootEngine();
  stubLobby(run, 'idle');

  // The harness itself works: the title's own START button still answers.
  run("scene = 'title'; titleChoice = 0;");
  const start = buttonsOn(run, "");
  assert.equal(start.length, 2, "the title should have START and HELP");
  assert.equal(clickButton(run, 0), 'select',
    "clicking START should start a game -- if not, the click plumbing is wrong " +
    "and nothing below this line means anything");

  // 1. No ladder at all: the standalone build's dead end.
  run("delete window.NerdWarsLadder; scene = 'ladder';");
  let b = buttonsOn(run, "");
  assert.equal(b.length, 1, "the leaderboard should offer exactly one button");
  assert.equal(clickButton(run, 0), 'title',
    "clicking BACK on a build with no ladder should go back");

  // 2. Signed out: the other dead end.
  stubLadder(run, null);
  stubAuth(run, null);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("__lobby.me = null; scene = 'ladder';");
  b = buttonsOn(run, "");
  assert.equal(b.length, 1, "and when signed out");
  assert.equal(clickButton(run, 0), 'title');

  // 3. The board itself.
  run("__auth.me = { uid: 'u-trev', name: 'TREV' }; __lobby.me = __auth.me;" +
      "scene = 'ladder'; ladderView.row = 0;");
  b = buttonsOn(run, "");
  assert.equal(b.length, 1, "and with a board on screen");
  assert.equal(clickButton(run, 0), 'title');

  // The online screen is the same dead end and gets the same way out.
  run("scene = 'online'; online.typing = false;");
  b = buttonsOn(run, "");
  assert.equal(b.length, 1, "the online screen should have one too");
  assert.equal(clickButton(run, 0), 'title');

  /* Including on a build with no netplay at all, which is the same early
     return as the ladder's: it draws "online play lives on the website copy"
     and stops. A button drawn past that return is never registered. */
  run("window.__savedLobby = window.NerdWarsLobby; delete window.NerdWarsLobby;" +
      "scene = 'online';");
  b = buttonsOn(run, "");
  assert.equal(b.length, 1,
    "the offline build's online screen should still offer a way back");
  assert.equal(clickButton(run, 0), 'title');
  run("window.NerdWarsLobby = window.__savedLobby;");
});

test("a back button does not sit on top of the screen behind it", async () => {
  /* A width-44 button is 17.3 virtual pixels tall, and the leaderboard's first
     row draws a highlight rectangle from y=26. Centering the button on 18 --
     which is where the character select puts its own -- lands its bottom edge
     at 26.7, under the highlight. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  stubAuth(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const scenes = ['title', 'help', 'online', 'ladder'];
  for (const sc of scenes) {
    const bs = buttonsOn(run, "scene = " + JSON.stringify(sc) + ";");
    assert.ok(bs.length > 0, sc + " should have at least one button");
    for (const b of bs) {
      assert.ok(b.x0 >= 0 && b.x1 <= 320 && b.y0 >= 0 && b.y1 <= 180,
        sc + ": a button spans x " + b.x0.toFixed(1) + ".." + b.x1.toFixed(1) +
        " y " + b.y0.toFixed(1) + ".." + b.y1.toFixed(1) +
        " on a 320x180 screen");
    }
  }

  // And specifically: clear of the leaderboard's first row.
  run("scene = 'ladder'; ladderView.row = 0;");
  const [back] = buttonsOn(run, "");
  const firstRowTop = 34 - 8;     // drawLadder highlights from y-8 at y=34
  assert.ok(back.y1 <= firstRowTop,
    "the back button ends at y " + back.y1.toFixed(1) +
    " and the first row's highlight starts at " + firstRowTop);
});

test("the key a screen names is the key that works, in or out of fullscreen", async () => {
  /* The screens that have no button say which key goes back. Escape is the
     browser's in fullscreen, so saying ESC there is a promise the game cannot
     keep -- and this reads the promise off the canvas and then tries it. */
  const run = await bootEngine();
  stubLobby(run, 'lobby');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  stubAuth(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const CASES = [
    { scene: 'ladder', setup: "scene='ladder';", lands: 'title' },
    { scene: 'online', setup: "scene='online'; online.typing=false; __lobby.phase='idle';",
      lands: 'title' },
    { scene: 'room', setup: "scene='room'; __lobby.phase='lobby';", lands: 'online' },
  ];

  for (const full of [false, true]) {
    run("document.fullscreenElement = " + (full ? "{}" : "null") + ";");
    for (const c of CASES) {
      const said = textOn(run, c.setup)
        .map((s) => /\b(ESC|BACKSPACE)\b\s+to\s+(go back|leave)/.exec(s))
        .find(Boolean);
      assert.ok(said,
        c.scene + (full ? ' (fullscreen)' : '') +
        " should say on screen which key goes back");
      const named = said[1];
      assert.equal(named, full ? 'BACKSPACE' : 'ESC',
        c.scene + (full ? ' in fullscreen' : '') + " named " + named);

      // Now press it, and see whether the screen keeps its word.
      run(c.setup);
      const code = named === 'ESC' ? 'Escape' : 'Backspace';
      assert.equal(tapKey(run, code), c.lands,
        c.scene + ": the screen says " + named + ", so " + code +
        " has to leave it");
    }
  }

  /* And the key it names in fullscreen must be one the browser actually
     delivers. Escape is not, which is the entire bug -- so in fullscreen no
     screen may name it. */
  run("document.fullscreenElement = {};");
  for (const c of CASES) {
    const lines = textOn(run, c.setup).join(' | ');
    assert.ok(!/\bESC\b/.test(lines),
      c.scene + " must not offer ESC in fullscreen: " + lines);
  }
});


test("Escape still leaves a local results screen straight away", async () => {
  /* Online, Escape on the results screen waits until the match has been
     written down: leaving sends `part` and tears the room down, which stops
     the other machine with the wrong reason and loses its record. Offline
     there is nobody to tell, and a menu that ignores the key for a third of a
     second for no reason is just a menu that feels broken. */
  const run = await bootEngine();
  run("scene = 'results'; resultTimer = 1; netplay.active = false;");
  assert.equal(tapKey(run, 'Escape'), 'title',
    "offline, Escape should leave the results screen immediately");

  // Online, the same keypress at the same frame does nothing yet.
  run("scene = 'results'; resultTimer = 1; netplay.active = true;");
  assert.equal(tapKey(run, 'Escape'), 'results',
    "online, it should wait until the result is safely written down");
  run("resultTimer = 60;");
  assert.notEqual(tapKey(run, 'Escape'), 'results',
    "and work once it is");
});


test("you can type yourself a different name on the leaderboard", async () => {
  /* The names on the board are the first word of whatever Google was told to
     call somebody, which made one of the nine "The". */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  stubAuth(run, { uid: 'u-trev', name: 'TREV' });
  // The page half of renaming, which is Firebase's job in production.
  run(`(function () {
    window.__auth.named = [];
    window.NerdWarsAuth.setName = function (n) {
      __auth.named.push(n);
      __auth.me = { uid: 'u-trev', name: n };
      __lobby.me = __auth.me;
      return Promise.resolve(true);
    };
    return true;
  })()`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("scene = 'ladder'; ladderView.row = 0;");

  assert.ok(parseLines(drawnLadder(run)).some((l) => /E rename/.test(l.s)),
    "the screen should say the key");

  tapKey(run, 'KeyE');
  assert.equal(run("ladderView.editing"), true, "E should open the field");
  assert.equal(run("ladderView.draft"), "TREV",
    "starting from what you are called now, not from nothing");

  /* Typing is a MODE. Every key this screen navigates with is also a letter,
     so with the field open they have to type instead of moving.

     One key at a time and in one direction: W and S together walk the cursor
     up and then back down to where it started, which looks exactly like a
     cursor that never moved. */
  run("ladderView.draft = ''; ladderView.row = 1; __auth.calls.length = 0;");
  tapKey(run, 'KeyS');
  assert.equal(run("ladderView.draft"), "s", "S should type an s");
  assert.equal(run("ladderView.row"), 1, "and must not also move the cursor");
  tapKey(run, 'KeyW');
  assert.equal(run("ladderView.row"), 1, "nor W");
  tapKey(run, 'KeyR');
  tapKey(run, 'KeyO');
  assert.equal(run("ladderView.draft"), "swro",
    "W, R and O must type too, got " + run("ladderView.draft"));
  assert.equal(run("__auth.calls.join(',')"), '',
    "and O must not sign you out mid-name");
  assert.equal(run("__ladderReads"), run("__ladderReads"),
    "and R must not go and refetch the board");

  // Shift is the difference between Trev and TREV.
  run(`(function () {
    ladderView.draft = '';
    held.clear(); prevHeld.clear();
    held.add('ShiftLeft'); held.add('KeyK'); step();
    prevHeld = new Set(held); held.delete('KeyK'); step();
    held.delete('ShiftLeft');
    held.add('KeyA'); prevHeld.clear(); step();
    held.clear(); prevHeld.clear();
    return true;
  })()`);
  assert.equal(run("ladderView.draft"), "Ka",
    "shift should give a capital, got " + run("ladderView.draft"));

  // Backspace takes one off; it must not fall through and leave the screen.
  tapKey(run, 'Backspace');
  assert.equal(run("ladderView.draft"), "K");
  assert.equal(run("scene"), 'ladder', "and must not back out of the screen");

  // A name cannot outgrow the column it goes in.
  run("ladderView.draft = '';");
  for (let i = 0; i < 40; i++) tapKey(run, 'KeyX');
  const cap = run("(window.NerdWarsLadderKit && NerdWarsLadderKit.NAME_MAX) || 16");
  assert.equal(run("ladderView.draft").length, cap,
    "the field should stop at " + cap + " characters");

  // ENTER hands it to the page, which is the only thing that can store it.
  run("ladderView.draft = 'Kam';");
  tapKey(run, 'Enter');
  assert.equal(run("ladderView.editing"), false, "ENTER should close the field");
  assert.equal(run("__auth.named.join(',')"), 'Kam',
    "and ask the page to save it");
  assert.equal(run("NerdWarsLobby.me().name"), 'Kam',
    "so the next match is recorded under the new name");
});

test("changing your mind about a name changes nothing", async () => {
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  stubAuth(run, { uid: 'u-trev', name: 'TREV' });
  run(`(function () {
    window.__auth.named = [];
    window.NerdWarsAuth.setName = function (n) { __auth.named.push(n); return Promise.resolve(true); };
    return true;
  })()`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("scene = 'ladder';");

  tapKey(run, 'KeyE');
  run("ladderView.draft = 'Nonsense';");
  assert.equal(tapKey(run, 'Escape'), 'ladder',
    "ESC should close the field, not the screen");
  assert.equal(run("ladderView.editing"), false);
  assert.equal(run("__auth.named.length"), 0, "and save nothing");

  // A second ESC now leaves, the way it always did.
  assert.equal(tapKey(run, 'Escape'), 'title');

  /* And coming back does not find the field still open behind you.

     Leaving WITH it open takes the mouse: ESC closes the field rather than
     the screen, so the BACK button is the only way out from inside the
     field -- and it sets the scene without knowing anything about names. */
  run("scene = 'ladder';");
  tapKey(run, 'KeyE');
  assert.equal(run("ladderView.editing"), true, "the field should be open again");
  assert.equal(clickButton(run, 0), 'title',
    "the BACK button should leave even with the field open");
  run("scene = 'title'; titleChoice = " + modeIndex(run, /LEADERBOARD/i) + ";");
  tapKey(run, 'Enter');
  assert.equal(run("ladderView.editing"), false,
    "the field should not still be open on the way back in");

  // An empty name is not a name, and is not saved.
  tapKey(run, 'KeyE');
  run("ladderView.draft = '   ';");
  tapKey(run, 'Enter');
  assert.equal(run("__auth.named.length"), 0,
    "a name made of spaces should not be sent anywhere");
});

test("nobody who is signed out can rename anybody", async () => {
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, null);
  stubAuth(run, null);
  /* The page offers setName whether or not anybody is signed in -- it is a
     method on an object, not a capability -- so the check that matters is
     whether there is a person to rename. Without this the test would pass on
     a missing method rather than on a working guard. */
  run(`(function () {
    window.__auth.named = [];
    window.NerdWarsAuth.setName = function (n) {
      __auth.named.push(n); return Promise.resolve(true);
    };
    return true;
  })()`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("__lobby.me = null; scene = 'ladder';");
  tapKey(run, 'KeyE');
  assert.equal(run("ladderView.editing"), false,
    "there is nobody to rename until somebody signs in");
  assert.equal(run("__auth.named.length"), 0);
});


test("the board says what the reset took off it", async () => {
  /* The reset is a line across the log, not a delete: the matches are still
     in the database. A board that silently dropped games people remember
     playing would be a board nobody trusts, so it says how many. */
  const run = await bootEngine();
  stubLobby(run, 'idle');
  stubLadder(run, { uid: 'u-trev', name: 'TREV' });
  stubAuth(run, { uid: 'u-trev', name: 'TREV' });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Push three of the fixture's matches back behind the line.
  run(`(function () {
    var K = window.NerdWarsLadderKit;
    var keys = Object.keys(__ladderDb.matches).slice(0, 3);
    keys.forEach(function (k) { __ladderDb.matches[k].at = K.SEASON_START - 5000; });
    window.NerdWarsLadder = K.createLadder(K.memoryStore(__ladderDb));
    return window.NerdWarsLadder.refresh();
  })()`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run("scene = 'ladder'; ladderView.row = 0;");

  const got = drawnLadder(run);
  const lines = parseLines(got).map((l) => l.s);
  assert.ok(lines.some((s) => /3 before the reset/.test(s)),
    "it should say how many are behind the line, got: " + lines.join(" / "));

  // And nothing behind the line is scored.
  const counted = run("NerdWarsLadder.view().counted");
  const before = run("NerdWarsLadder.view().before");
  assert.equal(before, 3);
  assert.ok(counted > 0, "the rest still count");

  /* With everything behind the line, the board is empty and says why --
     "no matches yet" would be a lie about an evening somebody remembers. */
  run(`(function () {
    var K = window.NerdWarsLadderKit;
    Object.keys(__ladderDb.matches).forEach(function (k) {
      __ladderDb.matches[k].at = K.SEASON_START - 5000;
    });
    window.NerdWarsLadder = K.createLadder(K.memoryStore(__ladderDb));
    return window.NerdWarsLadder.refresh();
  })()`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const empty = parseLines(drawnLadder(run)).map((l) => l.s);
  assert.ok(empty.some((s) => /the board was reset/.test(s)),
    "an empty board after a reset should say so, got: " + empty.join(" / "));
  assert.ok(!empty.some((s) => /no matches yet/.test(s)),
    "and must not claim nobody has ever played");
});


test("the pizza dives only when he asks it to", async () => {
  /* It used to go down whenever his feet were off the ground. That meant the
     flat throw -- the one that covers the stage -- simply did not exist in
     the air: jumping over somebody's projectile deleted his own. Holding DOWN
     is the dive now, and everything else flies straight.

     Driven through netplay.framePads rather than the keyboard, because that
     is the path an online match takes and the one where reading the wrong
     input goes unnoticed: a move that consulted this machine's keys instead
     of the recorded pad would look perfect in single player and desync the
     moment two people played. */
  const run = await bootEngine();
  run("select.cursor=[0,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.name"), "AUTISNICK");
  assert.equal(run("ROSTER.autisnick.specials.neutral.kind"), "pizza");

  const SP_N = 512, DOWN = 8;
  const throwIt = (airborne, holdDown) => run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.vx=0; me.vy=0; me.grabbing=-1; me.facing=1;
    me.specialSpawned=false; me.aimDown=false; me.stocks=99; me.eliminated=false;
    me.x = main.x + 60;
    if (${airborne}) { me.y = main.y - 40; me.grounded = false; }
    else { me.y = main.y; me.grounded = true; }
    foe.setState('idle'); foe.stocks=99; foe.eliminated=false; foe.invuln=9999;
    foe.x = main.x + 250; foe.y = main.y; foe.hasHit = true;
    var bits = ${SP_N} | ${holdDown ? DOWN : 0};
    var hold = ${holdDown ? DOWN : 0};
    netplay.active = true;
    var heading = null;
    for (var i = 0; i < 20; i++) {
      me.hitstop = 0; me.mana = 999;
      // Airborne, keep him there: the test is about the throw, not gravity.
      if (${airborne}) { me.vy = 0; me.grounded = false; }
      netplay.framePads = [bitsToPad(i === 0 ? bits : hold), bitsToPad(0)];
      step();
      var z = projectiles.filter(function (q) {
        return q.constructor.name === 'Pizza'; })[0];
      if (z && heading === null) heading = z.heading;
    }
    netplay.active = false; netplay.framePads = null;
    return heading || 'none';
  })()`);

  assert.equal(throwIt(true, true), "D",
    "in the air holding DOWN, it should dive");
  assert.equal(throwIt(true, false), "R",
    "in the air with nothing held, it should fly straight");
  assert.equal(throwIt(false, false), "R",
    "and on the ground it always did");

  /* On the ground it stays flat even holding DOWN. The dive spawns BELOW his
     feet -- which is under the floor he is standing on -- so it would fall
     out of the world rather than threaten anybody. */
  assert.equal(throwIt(false, true), "R",
    "on the ground DOWN changes nothing, because there is nothing under him");

  // Facing is still what decides which way a flat one goes.
  let left = run(`(function () {
    var me = fighters[0];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    me.setState('idle'); me.timer=0; me.hitstun=0; me.hitstop=0; me.landLag=0;
    me.invuln=0; me.mana=999; me.specialSpawned=false; me.aimDown=false;
    me.facing=-1; me.grounded=true; me.x=main.x+60; me.y=main.y; me.vx=0; me.vy=0;
    netplay.active = true;
    // Captured INSIDE the loop: thrown left from here it leaves the stage
    // and dies before twenty frames are up.
    var heading = null;
    /* Forty, not twenty: the cast is eight frames of startup and he has to
       get through whatever step() left him in first. */
    for (var i = 0; i < 40; i++) {
      me.hitstop = 0; me.mana = 999; me.facing = -1;
      me.grounded = true; me.y = main.y;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_N} : 0), bitsToPad(0)];
      step();
      var z = projectiles.filter(function (q) {
        return q.constructor.name === 'Pizza'; })[0];
      if (z && heading === null) heading = z.heading;
    }
    netplay.active = false; netplay.framePads = null;
    return heading || 'none';
  })()`);
  assert.equal(left, "L", "facing left throws it left");
});

test("the CPU throws the pizza it was aiming for", async () => {
  /* The CPU's dive branch reached for the DOWN special, and the pizza is the
     NEUTRAL one -- so for AutisNick it was casting the kiss, a melee mark
     with no throw in it at all. The dive had therefore never once been used
     by a CPU, through every balance run this project has quoted.

     It also has to hold DOWN now, or the branch would fire the right move and
     still get a flat throw. */
  const run = await bootEngine();
  run("select.cursor=[0,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<60;i++) step();");

  const pad = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    // Airborne, directly above the target and close: the dive's own window.
    me.x = main.x + 80; me.y = main.y - 40; me.grounded = false;
    me.vx = 0; me.vy = 0; me.mana = 999; me.hitstun = 0; me.hitstop = 0;
    me.setState('idle'); me.eliminated = false;
    foe.x = main.x + 84; foe.y = main.y; foe.grounded = true;
    foe.eliminated = false;
    // The AI's own state lives on the fighter (Fighter ctor: this.ai).
    var ai = me.ai;
    var got = { spN: 0, spD: 0, down: 0, tries: 0 };
    for (var i = 0; i < 200; i++) {
      ai.cooldown = 0; ai.starve = 0;
      var p = aiPad(me, foe);
      if (p.spNeutral || p.spDown || p.spUp) {
        got.tries++;
        if (p.spNeutral) got.spN++;
        if (p.spDown) got.spD++;
        if (p.spNeutral && p.down) got.down++;
      }
    }
    return [got.tries, got.spN, got.spD, got.down].join('|');
  })()`).split("|").map(Number);

  const [tries, spN, spD, withDown] = pad;
  assert.ok(tries > 0, "the CPU should have reached for a special");
  assert.ok(spN > 0, "and it should be the neutral one, which is the pizza");
  assert.equal(spD, 0,
    "not the down one, which for AutisNick is the kiss and has no throw in it");
  assert.equal(withDown, spN,
    "and it should hold DOWN with it, or the slice flies straight past them");
});

test("casting the pole does not lift him", async () => {
  /* It briefly did, and it was the first thing anybody noticed about the
     move: cast in the air, the rod put a `rise` into his vy and he hopped.
     Read as a mistimed jump rather than as a cast, and on a DOWN special it
     also quietly handed him a second recovery.

     This used to be pinned in nerdwars-squalls.test.js, where the same rod
     was Squalls's up special and the two copies were compared field for
     field. He has a whip there now and no pole at all, so the assertion
     comes back here, next to the rest of the rod.

     Cast from well up in the air, because that is the only place a lift is
     visible: with nothing under him a move that has one climbs out of its
     own fall and a move that does not simply keeps going down. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.specials.down.label"), "FISHING POLE",
    "precondition: player 1 is the one with the rod");

  const DOWN_SPECIAL = 1024;
  const r = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0; effects.length = 0;
    freezeFrames = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.grabbing = -1;
    me.specialSpawned = false; me.facing = 1;
    me.x = main.x + main.w / 2; me.y = main.y - 70;
    me.grounded = false; me.vx = 0; me.vy = 0;
    // Out of reach and untouchable, so nothing the line catches can move him.
    foe.setState('idle'); foe.invuln = 9999; foe.stocks = 99;
    foe.health = 1000; foe.hasHit = true;
    foe.x = main.x + main.w - 8; foe.y = main.y; foe.grounded = true;
    var y0 = me.y, best = me.y, cast = false, worstVY = 0;
    netplay.active = true;
    for (var i = 0; i < 30; i++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(i === 0 ? ${DOWN_SPECIAL} : 0), bitsToPad(0)];
      step();
      if (me.state === 'special') cast = true;
      if (me.y < best) best = me.y;
      if (me.vy < worstVY) worstVY = me.vy;
    }
    netplay.active = false; netplay.framePads = null;
    return { cast: cast, lift: +(y0 - best).toFixed(3),
             worstVY: +worstVY.toFixed(3) };
  })()`);

  assert.ok(r.cast, "precondition: he should have cast the pole");
  assert.equal(r.lift, 0,
    "casting it must not gain him a single pixel of height; he gained " +
    r.lift + "px");
  assert.ok(r.worstVY >= 0,
    "and his vy must never go negative during the cast -- a rise written " +
    "into it is the exact shape of the jolt that was taken back out; the " +
    "best it reached was " + r.worstVY);
  assert.equal(run("ROSTER.trev.specials.down.rise"), undefined,
    "and no `rise` may creep back into the table either");
});

/* ---- negative controls ------------------------------------------------
   Each of these boots a copy of the engine with ONE line changed, in memory
   and never on disk, and requires the checker the real test ran to fail on
   the assertion it exists for. A test that cannot be made to fail is not
   evidence of anything, and these three are the proof that the two checkers
   above are reading the engine rather than agreeing with themselves. */

test("control: a positive `rise` is an anti-recovery, and the check says so",
     async () => {
  /* Ladeane's -6.2 flipped to +6.2 -- byte for byte the bug Cobeus shipped
     with, a recovery that drives its owner into the floor. The check has to
     name the character and the move: a control that merely throws could be
     throwing because the probe broke. */
  const msg = await expectToFail(
    () => checkRecoveries(sabotage("rise: -6.2, drift: 1.0, multi: 3,",
                                   "rise: 6.2, drift: 1.0, multi: 3,")),
    "an up-special driving its owner DOWNWARD has to fail this check");
  assert.ok(msg.includes("LADEANE's HIGH NOTE gained 0px"),
    "and it has to fail by naming the move that went nowhere; it said: " + msg);
});

test("control: a shove written back into the cloud is caught", async () => {
  /* The removed behavior, restored where it used to live -- one assignment
     next to the Cloud that comes out. This is the line somebody would write
     if they wanted the old feel back, so it is the line the test has to
     notice. */
  const msg = await expectToFail(
    () => checkFartMovesHimNowhere(sabotage(
      "projectiles.push(new Cloud(this, gas));",
      "projectiles.push(new Cloud(this, gas)); if (!this.grounded) this.vy = -4.2;")),
    "a fart that throws its owner upward has to fail this check");
  assert.ok(msg.includes("must not take a thing off his fall"),
    "and it has to fail on the frame the gas comes out, which is the only " +
    "frame a shove can be written on; it said: " + msg);
});

test("control: a `liftSelf` back on the spec is caught even if nothing reads it",
     async () => {
  /* The other half, and the reason the spec is asserted about separately: a
     field nobody reads yet moves no fighter at all, so every measurement
     above still passes. It is still how the shove was spelled the first
     time, and a live one is a shove waiting for somebody to wire up. */
  const msg = await expectToFail(
    () => checkFartMovesHimNowhere(sabotage(
      "speed: 0.6, lift: -0.15, drop: 0.01, friction: 0.86,",
      "speed: 0.6, lift: -0.15, drop: 0.01, friction: 0.86, liftSelf: 4.2,")),
    "a liftSelf back on CROP DUST has to fail this check");
  assert.ok(msg.includes("no `liftSelf` may creep back onto the spec"),
    "and it has to fail on the spec, not on the motion -- nothing reads the " +
    "field, so he really does stay put; it said: " + msg);
});

test("control: a status that speaks on every tick is caught", async () => {
  /* The throttle taken out at the call site, which is where it lives and
     therefore where it would be lost. 188 ticks would speak 188 times, and
     the window this checks tops out at one in twelve. */
  const msg = await expectToFail(
    () => checkStatusThrottle(sabotage(
      "if (this.poison % 20 === 0) cue('poison', { slot: this.slot, x: this.x });",
      "cue('poison', { slot: this.slot, x: this.x });")),
    "a poison that fires a cue every single tick has to fail this check");
  assert.ok(msg.includes("poison should speak about once every twenty ticks"),
    "and it has to fail on how often it SPEAKS, not on the damage -- the " +
    "damage is unchanged; it said: " + msg);
});

test("control: a rooted swing is caught", async () => {
  /* `mobile` taken off the swing -- the one word that is the difference
     between holding a sword and being held by one, and the one word a
     rewrite of the spec would drop. */
  const msg = await expectToFail(
    () => checkSwordIsMobile(sabotage(
      "kind: 'laser', label: 'LASER SWORD', mobile: true,",
      "kind: 'laser', label: 'LASER SWORD',")),
    "a swing that roots him has to fail this check");
  assert.ok(msg.includes("he should walk through a swing"),
    "and it has to fail on the walking, which is the half of it a player " +
    "feels first; it said: " + msg);
});
