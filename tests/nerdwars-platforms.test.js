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

test("Trev walks and jumps while swinging the sword", async () => {
  /* Thirty-three frames a swing and eighteen swings in the ult. Rooted, the
     reward for filling the meter was ten seconds of standing still. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const RIGHT = 2, JUMP = 16, ULT = 256;
  const r = run(`(function(){
    var f = fighters[0];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    projectiles.length = 0;
    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
    f.invuln = 0; f.vx = 0; f.vy = 0; f.grounded = true; f.facing = 1;
    f.x = main.x + 40; f.y = main.y;
    f.swordTimer = 400;                  // hand him the sword
    var x0 = f.x, y0 = f.y, airborne = false, swung = false;
    netplay.active = true;
    for (var i = 0; i < 22; i++) {
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

  // 5. Shorter than it was: 46 on the flat and 82 from a jump, before.
  const reach = Math.max.apply(null, live.map((f) => Math.abs(f.hx - f.mx)));
  assert.ok(reach < 46,
    "the cast should not reach as far as the old one; got " + reach.toFixed(1));
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

test("a status ticks damage every frame but only speaks every twentieth", async () => {
  /* Measured before the fix: one poisoned, burning fighter fired 350 poison
     cues in four seconds -- roughly 85 a second, at 880Hz. That is not a
     status sound, it is an alarm.

     The throttle keys off the status counter itself rather than a new timer
     field, which matters for netcode specifically: restoreSim deletes any key
     that is not in the snapshot, so a fresh poisonCueTimer would have to be
     declared in the constructor or vanish on every rollback. Deriving the
     throttle from state that is already snapshotted means a resimulated frame
     replays the identical cue pattern for nothing. */
  const run = await bootEngine();
  run("select.cursor=[0,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");

  const r = run(`(function () {
    var counts = {};
    var realCue = cue;
    cue = function (name) {
      counts[name] = (counts[name] || 0) + 1;
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
