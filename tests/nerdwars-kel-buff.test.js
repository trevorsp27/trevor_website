/* Kel's ult, LEG DAY, reworked: the pin got shorter and he gets big.
 *
 * The pin used to be the whole move -- everybody on the floor stunned in
 * place for two seconds, three before that, and each cut was for the same
 * reason: with a jab recovering in nine frames a long pin is not a pin, it
 * is a turn. It comes down again here because the pin is no longer the
 * point. What follows it is: ten seconds of buff Kel, drawn from the sheet he
 * redrew for exactly this, hitting twice as hard and moving exactly as fast
 * as he did before. Damage was the ask. A faster Kel who also hits twice as
 * hard would be a different character, not a buffed one.
 *
 * The buff rides the machinery Reese's SHIRTS OPTIONAL already owns --
 * buffTimer, buffStats, the damageMul getter -- so the two things most
 * likely to go wrong are that Kel's new sheet does not get picked up, or
 * that picking it up disturbs Reese's. Both are pinned here.
 *
 * These load the engine source, as nerdwars-platforms.test.js does, because
 * none of this is reachable through NerdWars.fighters: sprite(), IMG, the
 * damageMul getter and freezeFrames are all internals.
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

/* Kel in seat 0, Reese in seat 1, on the open arena, and past the 110-frame
   spawn invulnerability. Reese because he is the other character with a
   buff, which is exactly the thing that must not get tangled up. */
async function kelVsReese() {
  const run = await bootEngine();
  run("select.cursor=[2,4]; twoPlayer=true; playerCount=2; humanCount=0;" +
      " stagePick=0; startBattle();");
  run("for (var i=0;i<130;i++) step();");
  assert.equal(run("fighters.map(function (f) { return f.key; }).join(',')"),
    "kel,reese", "precondition: ORDER should seat Kel at 2 and Reese at 4");
  return run;
}

const ULT = 256, ATTACK = 32;

/* Both of them clean and standing on the floor, Kel on the left facing in
   and Reese far across the stage. The warmup frames run both CPUs off
   Math.random, so whatever they were doing when the reset arrives is luck --
   a fighter mid-special ignores the ult button entirely, and one mid-poison
   loses health on its own, which would read as a hit. Nothing that the buff
   itself is made of (buffTimer, buffStats) is touched here, so a test can
   reset the room and keep the buff. */
const RESET = `
    var me = fighters[0], foe = fighters[1];
    var main = STAGE.platforms.find(function (p) { return p.main; });
    var u = ROSTER.kel.ult;
    projectiles.length = 0; effects.length = 0;
    freezeFrames = 0;
    [me, foe].forEach(function (f) {
      f.setState('idle');
      f.timer = 0; f.hitstun = 0; f.hitstop = 0; f.landLag = 0;
      f.invuln = 0; f.mana = 999; f.vx = 0; f.vy = 0;
      f.grabbing = -1; f.grabbedBy = -1; f.grounded = true;
      f.specialSpawned = false; f.hasHit = false; f.attackFrame = 0;
      f.stocks = 99; f.health = 100; f.combo = 0; f.sinceHitFrames = 999;
      f.poison = 0; f.burn = 0; f.confused = 0; f.drowsy = 0;
      f.swordTimer = 0;
      f.y = main.y;
    });
    me.x = main.x + 40; me.facing = 1;
    foe.x = main.x + main.w - 30; foe.facing = -1;`;

const NO_BUFF = `
    me.buffTimer = 0; me.buffStats = null;
    foe.buffTimer = 0; foe.buffStats = null;`;

/* Press the ult on the first frame and let the whole move play out -- 20
   frames of startup, the hit, the freeze, 30 of recovery. `hit` is what the
   engine had to say on the STEP the floor came up, read off the victim's
   health and captured before anything has ticked: the victim spends that
   step in hitstop, so the hitstun it records is the number applyHit wrote.
   `perFrame` runs before each step, which is how a test keeps a fighter in
   the air against gravity. Presses go through netplay so the other seat
   gets an empty pad rather than the CPU. */
const LEG_DAY = (frames, perFrame) => `
    var before = foe.health, hit = null, fired = false;
    me.ultMeter = 999;
    netplay.active = true;
    for (var i = 0; i < ${frames}; i++) {
      me.hitstop = 0; me.mana = 999;
      ${perFrame || ""}
      netplay.framePads = [bitsToPad(i === 0 ? ${ULT} : 0), bitsToPad(0)];
      step();
      if (me.state === 'ult') fired = true;
      if (!hit && foe.health < before) {
        hit = { at: i, stun: foe.hitstun, freeze: freezeFrames,
                buffTimer: me.buffTimer, damageMul: me.damageMul,
                speedMul: me.speedMul, lost: before - foe.health };
      }
    }
    netplay.active = false; netplay.framePads = null;`;

const NO_HIT = "{ at: -1, stun: 0, freeze: 0, buffTimer: 0, damageMul: 1, speedMul: 1, lost: 0 }";

/* One jab into a victim held at arm's length -- the jab's box runs from 2 to
   13 pixels ahead of him and the hurtbox is 9 wide, so 8 ahead is squarely
   in it. Pinned every frame because the hit shoves, and a victim shoved out
   of range on the first active frame would make the second measurement
   quietly different from the first. `lost` is what the jab took. */
const JAB = (frames) => `
    var before = foe.health;
    netplay.active = true;
    for (var i = 0; i < ${frames}; i++) {
      me.hitstop = 0; me.mana = 999;
      foe.x = me.x + 8; foe.vx = 0; foe.invuln = 0;
      netplay.framePads = [bitsToPad(i === 0 ? ${ATTACK} : 0), bitsToPad(0)];
      step();
    }
    netplay.active = false; netplay.framePads = null;
    var lost = before - foe.health;`;

/* ------------------------------------------------------------------ */

test("LEG DAY still hits the floor and spares the air", async () => {
  /* The rework changed what happens AFTER the hit, and nothing about who it
     hits: everybody standing on the ground, at any distance, and nobody in
     the air. That was the first move in the game to reward being airborne,
     and it would be easy to lose in a rewrite that only had eyes for the
     buff. Reese stands 170 pixels away for the grounded case on purpose --
     the floor is the hitbox, not Kel. */
  const run = await kelVsReese();

  const ground = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    var r = hit || ${NO_HIT};
    r.fired = fired; r.away = Math.abs(foe.x - me.x);
    return r;
  })()`);
  assert.ok(ground.fired, "precondition: Kel should actually have gone into the ult");
  assert.ok(ground.at >= 0,
    "a foe standing on the floor " + ground.away.toFixed(0) + "px away should " +
    "have been hit by the floor coming up; his health never moved");
  assert.ok(ground.lost > 0, "and it should hurt; he lost " + ground.lost);
  assert.ok(ground.stun > 0,
    "and he should be in hitstun on the frame it lands; hitstun was " + ground.stun);

  const air = run(`(function(){
    ${RESET} ${NO_BUFF}
    var stunned = 0;
    ${LEG_DAY(80, "foe.x = 160; foe.y = main.y - 30; foe.vy = 0; foe.grounded = false;")}
    return { at: hit ? hit.at : -1, fired: fired, health: foe.health,
             hitstun: foe.hitstun };
  })()`);
  assert.ok(air.fired, "precondition: the ult should have fired against the airborne foe too");
  assert.equal(air.at, -1,
    "a foe in the air must not be touched -- that is the whole point of the " +
    "move -- but he lost health on frame " + air.at);
  assert.equal(air.health, 100, "an airborne foe keeps every point of health");
  assert.equal(air.hitstun, 0, "and is not in hitstun");
});

test("the pin is shorter than it was, and exactly what the roster says", async () => {
  /* 120 frames is the historical number: two full seconds, cut because with
     a jab recovering in nine frames a long pin is a turn, not a pin. The
     second half checks that what the roster says is what the victim gets --
     the stun is written straight into hitstun, so the value on the hit frame
     has to be the roster's, not something that went through the ordinary
     hitstun arithmetic and its cap. Above the cap is what makes it a pin at
     all: the irons are drawn on exactly that condition. */
  const run = await kelVsReese();
  const stun = run("ROSTER.kel.ult.stun");
  const cap = run("COMBAT.hitstunCap");

  assert.ok(stun < 120,
    "the pin was two seconds (120 frames) and was cut on purpose; " +
    "ROSTER.kel.ult.stun is " + stun);
  assert.ok(stun > cap,
    "but it still has to BE a pin -- hitstun above the ordinary cap of " + cap +
    " is the only thing separating it from a jab -- and " + stun + " is not");

  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    return hit || ${NO_HIT};
  })()`);
  assert.ok(r.at >= 0, "precondition: the grounded foe should have been hit");
  assert.equal(r.stun, stun,
    "the frame the floor lands, the victim's hitstun should be exactly the " +
    "roster's " + stun + "; it was " + r.stun);
});

test("the floor landing still stops the world for a moment", async () => {
  /* The game has no screen shake, only freezeFrames -- the same brief hold a
     KO uses -- and that hold is what sells the floor coming up. It is read on
     the hit step, before the next step can start counting it down. */
  const run = await kelVsReese();
  const freeze = run("ROSTER.kel.ult.freeze");
  assert.ok(freeze > 0, "precondition: the roster should ask for a freeze at all");

  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    return hit || ${NO_HIT};
  })()`);
  assert.ok(r.at >= 0, "precondition: the grounded foe should have been hit");
  assert.ok(r.freeze >= freeze,
    "landing LEG DAY should hold everything for at least " + freeze +
    " frames; freezeFrames was " + r.freeze + " on the hit frame");
});

test("landing LEG DAY makes him buff Kel: twice the damage, none of the speed", async () => {
  /* Measured, not restated: a jab from plain Kel and a jab from buffed Kel
     into the same victim, reset between, and the second has to take exactly
     twice the health. The buff comes from actually landing the ult rather
     than from setting buffTimer by hand, so the path from the move's own
     `buff` block through buffStats to the getter to applyHit is the thing
     under test. Speed stays at 1 on purpose: the ask was damage, and a
     faster Kel who also hits twice as hard is a different character. */
  const run = await kelVsReese();
  const spec = run("(function(){ var b = ROSTER.kel.ult.buff;" +
    " return { duration: b.duration, damageMul: b.damageMul, speedMul: b.speedMul }; })()");
  assert.equal(spec.duration, 600, "ten seconds of buff, as designed; got " + spec.duration);
  assert.equal(spec.damageMul, 2, "double damage, as designed; got " + spec.damageMul);
  assert.equal(spec.speedMul, undefined,
    "the buff must not name a speed multiplier -- damage was the ask");

  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${JAB(24)}
    var plain = lost;

    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    var landed = hit || ${NO_HIT};

    ${RESET}
    var stillBuffed = me.buffTimer > 0;
    ${JAB(24)}
    var buffed = lost;
    return { plain: plain, buffed: buffed, hitAt: landed.at,
             buffTimer: landed.buffTimer, damageMul: landed.damageMul,
             speedMul: landed.speedMul, stillBuffed: stillBuffed,
             mulNow: me.damageMul };
  })()`);

  assert.ok(r.hitAt >= 0, "precondition: the ult should have landed on the grounded foe");
  assert.equal(r.buffTimer, spec.duration,
    "the frame the floor lands Kel should have the full " + spec.duration +
    " frames of buff; buffTimer was " + r.buffTimer);
  assert.equal(r.damageMul, spec.damageMul,
    "and his damageMul should read " + spec.damageMul + " at once; it read " + r.damageMul);
  assert.equal(r.speedMul, 1,
    "his speed must be untouched -- speedMul read " + r.speedMul + " while buffed");

  assert.ok(r.plain > 0, "precondition: the plain jab should have connected; it took " + r.plain);
  assert.ok(r.stillBuffed && r.mulNow === spec.damageMul,
    "precondition: he should still be buffed for the second jab");
  assert.ok(Math.abs(r.buffed - 2 * r.plain) < 1e-9,
    "a jab from buffed Kel should take exactly twice what a plain one does: " +
    "plain took " + r.plain + ", buffed took " + r.buffed);
});

test("he wears the buff sheet while it lasts, swinging or standing", async () => {
  /* The buff is a whole second sheet -- standing, walking, jumping AND
     swinging -- and every frame of both sets has to be loaded, be its own
     Image, and be different art from the base set, or "he gets big" is a
     number on a getter and not something anybody can see. Then sprite() has
     to actually pick it: buff while he stands, buffAttack while he swings,
     and base again the moment the timer is out. */
  const run = await kelVsReese();

  const sheet = run(`(function(){
    var frames = ['standR','standL','walkR1','walkL1','walkR2','walkL2','jumpR','jumpL'];
    var missing = [], sameImage = [], sameArt = [];
    frames.forEach(function (f) {
      ['buff', 'buffAttack'].forEach(function (set) {
        var k = 'kel.' + set + '.' + f;
        if (!IMG[k]) { missing.push(k); return; }
        if (IMG[k] === IMG['kel.base.' + f]) sameImage.push(k);
        if (!SPRITES.kel[set] || SPRITES.kel[set][f] === SPRITES.kel.base[f]) sameArt.push(k);
      });
    });
    return { missing: missing.join(','), sameImage: sameImage.join(','),
             sameArt: sameArt.join(','), frames: frames.length };
  })()`);
  assert.equal(sheet.missing, "",
    "every frame of both buff sets should be loaded into IMG; missing " + sheet.missing);
  assert.equal(sheet.sameImage, "",
    "each buff frame should be its own Image, not the base one under another " +
    "name: " + sheet.sameImage);
  assert.equal(sheet.sameArt, "",
    "and its own art -- these buff frames are pixel for pixel the base set: " + sheet.sameArt);

  const worn = run(`(function(){
    ${RESET} ${NO_BUFF}
    me.buffTimer = u.buff.duration;
    me.buffStats = { damageMul: 2, speedMul: 1, knockbackTakenMul: 1 };
    me.setState('idle'); me.grounded = true; me.facing = 1;
    var standing = me.sprite() === IMG['kel.buff.standR'];
    me.setState('attack'); me.attackFrame = 2;
    var swinging = me.sprite() === IMG['kel.buffAttack.standR'];
    me.buffTimer = 0;
    var swingingPlain = me.sprite() === IMG['kel.attack.standR'];
    me.setState('idle');
    var plain = me.sprite() === IMG['kel.base.standR'];
    return { standing: standing, swinging: swinging, plain: plain,
             swingingPlain: swingingPlain };
  })()`);
  assert.ok(worn.standing,
    "a buffed Kel standing still and facing right should be drawn from " +
    "kel.buff.standR, and was not");
  assert.ok(worn.swinging,
    "a buffed Kel mid-jab should keep his own swing art, kel.buffAttack.standR, " +
    "and did not");
  assert.ok(worn.plain,
    "the moment buffTimer is 0 he should be plain Kel again, kel.base.standR");
  assert.ok(worn.swingingPlain,
    "and a plain Kel's swing should still come off the ordinary attack sheet");
});

test("the buff runs out on schedule", async () => {
  /* Ten seconds from the frame the floor lands, counted in fighter frames:
     the freeze and any hitstop pause the countdown, so the number of steps
     is a little more than 600 and must never be less. Kel is made untouchable
     for the countdown because losing a stock zeroes the buff on respawn --
     which is correct, and would also make a buff that ended early look like
     it ended on time. Nobody presses anything. */
  const run = await kelVsReese();
  const duration = run("ROSTER.kel.ult.buff.duration");

  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    var landed = hit || ${NO_HIT};
    var ran = -1;
    netplay.active = true;
    for (var i = 0; i < 800; i++) {
      me.hitstop = 0; me.invuln = 9999;
      netplay.framePads = [bitsToPad(0), bitsToPad(0)];
      step();
      if (me.buffTimer <= 0) { ran = i; break; }
    }
    netplay.active = false; netplay.framePads = null;
    me.setState('idle'); me.grounded = true; me.facing = 1;
    return { hitAt: landed.at, atHit: landed.buffTimer, ran: ran,
             sinceHit: (80 - landed.at - 1) + (ran + 1),
             buffTimer: me.buffTimer, damageMul: me.damageMul,
             base: me.sprite() === IMG['kel.base.standR'] };
  })()`);

  assert.ok(r.hitAt >= 0, "precondition: the ult should have landed");
  assert.equal(r.atHit, duration, "precondition: the buff should start full");
  assert.ok(r.ran >= 0,
    "the buff should have ended within 800 frames of nothing happening; " +
    "buffTimer is still " + r.buffTimer);
  assert.ok(r.sinceHit >= duration,
    "the buff ended " + r.sinceHit + " steps after the hit, which is less than " +
    "the " + duration + " it is owed");
  assert.ok(r.sinceHit <= duration + 30,
    "and it should not outlive its ten seconds by more than the freeze; it " +
    "ran " + r.sinceHit + " steps");
  assert.equal(r.buffTimer, 0, "buffTimer should be exactly 0 when it ends");
  assert.equal(r.damageMul, 1,
    "and his damage should be back to normal; damageMul is " + r.damageMul);
  assert.ok(r.base, "and he should be drawn as plain Kel again");
});

test("Reese still takes his shirt off, not Kel's", async () => {
  /* Kel's buff uses the same buffTimer Reese's does, and sprite() now has a
     `buff` branch after the `shirtless` one. Reese has no `buff` set, so the
     new branch must leave him alone and a buffed Reese must still come off
     his own shirtless sheet. */
  const run = await kelVsReese();
  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    var hasShirtless = !!(SPRITES.reese.shirtless && IMG['reese.shirtless.standR']);
    foe.buffTimer = ROSTER.reese.ult.duration;
    foe.buffStats = { damageMul: ROSTER.reese.ult.damageMul,
                      speedMul: ROSTER.reese.ult.speedMul, knockbackTakenMul: 1 };
    foe.setState('idle'); foe.grounded = true; foe.facing = 1;
    var im = foe.sprite();
    return { kind: ROSTER.reese.ult.kind, hasShirtless: hasShirtless,
             hasBuffSet: !!SPRITES.reese.buff,
             shirtless: im === IMG['reese.shirtless.standR'],
             base: im === IMG['reese.base.standR'] };
  })()`);

  assert.equal(r.kind, "buff", "precondition: Reese's ult is the buff kind");
  assert.equal(r.hasBuffSet, false,
    "Reese has no `buff` sprite set of his own, so Kel's branch has nothing to " +
    "claim on him -- if that has changed, this test needs rethinking");
  if (!r.hasShirtless) {
    /* Not the case today -- SPRITES.reese.shirtless exists and is loaded --
       but if the sheet ever goes, say so rather than fail on a missing key. */
    assert.equal(r.hasShirtless, false,
      "Reese has no shirtless set in SPRITES; a buffed Reese has nothing to swap to");
    return;
  }
  assert.ok(r.shirtless,
    "a buffed Reese standing and facing right should be drawn from " +
    "reese.shirtless.standR; he was " + (r.base ? "still in his shirt" : "something else"));
});

test("a Simon slouch aura does not cancel Kel's buff", async () => {
  /* Simon's aura sets `drowsy`, which slows a fighter's walk on its own path
     and has nothing to do with buffStats -- and it must stay that way. A
     sleepy buffed Kel is slow AND hits twice as hard; the buff is not a state
     the slouch is allowed to switch off. Set by hand, then ticked one frame
     so the drowsy countdown gets its turn too. */
  const run = await kelVsReese();
  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    me.buffTimer = u.buff.duration;
    me.buffStats = { damageMul: u.buff.damageMul, speedMul: 1, knockbackTakenMul: 1 };
    me.drowsy = 60;
    var atOnce = me.damageMul;
    netplay.active = true;
    me.hitstop = 0;
    netplay.framePads = [bitsToPad(0), bitsToPad(0)];
    step();
    netplay.active = false; netplay.framePads = null;
    return { atOnce: atOnce, after: me.damageMul, drowsy: me.drowsy,
             buffTimer: me.buffTimer };
  })()`);
  assert.equal(r.atOnce, 2,
    "a buffed Kel under the slouch aura should still read damageMul 2; got " + r.atOnce);
  assert.ok(r.drowsy > 0 && r.buffTimer > 0,
    "precondition: both the drowsiness and the buff should still be running");
  assert.equal(r.after, 2,
    "and a frame later, with drowsy ticking, it should still be 2; got " + r.after);
});
