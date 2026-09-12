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

test("the pole catches what the line touches, not a box around the whole arc", async () => {
  /* The reported bug was "the fishing pole is not working as intended", and
     what it was doing was hitting people it visibly missed.

     hitbox() returned ONE rectangle bounding the entire cast: near end to far
     end, cast height to wherever the line had fallen to. On flat ground the
     line is almost level, so the rectangle and the line are nearly the same
     shape and it looked correct. Cast from a jump, the line drops sixty-odd
     pixels, and the rectangle became 67 wide by 63 tall -- a third of the
     screen's height -- catching anything in that whole quadrant.

     So the guard is not "the box is small". A short cast would pass that
     while still being a bounding box. It is "the box is small WHILE THE ARC
     IS LARGE", which only the walked line can satisfy. */
  const run = await bootEngine();
  run("select.cursor=[5,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters[0].def.specials.down.kind"), "pole",
    "player 1 should be the one with the rod");

  const DOWN_SPECIAL = 1024;
  const r = run(`(function () {
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var s = me.def.specials.down;
    projectiles.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.grabbing = -1;
    // High enough that the line has a long way to fall during the cast.
    me.x = main.x + 40; me.y = main.y - 55; me.vy = 0;
    me.grounded = false; me.facing = 1;
    // Parked far away so nothing interrupts, and so the line hits the floor
    // rather than a body.
    foe.x = 10; foe.y = main.y; foe.setState('idle'); foe.hasHit = true;
    var frames = [];
    netplay.active = true;
    for (var i = 0; i < 24; i++) {
      netplay.framePads = [bitsToPad(i === 0 ? ${DOWN_SPECIAL} : 0), bitsToPad(0)];
      step();
      var b = me.hitbox();
      if (!b) continue;
      var cast = poleCast(me, s);
      var hook = polePoint(me, s);
      frames.push({
        w: b.box.w, h: b.box.h,
        cx: b.box.x + b.box.w / 2, cy: b.box.y + b.box.h / 2,
        hookX: hook.x, hookY: hook.y,
        arcW: cast.fwd, arcH: cast.up - s.oy,
      });
    }
    netplay.active = false; netplay.framePads = null;
    return frames;
  })()`);

  assert.ok(r.length > 0, "the cast should have produced an active hitbox");

  for (const f of r) {
    assert.ok(f.w <= 12 && f.h <= 12,
      "the hitbox should be a point on the line, got " + f.w + "x" + f.h);
    // And it should be that point, not merely small and somewhere else.
    assert.ok(Math.abs(f.cx - f.hookX) < 0.001 && Math.abs(f.cy - f.hookY) < 0.001,
      "the box should be centered on the hook; box (" + f.cx + ", " + f.cy +
      ") vs hook (" + f.hookX + ", " + f.hookY + ")");
  }

  /* The half that makes the above mean something. If the arc were small here
     too, a bounding box would also have passed. */
  const arc = r[r.length - 1];
  assert.ok(arc.arcW > 30,
    "this cast should reach a long way, or the test proves nothing; " + arc.arcW);
  assert.ok(arc.arcH > 30,
    "and fall a long way, or the test proves nothing; " + arc.arcH);
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
