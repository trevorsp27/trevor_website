/* Kel's ult, LEG DAY, reworked: the pin got shorter and he gets big.
 *
 * The pin used to be the whole move -- everybody on the floor stunned in
 * place for two seconds, three before that, and each cut was for the same
 * reason: with a jab recovering in nine frames a long pin is not a pin, it
 * is a turn. It comes down again here because the pin is no longer the
 * point. What follows it is: ten seconds of buff Kel, drawn from the sheet he
 * redrew for exactly this, hitting half again as hard and moving exactly as
 * fast as he did before. Damage was the ask. A faster Kel who also hits
 * harder would be a different character, not a buffed one.
 *
 * It was DOUBLE and the doubling is what came off. Measured over 289 CPU
 * matches, a landed LEG DAY was worth 58.1 damage across the ten seconds that
 * followed it against 18.6 in an ordinary ten seconds, and 20.8 of that 58.1
 * was what the multiplier ADDED to swings he was throwing anyway. The reason
 * the number is 1.5 rather than any other cut is pinned below: at x2 his DROP
 * SET was 30, which is harder than the hardest single hit anywhere in the
 * roster, and a buff is not allowed to put an ordinary special above that
 * ceiling.
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
/* ONE LINE CHANGED IN MEMORY, never on disk. A test whose sabotage does not
   fail it is measuring nothing, so every claim about the buff below has a
   twin that breaks the engine in the one place the claim depends on and
   checks that the SAME checker then fails. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the same checker, and it has to
   throw an assertion. Anything else thrown is a broken checker rather than a
   failed test, and is let through. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e instanceof assert.AssertionError) return e.message;
    throw e;
  }
  assert.fail(why);
}

async function kelVsReese(engineSrc) {
  const run = await bootEngine(engineSrc);
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
    var before = foe.health, mulAtHit = 0;
    netplay.active = true;
    for (var i = 0; i < ${frames}; i++) {
      me.hitstop = 0; me.mana = 999;
      foe.x = me.x + 8; foe.vx = 0; foe.invuln = 0;
      var hp0 = foe.health;
      netplay.framePads = [bitsToPad(i === 0 ? ${ATTACK} : 0), bitsToPad(0)];
      step();
      /* The multiplier on the frame the jab CONNECTED, not the one it was
         pressed on. It is read after the step, which is the same value
         applyHit used: buffTimer is decremented at the top of Kel's update
         and nothing touches it again before the frame ends, so this is the
         number that was in force inside resolveCombat. It matters because
         the buff fades -- four frames of startup is four frames of decay,
         and comparing a landed jab against the multiplier at the press is
         how you assert that a fading buff does not fade. */
      if (!mulAtHit && foe.health < hp0) mulAtHit = me.damageMul;
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

test("landing LEG DAY makes him buff Kel: half again the damage, none of the speed", async () => {
  /* Measured, not restated: a jab from plain Kel and a jab from buffed Kel
     into the same victim, reset between, and the second has to take exactly
     the multiplier's share more. The buff comes from actually landing the ult
     rather than from setting buffTimer by hand, so the path from the move's
     own `buff` block through buffStats to the getter to applyHit is the thing
     under test. Speed stays at 1 on purpose: the ask was damage, and a
     faster Kel who also hits harder is a different character. */
  const run = await kelVsReese();
  const spec = run("(function(){ var b = ROSTER.kel.ult.buff;" +
    " return { duration: b.duration, damageMul: b.damageMul, speedMul: b.speedMul," +
    "          decay: b.decay, decayTo: b.decayTo }; })()");
  assert.equal(spec.duration, 600, "ten seconds of buff, as designed; got " + spec.duration);
  assert.equal(spec.damageMul, 1.5,
    "half again the damage at its peak, as designed; got " + spec.damageMul);
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
             mulNow: mulAtHit };
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
  /* Against the multiplier IN FORCE on the frame the second jab landed, not
     against the buff's peak. The multiplier fades now -- see the test below
     -- so comparing to 1.5 would be asserting that it does not. */
  assert.ok(r.stillBuffed && r.mulNow > 1,
    "precondition: he should still be buffed for the second jab; it read " + r.mulNow);
  assert.ok(Math.abs(r.buffed - r.mulNow * r.plain) < 1e-9,
    "a jab from buffed Kel should take exactly the multiplier in force (" +
    r.mulNow + ") times what a plain one does: plain took " + r.plain +
    ", buffed took " + r.buffed);
});

test("the buff FADES: full strength at the slam, down to its floor by the end", async () => {
  /* The 2.78 nerf, aimed at the half of the ult nobody can see. It is read
     off the getter every hit in the game already goes through, after a REAL
     cast -- a probe that assembles its own buffStats measures the probe, and
     that is exactly how a `decay` written into the roster and never copied
     onto the fighter passed the first time it was written. */
  const run = await kelVsReese();
  const spec = run("(function(){ var b = ROSTER.kel.ult.buff;" +
    " return { duration: b.duration, damageMul: b.damageMul," +
    "          decay: b.decay, decayTo: b.decayTo }; })()");
  assert.ok(spec.decay > 0,
    "precondition: the buff should name the span it fades over; decay was " + spec.decay);
  assert.ok(spec.decayTo > 1 && spec.decayTo < spec.damageMul,
    "the floor must be a real multiplier and below the peak: decayTo " +
    spec.decayTo + " against damageMul " + spec.damageMul);

  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    var landed = hit || { damageMul: 0 };
    var out = { at0: landed.damageMul, samples: [] };
    var span = ROSTER.kel.ult.buff.duration;
    netplay.active = true;
    for (var i = 0; i < span + 30; i++) {
      me.hitstop = 0; freezeFrames = 0;
      netplay.framePads = [bitsToPad(0), bitsToPad(0)];
      step();
      /* Only while the buff is actually running. A sample taken after the
         timer hits zero is a reading of an unbuffed Kel, which the formula
         below has nothing to say about. */
      if (me.buffTimer > 0 && (i % 120 === 0 || i === span - 2)) {
        out.samples.push([i, me.buffTimer, me.damageMul]);
      }
    }
    netplay.active = false; netplay.framePads = null;
    out.after = me.damageMul;
    out.timerAfter = me.buffTimer;
    return out;
  })()`);

  assert.equal(r.at0, spec.damageMul,
    "the frame the floor lands he should be at the full " + spec.damageMul +
    "; he read " + r.at0);
  /* Strictly falling at every step, and each step equal to what the roster's
     own numbers say it should be. An endpoint-only check would pass a buff
     that dropped to its floor on frame two and sat there. */
  for (let i = 1; i < r.samples.length; i++) {
    assert.ok(r.samples[i][2] < r.samples[i - 1][2],
      "the multiplier should fall every step: frame " + r.samples[i][0] +
      " read " + r.samples[i][2] + " against " + r.samples[i - 1][2] +
      " at frame " + r.samples[i - 1][0]);
    const want = spec.decayTo +
      (spec.damageMul - spec.decayTo) * (r.samples[i][1] / spec.decay);
    assert.ok(Math.abs(r.samples[i][2] - want) < 1e-9,
      "at buffTimer " + r.samples[i][1] + " it should read " + want +
      "; it read " + r.samples[i][2]);
  }
  /* And by the last sample it has covered most of the distance to its floor.
     Stated as a fraction of the drop rather than as a number, because the
     exact buffTimer the last sample lands on depends on which frame the slam
     connected -- and the claim being made is about the SHAPE, not about one
     reading. */
  const last = r.samples[r.samples.length - 1];
  const covered = (spec.damageMul - last[2]) / (spec.damageMul - spec.decayTo);
  assert.ok(covered > 0.8,
    "by the last frame of the buff it should be most of the way to its floor of " +
    spec.decayTo + "; it read " + last[2] + ", which is " +
    (100 * covered).toFixed(1) + "% of the way");
  assert.equal(r.timerAfter, 0, "the buff should be over; buffTimer was " + r.timerAfter);
  assert.equal(r.after, 1,
    "and once it is over he hits for what he always did; damageMul read " + r.after);
});

test("negative control: a buff that ignores its own decay fails the fade test", async () => {
  /* The failure this pins is the one that actually happened: the roster grew
     a `decay` and the buff granted in runSpecial never copied it, so the
     multiplier stayed flat at 1.5 and every probe that built its own
     buffStats said the fade worked. */
  const run = await kelVsReese(
    sabotage("              decay: s.buff.decay || 0,", "              decay: 0,"));
  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    var first = me.damageMul;
    netplay.active = true;
    for (var i = 0; i < 300; i++) {
      me.hitstop = 0; freezeFrames = 0;
      netplay.framePads = [bitsToPad(0), bitsToPad(0)];
      step();
    }
    netplay.active = false; netplay.framePads = null;
    return { first: first, later: me.damageMul, timer: me.buffTimer };
  })()`);
  assert.ok(r.timer > 0, "precondition: the sabotaged buff should still be running");
  expectToFail(() => assert.ok(r.later < r.first,
    "a buff that dropped its decay does not fade"),
    "the fade test must fail when the decay never reaches the fighter");
});

test("LEG DAY does not multiply itself, however buffed he already is", async () => {
  /* The ceiling test below measures his jab and his specials against the
     roster's hardest single hit and never looked at the ult, because for as
     long as the ult was 19 and the buff was granted AFTER the hit landed, the
     ult could not be the thing that broke it. It can now: a second LEG DAY
     inside the first one's ten seconds is the ult's damage times whatever
     multiplier is still running. Measured over 10832 landings of CPU play,
     10.4% of them landed on an already-buffed Kel, so this is a rule with
     traffic on it. `noBuff` on the move is what closes it. */
  const run = await kelVsReese();
  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    foe.health = 100; foe.invuln = 0; foe.setState('idle');
    var mul = me.damageMul, before = foe.health;
    applyHit(me, foe, ROSTER.kel.ult, me.x);
    var second = before - foe.health;
    foe.health = 100; foe.invuln = 0; foe.setState('idle');
    applyHit(me, foe, ROSTER.kel.jab, me.x);
    var jab = 100 - foe.health;
    return { second: second, mul: mul, jab: jab,
             ultDamage: ROSTER.kel.ult.damage, jabDamage: ROSTER.kel.jab.damage,
             noBuff: !!ROSTER.kel.ult.noBuff };
  })()`);

  assert.ok(r.noBuff, "the ult has to carry noBuff or nothing below means anything");
  assert.ok(r.mul > 1, "precondition: he should still be buffed for the second cast");
  assert.equal(r.second, r.ultDamage,
    "a LEG DAY landed on top of a live buff should deal its plain " + r.ultDamage +
    "; it dealt " + r.second);
  assert.ok(Math.abs(r.jab - r.jabDamage * r.mul) < 1e-9,
    "and the buff must still be running for everything else: the jab beside it took " +
    r.jab + " at a multiplier of " + r.mul);
});

test("negative control: an ult that multiplies itself fails the ceiling", async () => {
  const run = await kelVsReese(
    sabotage("  let dmg = move.damage * (move.noBuff ? 1 : attacker.damageMul) *",
             "  let dmg = move.damage * attacker.damageMul *"));
  const r = run(`(function(){
    ${RESET} ${NO_BUFF}
    ${LEG_DAY(80)}
    foe.health = 100; foe.invuln = 0; foe.setState('idle');
    var before = foe.health;
    applyHit(me, foe, ROSTER.kel.ult, me.x);
    return { second: before - foe.health, ultDamage: ROSTER.kel.ult.damage };
  })()`);
  expectToFail(() => assert.equal(r.second, r.ultDamage,
    "a self-multiplying ult deals more than its own number"),
    "the noBuff test must fail when applyHit stops reading the flag");
});

test("the buff cannot lift one of his moves above the roster's hardest hit", async () => {
  /* THE REASON THE NUMBER IS 1.5. This is the assertion the multiplier was
     cut to satisfy, and it is written as a rule rather than as a number so
     that raising the buff, or raising DROP SET, or softening whatever
     currently holds the ceiling, each fails here instead of quietly shipping
     a 29-frame special that hits harder than any ult in the game.

     LEVEL WITH the ceiling is allowed; a class of its own is not. DROP SET
     buffed is 22.5 against Cobeus' car at 22, and the slack below is one
     point because the health bar is drawn with Math.ceil -- half a point is
     under what it can show. Thirty against twenty-two was not.

     Squalls' ult is excluded and has to be: SALAMENCE is 999, a deliberate
     one-shot, and it is not a ceiling anybody else is measured against. */
  const run = await kelVsReese();
  const r = run(`(function(){
    var cap = 0, capName = '';
    for (var k in ROSTER) {
      var d = ROSTER[k];
      var moves = [['jab', d.jab]];
      if (d.ult) moves.push(['ult', d.ult]);
      for (var s in d.specials) moves.push([s, d.specials[s]]);
      for (var i = 0; i < moves.length; i++) {
        var dmg = moves[i][1] && moves[i][1].damage || 0;
        if (dmg >= 100) continue;            // the one-shot, see above
        if (dmg > cap) { cap = dmg; capName = k + ' ' + moves[i][0]; }
      }
    }
    var mul = ROSTER.kel.ult.buff.damageMul;
    var worst = 0, worstName = '';
    var mine = [['jab', ROSTER.kel.jab]];
    for (var s2 in ROSTER.kel.specials) mine.push([s2, ROSTER.kel.specials[s2]]);
    for (var j = 0; j < mine.length; j++) {
      var v = (mine[j][1].damage || 0) * mul;
      if (v > worst) { worst = v; worstName = mine[j][0]; }
    }
    return { cap: cap, capName: capName, mul: mul,
             worst: worst, worstName: worstName };
  })()`);

  assert.ok(r.cap > 0 && r.mul > 1, "precondition: a ceiling and a real buff");
  assert.ok(r.worst <= r.cap + 1,
    "buffed Kel's " + r.worstName + " deals " + r.worst + " at x" + r.mul +
    ", clear of the roster's hardest single hit (" + r.capName + " at " +
    r.cap + "). A buff may take one of his moves LEVEL with that ceiling " +
    "and no further.");
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
    /* 2.73 moved the jab onto its own set -- every fighter got one, built out
       of his own pixels, and the shared procedural arm that used to be drawn
       over the top of all ten is gone. For Kel that set is not new art: the
       build emits his 2016 punch under BOTH names, so kel.jab.* and
       kel.attack.* are the same eight files and an unbuffed Kel's swing is
       still the ordinary attack sheet, pixel for pixel. It is a different
       Image OBJECT, though, which is why this compares the art it was decoded
       from as well as the key sprite() chose. */
    var swingingPlain = me.sprite() === IMG['kel.jab.standR'] &&
                        SPRITES.kel.jab.standR === SPRITES.kel.attack.standR;
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
     sleepy buffed Kel is slow AND hits harder; the buff is not a state the
     slouch is allowed to switch off. The multiplier is read off the spec so
     this test is about the slouch rather than about the number. Set by hand, then ticked one frame
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
             buffTimer: me.buffTimer, mul: u.buff.damageMul };
  })()`);
  assert.ok(r.mul > 1, "precondition: the ult's buff is a real multiplier");
  assert.equal(r.atOnce, r.mul,
    "a buffed Kel under the slouch aura should still read damageMul " + r.mul +
    "; got " + r.atOnce);
  assert.ok(r.drowsy > 0 && r.buffTimer > 0,
    "precondition: both the drowsiness and the buff should still be running");
  assert.equal(r.after, r.mul,
    "and a frame later, with drowsy ticking, it should still be " + r.mul +
    "; got " + r.after);
});
