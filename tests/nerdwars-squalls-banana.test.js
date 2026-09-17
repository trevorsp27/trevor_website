/* THE BANANA, which is the first ITEM this game has ever had.
 *
 * 2.83 took SOMEDAY, A BAKERY off his down slot. The daydream had been
 * reworked once and measured hard twice and none of that was an answer to
 * what was actually reported, which is that the idea was boring. What is
 * there now is a thing he throws straight up and then has to go and get --
 * and so does the man he is fighting.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT IN nerdwars-squalls.test.js. Almost
 * nothing about this move is a frame count. What it is, is a set of rules
 * about an object that outlives the press, and every one of them is the kind
 * of thing that can go silently wrong:
 *
 *   IT CHANGES HANDS. `owner` is reassigned on a pickup, which nothing else
 *   in this engine does -- twenty-six assignments, twenty-three of them a
 *   constructor. resolveCombat skips `f === shot.owner`, so an item that
 *   forgot to change hands would look completely normal right up until the
 *   moment somebody tried to throw it back and it sailed through the man who
 *   threw it first. That is the whole move, and it is one line.
 *
 *   IT IS A HITBOX FOR ONLY PART OF ITS LIFE. In the air it is a shot; in a
 *   hand and on the floor it is not. `live()` is the only thing that says
 *   so, and a `live()` that answers yes everywhere gives every character in
 *   the game an invisible 7x9 hitbox lying on the floor -- which is not a
 *   crash, it is a stage hazard nobody authored.
 *
 *   IT SURVIVES ITS OWN HIT, which is what `burst` is for, and it must then
 *   STOP being a hitbox or one throw is eight hits. That was measured before
 *   it was fixed: one forward throw into a man standing still took him from
 *   100 to 68 and paid 48 dream.
 *
 *   IT IS THE DREAM. The daydream used to be where the meter came from in
 *   bulk. `catchDream` is what replaced that supply, and a dragon flying at
 *   its floor speed looks exactly like a dragon.
 *
 *   AND NOT ONE FIELD OF IT LIVES ON THE FIGHTER. Who is holding what is a
 *   slot index on the BANANA, so a rollback has nothing of this move to get
 *   wrong -- as long as every field really is declared in the constructor,
 *   which is the one property restoreSim will silently delete.
 *
 * Everything below drives the move through the real input path and reads
 * what actually happened. Every test has a NEGATIVE CONTROL beside it: the
 * same checker run against a copy of the engine with one line changed in
 * memory, and the check is that the same assertions then fail. The mutated
 * copies live in a string and a fresh vm and are never written anywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

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
const SPRITES_SRC = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {}, __on: {},
    getContext: () => ({
      fillRect() {}, clearRect() {}, drawImage() {}, save() {}, restore() {},
      translate() {}, scale() {}, beginPath() {}, arc() {}, fill() {},
      stroke() {}, ellipse() {}, moveTo() {}, lineTo() {}, closePath() {},
      fillText() {}, setTransform() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      measureText: () => ({ width: 0 }),
    }),
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
  vm.runInContext(SPRITES_SRC, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
                  { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

/* One line of the engine, changed in memory. Both halves are asserted: a
   needle that is missing, or is there twice, makes a control that mutates
   nothing or mutates the wrong thing, which is exactly the failure a
   negative control exists to rule out. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* TWO lines of the engine, changed in memory. Two sabotage() calls cannot be
   chained -- each one re-reads the file off disk -- so the second needle is
   applied to the string the first one returned. Both halves of both are
   asserted, for the same reason one needle's are.

   This exists because some defects are an ARRANGEMENT rather than a line: a
   statement in the wrong place is only wrong relative to the one it should
   have been below, and a control that puts back the first without taking away
   the second is measuring a third thing that never shipped. */
function sabotageBoth(n1, r1, n2, r2) {
  const src = sabotage(n1, r1);
  const at = src.indexOf(n2);
  assert.ok(at >= 0, "second sabotage needle not found: " + JSON.stringify(n2));
  assert.equal(src.indexOf(n2, at + 1), -1,
    "second sabotage needle is not unique: " + JSON.stringify(n2));
  return src.slice(0, at) + r2 + src.slice(at + n2.length);
}

function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

// Positions in ORDER, not names, because that is what select.cursor takes.
const SQUALLS = 8, REESE = 4;
// The pad bits, as netplay packs them.
const SP_DOWN = 1024, GRAB = 64, LEFT = 1, RIGHT = 2, UPDIR = 4, DOWNDIR = 8,
      ULT = 256;

/* Two fighters on DEEP SPACE, past the 110 frames of spawn invulnerability,
   with helpers installed inside the vm -- where the test has no functions of
   its own.

   THE TWO x POSITIONS ARE NOT ARBITRARY and getting them wrong measures the
   wrong thing. This stage has three platforms above the floor: 44-100 and
   220-276 at y 94, and 130-190 at y 54. The banana peaks 44.9 pixels over
   his feet, which from the floor at y 134 is y 89 -- five pixels ABOVE the
   two low platforms. Stand him under one and his own toss lands on the roof
   and never comes back, which reads exactly like a catch that failed. 110
   and 170 are both in the clear. */
async function arena(engineSrc) {
  const run = await bootEngine(engineSrc);
  run("select.cursor=[" + SQUALLS + "," + REESE + "]; twoPlayer=true;" +
      " playerCount=2; humanCount=0; stagePick=0; practice=false; startBattle();");
  run("netplay.active = true;" +
      " for (var i = 0; i < 130; i++) { netplay.framePads = [bitsToPad(0), bitsToPad(0)]; step(); }");
  assert.equal(run("fighters[0].key"), "squalls",
    "precondition: squalls should be in seat 0");
  run([
    "var MAIN = STAGE.platforms.find(function (p) { return p.main; });",
    "var BS = ROSTER.squalls.specials.down;",
    "function park(i, x) {",
    "  var o = fighters[i];",
    "  o.setState('idle'); o.x = x; o.y = MAIN.y; o.vx = 0; o.vy = 0;",
    "  o.grounded = true; o.hitstun = 0; o.hitstop = 0; o.health = 100;",
    "  o.stocks = 9; o.mana = 100; o.ai.cooldown = 99999; o.landLag = 0;",
    "  o.specialSpawned = false; o.attackFrame = 0; o.chargeTimer = 0;",
    "  o.eliminated = false; o.chicken = false; o.chickenSince = -1;",
    "  o.invuln = 0; o.dream = 0; o.facing = 1; o.combo = 0;",
    "  o.sinceHitFrames = 999; o.drowsy = 0; o.ultMeter = 999;",
    "  o.grabbing = -1; o.grabbedBy = -1; o.timer = 0;",
    "}",
    "function seat() {",
    "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
    "  park(0, MAIN.x + 70); park(1, MAIN.x + 130);",
    "  netplay.active = true;",
    "}",
    "function tick(a, b) {",
    "  netplay.framePads = [bitsToPad(a || 0), bitsToPad(b || 0)]; step();",
    "}",
    "function nanas() {",
    "  return projectiles.filter(function (q) {",
    "    return q instanceof Banana && !q.dead; });",
    "}",
    // Cast, then wait with a blank pad until it is back in his hand.
    "function tossAndCatch() {",
    "  var me = fighters[0], g = 0;",
    "  tick(" + SP_DOWN + ");",
    "  while (!me.heldBanana() && g++ < 200) tick(0);",
    "  return me.heldBanana();",
    "}",
    // A loose, expired banana put exactly where the test wants one, which is
    // the only way to measure a pickup without also measuring a toss.
    "function drop(owner, x) {",
    "  var b = new Banana(fighters[owner], BS, x, MAIN.y, 0, 0);",
    "  b.grounded = true; b.numb = 0; b.t = b.mine;",
    "  projectiles.push(b);",
    "  return b;",
    "}",
  ].join("\n"));
  return run;
}

const spec = (run) => JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.down)"));

/* =====================================================================
   1. HE THROWS IT TO HIMSELF
   ===================================================================== */

/* The arc, the catch, and what the catch is worth -- in one pass, because
   they are one thing. `dreamSteps` is every frame on which his meter moved
   at all, which is how "pays once" is measured rather than asserted: a
   `catchDream` paid per carried frame would read as sixteen steps of one, or
   one step of several hundred, and either way not as ONE step of sixteen. */
const theToss = (run) => run(`(function () {
  seat();
  var me = fighters[0], feet = me.y, peak = 0, dreamSteps = [], prev = me.dream;
  var spawnFrame = -1, caughtAt = -1, freeAt = -1;
  tick(${SP_DOWN});
  for (var i = 1; i <= 120; i++) {
    tick(0);
    if (freeAt < 0 && me.state !== 'special') freeAt = i;
    var b = nanas()[0];
    if (b && spawnFrame < 0) spawnFrame = i;
    if (b && !b.grounded && b.heldBy < 0) {
      var up = feet - b.y;
      if (up > peak) peak = up;
    }
    if (me.dream !== prev) { dreamSteps.push([i, +(me.dream - prev).toFixed(4)]); prev = me.dream; }
    if (b && b.heldBy >= 0 && caughtAt < 0) caughtAt = i;
  }
  var held = me.heldBanana();
  return JSON.stringify({
    spawnFrame: spawnFrame, freeAt: freeAt, peak: +peak.toFixed(2),
    caughtAt: caughtAt, dreamSteps: dreamSteps, dream: me.dream,
    held: !!held, heldBy: held ? held.heldBy : null,
    ownerIsMe: held ? held.owner === me : null,
    landLag: me.landLag, alive: nanas().length });
})()`);

function checkTheToss(run, r) {
  const s = spec(run);
  assert.equal(r.spawnFrame, s.startup,
    "the banana leaves his hand on `startup` (" + s.startup + "), the same " +
    "frame the star does; it appeared on frame " + r.spawnFrame);
  assert.ok(r.freeAt > 0 && r.freeAt < r.caughtAt,
    "precondition: he has to be FREE before it comes back, or the catch is " +
    "not a catch, it is the end of the move. He left the special on frame " +
    r.freeAt + " and the banana arrived on " + r.caughtAt);

  /* Over his own head and under a low platform. Asserted as a band rather
     than as a number because it is the only thing the arc has to be: high
     enough that it is not a forward poke, low enough that it is catchable. */
  assert.ok(r.peak > 30 && r.peak < 60,
    "HE THROWS IT UP. It has to clear his own head and stay under the low " +
    "platforms, which is what makes the catch a thing he can plan; it " +
    "peaked " + r.peak + " pixels over his feet");

  assert.ok(r.caughtAt > 0,
    "AND IT COMES BACK TO HIM FOR NOTHING. `mine` is " + s.mine + " frames " +
    "of it being his, and the free catch inside that window is the whole of " +
    "\"he can use it easier because he throws it up to himself\". He never " +
    "caught it across 120 frames");
  assert.equal(r.heldBy, 0, "in his own hand, by slot; heldBy read " + r.heldBy);
  assert.equal(r.ownerIsMe, true, "and he owns it");
  assert.equal(r.landLag, 0,
    "AND THE FREE CATCH COSTS NO LAG, because he threw it to himself on " +
    "purpose; landLag read " + r.landLag);

  /* ONCE. The clamp at 100 makes a per-frame payment look plausible for a
     long time -- he would simply arrive at a full meter a second early -- so
     what is counted is the number of separate moves in the bar. */
  assert.equal(r.dreamSteps.length, 1,
    "a catch pays ONCE, not once a frame while he is carrying it. His meter " +
    "moved on " + r.dreamSteps.length + " separate frames: " +
    JSON.stringify(r.dreamSteps));
  assert.equal(r.dreamSteps[0][0], r.caughtAt,
    "on the frame of the catch and no other; it moved on frame " +
    r.dreamSteps[0][0] + " and the catch was on " + r.caughtAt);
  assert.equal(r.dream, s.catchDream,
    "and it is worth `catchDream` (" + s.catchDream + "); he banked " + r.dream);
}

test("the toss comes back to his own hand, and pays for it once", async () => {
  const run = await arena();
  checkTheToss(run, JSON.parse(theToss(run)));
});

test("negative control: a catch that pays nothing fails the toss test", async () => {
  /* The meter is the half of this move that cannot be seen. The banana still
     flies, still comes back, still lands in his hand and still reads exactly
     right on screen; the only thing that changes is that the dragon four
     casts later is the slow one. */
  const run = await arena(sabotage(
    "    const d = b.spec.catchDream || 0;",
    "    const d = 0;"));
  expectToFail(() => checkTheToss(run, JSON.parse(theToss(run))),
    "with the catch paying nothing the toss test should fail; it passed");
});

/* =====================================================================
   2. AND A WALK IS WHAT HE PAYS FOR IT
   ===================================================================== */

/* THE SKILL IN THE MOVE IS THAT THE CATCH IS NOT FREE IN SPACE. He throws it
   straight up; if he walks away from the spot he threw it from, it lands
   where he was rather than in his hand.

   The boundary is MEASURED, not written down: the probe walks him for every
   number of frames from none to twenty and reports the last one that still
   caught and the first that did not. A number written here would go stale
   the first time anybody touched his walk speed, and would then report the
   walk as a catching bug. */
const theWalk = (run) => run(`(function () {
  var out = [];
  for (var n = 0; n <= 20; n++) {
    seat();
    var me = fighters[0], x0 = me.x;
    tick(${SP_DOWN});
    for (var i = 0; i < 140; i++) {
      // Walking only AFTER he is free to act; inside the special the pad
      // does nothing and the row would be measuring the recovery.
      tick(i >= 11 && i < 11 + n ? ${RIGHT} : 0);
      if (me.heldBanana()) break;
    }
    var b = nanas()[0];
    out.push({ n: n, walked: +(me.x - x0).toFixed(2),
               caught: !!me.heldBanana(),
               grounded: b ? b.grounded : null,
               dream: me.dream });
  }
  return JSON.stringify(out);
})()`);

function checkTheWalk(rows) {
  const caught = rows.filter((r) => r.caught);
  const missed = rows.filter((r) => !r.caught);
  assert.ok(caught.length > 0,
    "precondition: standing still and catching his own toss is test 1; not " +
    "one of the twenty-one walks caught it, so this is measuring something " +
    "else that is broken");
  assert.ok(missed.length > 0,
    "A WALK HAS TO BE ABLE TO MISS IT, or the catch is free everywhere and " +
    "\"he throws it up to himself\" costs him nothing at all. He caught it " +
    "on every one of " + rows.length + " walks, out to " +
    rows[rows.length - 1].walked + " pixels");

  const last = caught[caught.length - 1], first = missed[0];
  assert.ok(last.n < first.n,
    "and the boundary has to be a boundary: every walk shorter than the " +
    "first miss should catch. Last catch was " + last.n + " frames and " +
    "first miss " + first.n);
  assert.ok(last.walked >= 6,
    "A STEP OR TWO MUST STILL CATCH IT, or the move is a button you press " +
    "and then stand perfectly still for. The longest walk that caught was " +
    last.walked + " pixels");
  assert.ok(first.walked <= 20,
    "and the miss has to come inside a distance a person would actually " +
    "walk; the shortest walk that missed was " + first.walked + " pixels");

  /* The missed one is not lost, and it pays nothing. That is the other half
     of what makes it an item: a toss he walked away from is a banana on the
     floor, which is somebody's. */
  assert.equal(first.grounded, true,
    "a banana he walked away from lands rather than vanishing; it was still " +
    "in the air after 140 frames");
  assert.equal(first.dream, 0,
    "and pays him nothing at all -- the meter is for CATCHING one, which is " +
    "the whole difference from the daydream this replaced; he banked " +
    first.dream);
}

test("a step or two still catches his own toss, and a walk does not", async () => {
  const run = await arena();
  checkTheWalk(JSON.parse(theWalk(run)));
});

test("negative control: a free catch that never checks where he is standing", async () => {
  /* The overlap test gone and nothing else touched. He still throws it up,
     it still arcs, it still comes down -- and it comes back to his hand from
     anywhere on the stage, which is a move with no spacing in it at all. */
  const run = await arena(sabotage(
    "          overlap(this.box(), this.owner.hurtbox())) {",
    "          true) {"));
  expectToFail(() => checkTheWalk(JSON.parse(theWalk(run))),
    "with the catch box gone the walk test should fail; it passed");
});

/* =====================================================================
   3. AND THEN IT IS NOT HIS
   ===================================================================== */

/* THE WHOLE MOVE IS THIS TEST. A loose banana is picked up by whoever gets
   there, the pickup moves `owner`, and the man who picked it up can throw it
   at the man who made it -- which he could not do if `owner` were still
   Squalls, because resolveCombat skips `f === shot.owner` and the thing
   would sail straight through him.

   The banana is placed by hand rather than thrown, because what is being
   measured is the pickup and the ownership, and a probe that also has to
   land a throw in the right place fails for two reasons and says one. */
const changesHands = (run) => run(`(function () {
  seat();
  var me = fighters[0], foe = fighters[1];
  foe.x = MAIN.x + 130;
  var b = drop(0, foe.x - 2);
  var before = { owner: b.owner.slot, heldBy: b.heldBy, foeDream: foe.dream };
  tick(0, ${GRAB});
  var after = { owner: b.owner.slot, heldBy: b.heldBy, foeDream: foe.dream,
                foeLandLag: foe.landLag };
  // Now he turns round and throws it at the man who made it.
  foe.facing = me.x > foe.x ? 1 : -1;
  foe.landLag = 0;
  tick(0, ${GRAB});
  var thrown = { vx: +b.vx.toFixed(2), heldBy: b.heldBy, owner: b.owner.slot,
                 toward: +Math.sign(me.x - foe.x) };
  var hp0 = me.health, hit = false, pinned = 0;
  for (var i = 0; i < 120; i++) {
    tick(0, 0);
    if (me.health < hp0) hit = true;
    if (me.hitstun > 0) pinned++;
    // he must not simply walk it back: park him
    me.vx = 0;
  }
  return JSON.stringify({ before: before, after: after, thrown: thrown,
                          hit: hit, pinned: pinned, squallsHp: me.health,
                          hp0: hp0 });
})()`);

function checkChangesHands(run, r) {
  const s = spec(run);
  assert.equal(r.before.owner, 0, "precondition: the banana starts as Squalls'");
  assert.equal(r.before.heldBy, -1, "precondition: and it starts on the floor");

  assert.equal(r.after.heldBy, 1,
    "ANY PLAYER CAN USE IT. The man he is fighting walked onto a loose " +
    "banana and pressed grab; heldBy read " + r.after.heldBy);
  assert.equal(r.after.owner, 1,
    "AND THE OWNER MOVES WITH IT, which is the one rule this move bends and " +
    "the reason it is an item rather than a projectile. owner is still slot " +
    r.after.owner);
  assert.equal(r.after.foeDream, s.catchDream,
    "and a catch pays whoever caught it, not whoever threw it; the foe " +
    "banked " + r.after.foeDream + " of " + s.catchDream);
  assert.ok(r.after.foeLandLag > 0,
    "a pickup off the floor costs a few frames of not being able to start " +
    "anything -- unlike the free catch out of your own toss; it cost " +
    r.after.foeLandLag);

  assert.equal(r.thrown.heldBy, -1, "and grab again throws it; it is still held");
  assert.equal(Math.sign(r.thrown.vx), r.thrown.toward,
    "in the direction he is pointing, which is at Squalls; it left at " +
    r.thrown.vx);

  assert.equal(r.hit, true,
    "AND IT HITS THE MAN WHO MADE IT. This is what the reassignment of " +
    "`owner` buys and there is no other way to get it: resolveCombat skips " +
    "`f === shot.owner`, so a banana that stayed Squalls' forever would " +
    "pass straight through him with nothing on screen to say why. He went " +
    "from " + r.hp0 + " to " + r.squallsHp);
  assert.ok(r.pinned >= s.stun,
    "and pins him for `stun` (" + s.stun + "); he was pinned " + r.pinned +
    " frames");
}

test("a loose banana becomes whoever picked it up, and can be thrown back", async () => {
  const run = await arena();
  checkChangesHands(run, JSON.parse(changesHands(run)));
});

test("negative control: a banana that never changes owner cannot be thrown back", async () => {
  /* The pickup still works, the dream is still paid, the throw still comes
     out and the banana still flies at him -- and goes through him. Nothing
     on screen says anything is wrong. */
  const run = await arena(sabotage(
    "    b.owner = this;",
    "    b.owner = b.owner;"));
  expectToFail(() => checkChangesHands(run, JSON.parse(changesHands(run))),
    "with ownership never moving the item test should fail; it passed");
});

/* =====================================================================
   4. IT HITS ONCE, AND IT DOES NOT BREAK
   ===================================================================== */

/* TWO PROPERTIES THAT PULL AGAINST EACH OTHER, which is why they are
   measured together. It has to SURVIVE the hit -- that is what `burst` is
   for and it is what makes it an item rather than a shot -- and having
   survived it, it must stop being a hitbox, or it is still sitting on top of
   the man it just hit.

   That second half is not hypothetical. Before it was fixed, one forward
   throw into a parked fighter hit him on EIGHT CONSECUTIVE FRAMES: 100 to 68
   health and 48 dream off a move whose damage is four because "the stun is
   the payload". */
const theHit = (run) => run(`(function () {
  seat();
  var me = fighters[0], foe = fighters[1];
  foe.x = MAIN.x + 130; foe.invuln = 0;
  var b = drop(0, me.x);
  me.catchBanana(b, false);
  me.landLag = 0; me.facing = 1; me.dream = 0;
  tick(${GRAB});
  var hp0 = foe.health, hits = 0, prev = foe.health, pinned = 0, firstAt = -1;
  for (var i = 1; i <= 160; i++) {
    tick(0);
    if (foe.health < prev) { hits++; if (firstAt < 0) firstAt = i; prev = foe.health; }
    if (foe.hitstun > 0 || foe.hitstop > 0) pinned++;
  }
  var alive = nanas()[0];
  return JSON.stringify({
    hits: hits, firstAt: firstAt, damage: hp0 - foe.health, pinned: pinned,
    alive: !!alive, grounded: alive ? alive.grounded : null,
    heldBy: alive ? alive.heldBy : null, live: alive ? alive.live() : null,
    toFoe: alive ? +Math.abs(alive.x - foe.x).toFixed(1) : null,
    toMe: alive ? +Math.abs(alive.x - me.x).toFixed(1) : null,
    dream: me.dream });
})()`);

function checkTheHit(run, r) {
  const s = spec(run);
  const cap = JSON.parse(run("JSON.stringify(COMBAT.hitstunCap)"));
  assert.ok(r.firstAt > 0, "precondition: the throw has to reach him at all");

  assert.equal(r.hits, 1,
    "ONE THROW IS ONE HIT. A banana that survives its own hit is a banana " +
    "still overlapping the man it hit, and without something to stop it that " +
    "is a multi-hit nobody designed: it connected " + r.hits + " times for " +
    r.damage + " damage");
  assert.equal(r.damage, s.damage,
    "for `damage` (" + s.damage + "), which is a nudge; it did " + r.damage);

  assert.ok(r.pinned >= s.stun,
    "AND THE STUN IS THE PAYLOAD. `stun` is " + s.stun + " and it is written " +
    "into hitstun, which is past what an ordinary hit of this size could " +
    "produce -- the cap on a normal launch is " + cap + ". He was pinned " +
    r.pinned + " frames");

  assert.equal(r.alive, true,
    "AND IT DOES NOT BREAK ON HIM. `burst` is the hook resolveCombat calls " +
    "IN PLACE OF killing a shot, and this is the one class in the file that " +
    "wants it for that reason: an item that shatters when it connects is not " +
    "an item, it is a projectile with a long hitstun");
  assert.equal(r.grounded, true, "it comes to rest on the floor");
  assert.equal(r.heldBy, -1, "belonging to nobody");
  assert.equal(r.live, false,
    "and it is not a hitbox lying there; live() said " + r.live);
  assert.ok(r.toFoe < r.toMe,
    "AND IT LANDS CLOSER TO HIM THAN TO YOU, which is where the whole mind " +
    "game lives: throwing it at somebody hands them the thing in exchange " +
    "for a beat of silence, and then you have to go and get it. It came to " +
    "rest " + r.toFoe + " from him and " + r.toMe + " from the man who threw it");
  assert.equal(r.dream, s.stunDream,
    "and connecting pays `stunDream` (" + s.stunDream + "), half a catch, so " +
    "throwing it at somebody is a choice and not a tax; he banked " + r.dream);
}

test("a thrown banana hits once, pins, and survives to lie at their feet", async () => {
  const run = await arena();
  checkTheHit(run, JSON.parse(theHit(run)));
});

test("negative control: a banana that breaks on contact fails the item test", async () => {
  /* The version anybody would write by accident, because it is what every
     other shot in the file does. It still hits, still stuns, still pays the
     dream -- and there is nothing on the floor afterwards, so the move is a
     four-damage projectile with a long stun and no second act. */
  const run = await arena(sabotage(
    "    this.numb = -1;\n    this.vx *= 0.35;",
    "    this.numb = -1;\n    this.dead = true;\n    this.vx *= 0.35;"));
  expectToFail(() => checkTheHit(run, JSON.parse(theHit(run))),
    "with the banana breaking on contact the item test should fail; it passed");
});

/* =====================================================================
   5. WHAT COUNTS AS A HITBOX
   ===================================================================== */

/* `live()` is this file's word for "is it a hitbox right now", and it is
   asked by two loops that have nothing to do with each other: resolveCombat,
   and the absorb sweep that lets Cobeus' open mouth eat a shot. A banana
   that answered yes on the floor would be an invisible hazard every
   character walks into, and food for a mouth opened on an empty stage. */
const threeStates = (run) => run(`(function () {
  seat();
  var me = fighters[0], out = {};
  tick(${SP_DOWN});
  for (var i = 0; i < 16; i++) tick(0);
  var b = nanas()[0];
  out.air = { live: b.live(), grounded: b.grounded, heldBy: b.heldBy, numb: b.numb };
  var g = 0; while (!me.heldBanana() && g++ < 200) tick(0);
  b = nanas()[0];
  out.hand = { live: b.live(), grounded: b.grounded, heldBy: b.heldBy };
  tick(${GRAB});
  for (var i = 0; i < 240; i++) tick(0);
  b = nanas()[0];
  out.floor = b ? { live: b.live(), grounded: b.grounded, heldBy: b.heldBy } : null;
  return JSON.stringify(out);
})()`);

function checkThreeStates(r) {
  assert.ok(r.air && r.hand && r.floor,
    "precondition: the banana has to reach all three states -- in the air, " +
    "in a hand and on the floor; it did not");
  assert.equal(r.air.numb, 0, "precondition: past its numb frames in the air");
  assert.equal(r.air.live, true,
    "IN THE AIR IT IS A SHOT. That is the only window in which it can hurt " +
    "anybody, and live() said " + r.air.live);
  assert.equal(r.hand.live, false,
    "IN A HAND IT IS LUGGAGE. A carried banana that answered yes would hit " +
    "the man carrying it the moment somebody walked past, and would be eaten " +
    "off his shoulder by an open mouth");
  assert.equal(r.floor.live, false,
    "AND ON THE FLOOR IT IS FURNITURE -- the same clause that already keeps " +
    "a stretch of road, an uncurdled puddle and an idle bot out of a mouth. " +
    "live() said " + r.floor.live + " for one lying on the ground");
}

test("a banana is a hitbox in the air and nowhere else", async () => {
  const run = await arena();
  checkThreeStates(JSON.parse(threeStates(run)));
});

test("negative control: a banana that is always live is a hazard nobody authored", async () => {
  const run = await arena(sabotage(
    "  live() { return this.heldBy < 0 && !this.grounded && this.numb === 0; }",
    "  live() { return true; }"));
  expectToFail(() => checkThreeStates(JSON.parse(threeStates(run))),
    "with live() always true the hitbox-window test should fail; it passed");
});

/* =====================================================================
   6. TWO MEN REACHING FOR ONE
   ===================================================================== */

/* WHOEVER THE ENGINE ASKS FIRST GETS IT, and that has to be a rule rather
   than an accident, because it is the tie-break a player will meet the first
   time two people dive for the same banana. updateBattle walks `fighters`
   forwards, so it is the lower seat -- the same order every other
   simultaneous question in this game is settled by.

   THE TWO MEN ARE POINTED AWAY FROM EACH OTHER on purpose. A pickup is
   refused while somebody is standing in your grab box (test 14), so two men
   facing each other over a banana are not a tie at all -- the near one is
   refused and the far one wins, which measures the wrong rule. The probe
   asserts the boxes are clear before it presses anything. */
const theRace = (run) => run(`(function () {
  seat();
  var me = fighters[0], foe = fighters[1];
  var bx = MAIN.x + 100;
  var b = drop(0, bx);
  me.x = bx - 6; me.facing = -1;
  foe.x = bx + 6; foe.facing = 1;
  var clash = overlap(me.relBox(BASIC_GRAB), foe.hurtbox()) ||
              overlap(foe.relBox(BASIC_GRAB), me.hurtbox());
  var reach = [Math.abs(b.x - me.x) <= BS.reach, Math.abs(b.x - foe.x) <= BS.reach];
  tick(${GRAB}, ${GRAB});
  var race = { clash: clash, reach: reach, heldBy: b.heldBy,
               owner: b.owner.slot, meDream: me.dream, foeDream: foe.dream };

  /* AND THE SAME ORDER IS WHY drawFighter DOES NOT KNOW THIS MOVE EXISTS.
     A fighter updates before the projectiles do, so a banana picked up on
     this frame has already been parked on its carrier's shoulder by its own
     update() before anything draws -- which is why a carried banana
     composites for free on all eleven characters and on a chicken, with none
     of the hand-written special-casing the sword needs.

     A loose one at his feet, rather than his own toss out of the air: the
     pickup measures lift2 from his FEET and his own toss is over his head
     (no backticks in here: this comment is inside a template literal, and one
     backtick anywhere in it silently ends the string)
     for the whole of the window it is catchable in, so a press can never
     beat the free catch to it and the two routes cannot be raced. */
  seat();
  me = fighters[0];
  var q = drop(0, me.x + 2);
  tick(${GRAB});
  var onFrame = { heldBy: q.heldBy, landLag: me.landLag,
                  dx: +(q.x - (me.x + me.facing * 5)).toFixed(6),
                  dy: +(q.y - (me.y - 15)).toFixed(6),
                  grounded: q.grounded };
  return JSON.stringify({ race: race, onFrame: onFrame });
})()`);

function checkTheRace(run, r) {
  const s = spec(run);
  assert.equal(r.race.clash, false,
    "precondition: neither man may be standing in the other's grab box, or " +
    "this measures the grab rule instead of the tie-break");
  assert.deepEqual(r.race.reach, [true, true],
    "precondition: the banana has to be inside `reach` (" + s.reach + ") of " +
    "BOTH of them, or there is no tie to break");

  assert.equal(r.race.heldBy, 0,
    "THE LOWER SEAT GETS IT. updateBattle walks `fighters` forwards and that " +
    "is the tie-break, the same as every other simultaneous question in this " +
    "game; heldBy read " + r.race.heldBy);
  assert.equal(r.race.owner, 0, "and owns it");
  assert.equal(r.race.meDream, s.catchDream, "and is paid for it");
  assert.equal(r.race.foeDream, 0,
    "and the man who did not get it is paid nothing; he banked " + r.race.foeDream);

  assert.equal(r.onFrame.heldBy, 0,
    "precondition: a press on a loose banana at his feet picks it up");
  assert.ok(r.onFrame.landLag > 0,
    "A PRESS IS A DECISION AND COSTS THE LAG, unlike the gift of his own " +
    "toss falling into his hand; it cost " + r.onFrame.landLag + " frames");
  assert.equal(r.onFrame.grounded, false,
    "a banana in a hand is not on the floor any more, whatever it was doing " +
    "a frame ago");
  assert.equal(r.onFrame.dx, 0,
    "AND IT IS ALREADY ON HIS SHOULDER ON THE FRAME HE TOOK IT. A fighter " +
    "updates before the projectiles do, so the banana's own update() has put " +
    "it there before anything draws -- which is the whole reason drawFighter " +
    "needs not one line for this move and a carried banana composites for " +
    "free on all eleven characters. It was " + r.onFrame.dx +
    " pixels off horizontally");
  assert.equal(r.onFrame.dy, 0, "and " + r.onFrame.dy + " vertically");
}

test("two men reaching for one banana: the lower seat gets it", async () => {
  const run = await arena();
  checkTheRace(run, JSON.parse(theRace(run)));
});

test("negative control: walking the fighters backwards flips the tie-break", async () => {
  const run = await arena(sabotage(
    "  for (let i = 0; i < fighters.length; i++) {\n    fighters[i].update(pads[i]);\n  }",
    "  for (let i = fighters.length - 1; i >= 0; i--) {\n    fighters[i].update(pads[i]);\n  }"));
  expectToFail(() => checkTheRace(run, JSON.parse(theRace(run))),
    "with the fighters walked backwards the tie-break test should fail; it passed");
});

/* =====================================================================
   7. AND NONE OF IT IS ON THE FIGHTER
   ===================================================================== */

/* THE ROLLBACK PROPERTY, and it is the reason the design puts who-is-holding
   -what on the BANANA rather than on the man. restoreSim rebuilds every
   projectile out of its snapshot, key by key, so a field that was not in the
   snapshot simply does not exist afterwards -- and a field assigned outside
   the constructor is exactly that field. It comes back `undefined`, every
   comparison against it is false, and the move quietly stops working on one
   machine and not the other.

   So this asserts two things: that a pickup replayed across a rewind lands
   in the identical state, and that the banana's own key set after a restore
   is the constructor's. */
const theRewind = (run) => run(`(function () {
  seat();
  var me = fighters[0];
  tick(${SP_DOWN});
  for (var i = 0; i < 18; i++) tick(0);
  var snap = saveSim();
  var live = function () {
    var b = fighters[0].heldBanana();
    return b ? { heldBy: b.heldBy, owner: b.owner.slot, numb: b.numb,
                 mine: b.mine, grounded: b.grounded, t: b.t,
                 dream: fighters[0].dream } : null;
  };
  var run1 = null, g = 0;
  while (!fighters[0].heldBanana() && g++ < 200) tick(0);
  run1 = live();
  var after1 = { x: +fighters[0].x.toFixed(4), frames: g };

  restoreSim(snap);
  var b = nanas()[0];
  var back = { heldBy: b.heldBy, dream: fighters[0].dream, t: b.t,
               keys: Object.keys(b).sort() };

  g = 0;
  while (!fighters[0].heldBanana() && g++ < 200) tick(0);
  var run2 = live();
  var after2 = { x: +fighters[0].x.toFixed(4), frames: g };

  /* And the throw, across a rewind of its own. */
  var snap2 = saveSim();
  tick(${GRAB});
  var t1 = (function () { var q = nanas()[0];
    return { vx: +q.vx.toFixed(6), vy: +q.vy.toFixed(6), heldBy: q.heldBy,
             numb: q.numb, t: q.t }; })();
  restoreSim(snap2);
  tick(${GRAB});
  var t2 = (function () { var q = nanas()[0];
    return { vx: +q.vx.toFixed(6), vy: +q.vy.toFixed(6), heldBy: q.heldBy,
             numb: q.numb, t: q.t }; })();

  return JSON.stringify({ run1: run1, run2: run2, after1: after1,
                          after2: after2, back: back, t1: t1, t2: t2 });
})()`);

const BANANA_KEYS = ["dead", "grounded", "heldBy", "life", "mine", "numb",
                     "owner", "spec", "t", "vx", "vy", "x", "y"];

function checkTheRewind(r) {
  assert.ok(r.run1 && r.run2,
    "precondition: the catch has to happen on both passes; it did not");
  assert.equal(r.back.heldBy, -1,
    "precondition: the snapshot is taken while the banana is still in the " +
    "air, so the restore has to put it back out of his hand");
  assert.equal(r.back.dream, 0,
    "precondition: and before the catch was paid for");

  assert.deepEqual(r.run2, r.run1,
    "A PICKUP REPLAYED ACROSS A REWIND LANDS IN THE SAME PLACE. Everything " +
    "this move owns is on the banana and every field of it is declared in " +
    "the constructor, so there is nothing for restoreSim to delete. Before " +
    "the rewind: " + JSON.stringify(r.run1) + "; after: " + JSON.stringify(r.run2));
  assert.equal(r.after2.frames, r.after1.frames,
    "on the same frame, too; it took " + r.after1.frames + " then " +
    r.after2.frames);

  assert.deepEqual(r.back.keys, BANANA_KEYS,
    "AND THE BANANA COMES BACK WHOLE. restoreSim rebuilds a projectile out " +
    "of its snapshot key by key, so a field assigned anywhere but the " +
    "constructor is simply gone after a rewind -- undefined, every " +
    "comparison against it false, and the move stops working on one machine " +
    "only. Its keys after the restore were " + JSON.stringify(r.back.keys));

  assert.deepEqual(r.t2, r.t1,
    "and the THROW replays identically too, down to the velocity it leaves " +
    "at: " + JSON.stringify(r.t1) + " then " + JSON.stringify(r.t2));
}

test("the pickup and the throw both survive a rollback", async () => {
  const run = await arena();
  checkTheRewind(JSON.parse(theRewind(run)));
});

test("negative control: a field the class writes and never declares", async () => {
  /* One line in update(), which is where anybody who had not been bitten by
     this would put it. It is invisible in ordinary play -- the banana flies,
     catches, throws and lands exactly as it does now -- and the only place it
     shows is the key set on the far side of a rewind, which is precisely the
     failure this test exists for. restoreSim rebuilds a projectile key by
     key, so the sim carries a field one machine has and another does not,
     and the desync that produces has nothing on screen pointing at it.

     A field REMOVED from the constructor was the first version of this
     control and it was the wrong one: an undeclared `numb` is undefined,
     live() can never say yes, the free catch never happens, and the test
     failed a precondition without ever reaching the rollback. */
  const run = await arena(sabotage(
    "    this.t++;\n    if (this.numb > 0) this.numb--;",
    "    this.t++;\n    this.seen = this.t;\n    if (this.numb > 0) this.numb--;"));
  expectToFail(() => checkTheRewind(JSON.parse(theRewind(run))),
    "with `numb` undeclared the rollback test should fail; it passed");
});

/* =====================================================================
   8. A MAN WITH NO HANDS IS NOT HOLDING ANYTHING
   ===================================================================== */

/* Two ways to stop being somebody who can hold a banana, and the same answer
   to both: it goes on the floor. It is NOT destroyed, because it was never
   his to destroy -- it is a thing on the floor that happened to be off the
   floor for a moment, and the man standing under a man being run over gets a
   present.

   The precedent this follows is written into becomeChicken already: a mower
   still driving keeps going because it stopped being his the moment he cast
   it, and a sword in his hand did not. A banana in his hand did not either. */
const noHands = (run) => run(`(function () {
  var out = {};
  function trial(how) {
    seat();
    var me = fighters[0];
    var g = 0;
    tick(${SP_DOWN});
    while (!me.heldBanana() && g++ < 200) tick(0);
    var before = !!me.heldBanana();
    if (how === 'chicken') me.becomeChicken(); else me.koed();
    var b = nanas()[0];
    return { before: before, held: !!me.heldBanana(),
             inWorld: nanas().length,
             heldBy: b ? b.heldBy : null,
             grounded: b ? b.grounded : null };
  }
  out.chicken = trial('chicken');
  out.ko = trial('ko');
  return JSON.stringify(out);
})()`);

function checkNoHands(r) {
  for (const [what, v] of [["turned into a chicken", r.chicken],
                           ["knocked out", r.ko]]) {
    assert.equal(v.before, true,
      "precondition: he has to be holding one before he is " + what);
    assert.equal(v.held, false,
      "A MAN " + what.toUpperCase() + " IS NOT HOLDING A BANANA. A chicken " +
      "has no hands and a body flying off the stage has no hands either, and " +
      "the alternative is a banana parked on the shoulder of something that " +
      "is not there");
    assert.equal(v.inWorld, 1,
      "and it is still in the world -- dropped, not destroyed; there are " +
      v.inWorld + " of them");
    assert.equal(v.heldBy, -1, "belonging to nobody");
    assert.equal(v.grounded, false,
      "and falling rather than teleported to the floor; it should pop out of " +
      "his hands and come down");
  }
}

test("a man knocked out or turned into a chicken drops the banana", async () => {
  const run = await arena();
  checkNoHands(JSON.parse(noHands(run)));
});

test("negative control: a chicken that keeps hold of it", async () => {
  /* Beside swordTimer and dashFart in the enumeration of things a fighter
     CARRIES, and taking it out leaves a bird walking around with a banana
     floating at its shoulder that nobody can take off it. */
  const run = await arena(sabotage(
    "       floor that happened to be off the floor for a moment. */\n" +
    "    const carried = this.heldBanana();",
    "       floor that happened to be off the floor for a moment. */\n" +
    "    const carried = null;"));
  expectToFail(() => checkNoHands(JSON.parse(noHands(run))),
    "with the chicken keeping it the no-hands test should fail; it passed");
});

/* =====================================================================
   9. AND GETTING HIT TAKES IT OFF YOU
   ===================================================================== */

/* THE ANTI-CAMPING RULE, and it is the one thing grafted in from the design
   this one beat. Holding a banana over your head is not free: a hit pops it
   out of your hands and it lands where anybody can reach it.

   It also expires the free-catch window on the way out. Being hit does not
   hand you back the courtesy you got for throwing it to yourself -- `t` goes
   past `mine` in loose(), so the banana on the floor afterwards is
   everybody's from the moment it leaves him. */
const hitDropsIt = (run) => run(`(function () {
  seat();
  var me = fighters[0], foe = fighters[1];
  var g = 0;
  tick(${SP_DOWN});
  while (!me.heldBanana() && g++ < 200) tick(0);
  var b = me.heldBanana();
  var before = { held: !!b, t: b.t, mine: b.mine, fresh: b.t < b.mine };
  applyHit(foe, me, ROSTER.reese.jab, foe.x);
  b = nanas()[0];
  var after = { held: !!me.heldBanana(), heldBy: b.heldBy, grounded: b.grounded,
                vy: +b.vy.toFixed(2), numb: b.numb, expired: b.t >= b.mine,
                hitstun: me.hitstun };
  for (var i = 0; i < 200; i++) tick(0);
  b = nanas()[0];
  var rest = b ? { grounded: b.grounded, heldBy: b.heldBy, live: b.live() } : null;
  return JSON.stringify({ before: before, after: after, rest: rest });
})()`);

function checkHitDropsIt(r) {
  assert.equal(r.before.held, true, "precondition: he is holding one");
  assert.equal(r.before.fresh, true,
    "precondition: and it is still inside its free-catch window, or the last " +
    "assertion below passes for free");
  assert.ok(r.after.hitstun > 0, "precondition: the hit put him in hitstun");

  assert.equal(r.after.held, false,
    "A HIT KNOCKS IT OUT OF HIS HANDS. That is the anti-camping rule and it " +
    "is the whole reason holding one over your head is not free; he was " +
    "still holding it");
  assert.equal(r.after.heldBy, -1, "it belongs to nobody in mid-air");
  assert.ok(r.after.vy < 0, "it pops UP out of his hands; vy was " + r.after.vy);
  assert.ok(r.after.numb > 0,
    "and it cannot hit anybody on the way out of the hands it just left; " +
    "numb read " + r.after.numb);
  assert.equal(r.after.expired, true,
    "AND THE FREE CATCH IS OVER. `t` goes past `mine`, so a banana knocked " +
    "out of him is everybody's from the moment it leaves him -- being hit " +
    "does not hand back the courtesy he got for throwing it to himself");

  assert.ok(r.rest, "and it is still in the world when the dust settles");
  assert.equal(r.rest.grounded, true, "lying on the floor");
  assert.equal(r.rest.live, false, "and not a hitbox there");
}

test("a hit knocks the banana out of his hands", async () => {
  const run = await arena();
  checkHitDropsIt(JSON.parse(hitDropsIt(run)));
});

test("negative control: a carrier who keeps it through hitstun", async () => {
  /* Which is what every other thing a fighter carries does, and is why this
     had to be written in rather than inherited: nothing else in this engine
     drops anything. A carrier who keeps it is a carrier who can stand under
     a platform holding one forever. */
  const run = await arena(sabotage(
    "  const dropped = defender.heldBanana();\n  if (dropped) dropped.loose(dir * 1.2, -2.2);",
    "  const dropped = null;\n  if (dropped) dropped.loose(dir * 1.2, -2.2);"));
  expectToFail(() => checkHitDropsIt(JSON.parse(hitDropsIt(run))),
    "with the carrier keeping it through hitstun the drop test should fail; it passed");
});

/* =====================================================================
   10. ONE EACH
   ===================================================================== */

/* `maxAlive` is a cap PER OWNER, not per stage, and canSpecial enforces it by
   object identity -- it counts projectiles whose `spec` IS this move. That is
   the existing machinery and it is the right shape here for a reason worth
   writing down: a cap on the stage would mean a four-player match in which
   the first man to throw one denies the move to the other three. */
const oneEach = (run) => run(`(function () {
  seat();
  var me = fighters[0], foe = fighters[1];
  var presses = 0;
  tick(${SP_DOWN});
  for (var i = 0; i < 90; i++) {
    me.landLag = 0; me.mana = 100;
    if (me.state === 'idle') presses++;
    tick(${SP_DOWN});
  }
  var his = nanas().length;
  // The other man cannot throw one -- he is Reese -- so his is placed by
  // hand, which is the only part of the world this test invents.
  drop(1, foe.x);
  return JSON.stringify({ presses: presses, his: his, both: nanas().length });
})()`);

function checkOneEach(run, r) {
  const s = spec(run);
  assert.ok(r.presses > 3,
    "precondition: the probe has to actually press the button several more " +
    "times than the cap allows; it pressed " + r.presses);
  /* ONE, as an absolute rather than as `s.maxAlive`. A test that reads the
     cap out of the spec and then asserts the world matches it passes for any
     cap at all, which is a test of arithmetic and not of the move. One is
     the number because two bananas in one hand is a man who has stopped
     having to choose when to throw one. */
  assert.equal(s.maxAlive, 1,
    "`maxAlive` is the cap and it is one; the spec says " + s.maxAlive);
  assert.equal(r.his, 1,
    "ONE BANANA A MAN. canSpecial refuses the press while one of his is " +
    "still in the world, which is what stops a stage tiled with them; " +
    r.presses + " presses left " + r.his);
  assert.equal(r.both, 2,
    "AND THE CAP IS PER OWNER. Two men with one each is two on the stage, " +
    "because canSpecial counts by owner and by spec identity -- a cap on the " +
    "stage would let the first man to throw one take the move away from " +
    "everybody else; there were " + r.both);
}

test("one banana a man, and the cap is per owner rather than per stage", async () => {
  const run = await arena();
  checkOneEach(run, JSON.parse(oneEach(run)));
});

test("negative control: three at a time is a stage tiled with them", async () => {
  const run = await arena(sabotage(
    "      startup: 8, active: 1, recovery: 10, maxAlive: 1,",
    "      startup: 8, active: 1, recovery: 10, maxAlive: 3,"));
  expectToFail(() => checkOneEach(run, JSON.parse(oneEach(run))),
    "with three allowed at once the one-each test should fail; it passed");
});

/* =====================================================================
   11. THE FRAMES IT IS NOTHING AT ALL
   ===================================================================== */

/* `numb` is the handful of frames on which a banana neither hits nor can be
   caught, and it has three jobs that are all the same job: it stops a
   point-blank toss coming straight back into the man who threw it, it stops
   one that has just been knocked out of somebody hitting them again on the
   way out, and it is what makes one throw one hit.

   Measured with the other man standing ON him, which is the case it was
   written for. */
const theNumb = (run) => run(`(function () {
  seat();
  var me = fighters[0], foe = fighters[1];
  foe.x = me.x; foe.invuln = 0; foe.stocks = 9;
  var hp0 = foe.health, rows = [], hurtWhileNumb = 0, caughtWhileNumb = 0;
  tick(${SP_DOWN});
  for (var i = 0; i < 24; i++) {
    var b = nanas()[0];
    if (b) {
      rows.push([i, b.numb, b.live()]);
      if (b.numb > 0) {
        if (foe.health < hp0) hurtWhileNumb++;
        if (b.heldBy >= 0) caughtWhileNumb++;
      }
    }
    // Press grab every frame: he must not be able to take it back early.
    me.landLag = 0;
    tick(${GRAB});
  }
  return JSON.stringify({ rows: rows, hurtWhileNumb: hurtWhileNumb,
                          caughtWhileNumb: caughtWhileNumb, foeHp: foe.health,
                          hp0: hp0 });
})()`);

function checkTheNumb(run, r) {
  const s = spec(run);
  assert.ok(r.rows.length > 0,
    "precondition: the probe has to see the banana at all; it saw none of it");

  /* NOT a precondition, which is what this was first written as and why the
     control for it fired the wrong message. `numb` being greater than zero is
     the claim, not the setup: a move with no numb frames is the bug. */
  assert.ok(s.numb > 0,
    "THE BANANA NEEDS FRAMES ON WHICH IT IS NOTHING AT ALL. `numb` is what " +
    "stops a point-blank toss being a free hit on the frame it spawns, on a " +
    "man standing close enough to be inside it, and what stops one just " +
    "knocked out of somebody hitting them again on the way out. It is " + s.numb);
  const numbRows = r.rows.filter((x) => x[1] > 0);
  assert.ok(numbRows.length > 0,
    "and the probe has to see some of them; it saw " + r.rows.length +
    " frames of the banana and none of them numb");

  for (const [frame, numb, live] of numbRows) {
    assert.equal(live, false,
      "A NUMB BANANA IS NOT A HITBOX. Without this a point-blank toss is a " +
      "free hit on the frame it spawns, on a man standing close enough to be " +
      "inside it; on frame " + frame + " numb was " + numb + " and live() " +
      "said " + live);
  }
  assert.equal(r.foeHp, r.hp0,
    "so a man standing right on top of him takes NOTHING from the toss -- " +
    "which is the whole of what numb is for, because a banana leaves his " +
    "hand inside its own thrower's body; he lost " + (r.hp0 - r.foeHp));
  assert.equal(r.hurtWhileNumb, 0,
    "and none of it on a numb frame in particular");
  assert.equal(r.caughtWhileNumb, 0,
    "AND IT CANNOT BE TAKEN BACK EARLY EITHER, with the button held down " +
    "every frame -- otherwise a point-blank forward throw comes straight " +
    "back into the hand it left");
}

test("a banana is neither a hitbox nor catchable on the frames it is numb", async () => {
  const run = await arena();
  checkTheNumb(run, JSON.parse(theNumb(run)));
});

test("negative control: no numb frames at all", async () => {
  const run = await arena(sabotage(
    "      life: 900, mine: 45, numb: 6, reach: 11, lift2: 14,",
    "      life: 900, mine: 45, numb: 0, reach: 11, lift2: 14,"));
  expectToFail(() => checkTheNumb(run, JSON.parse(theNumb(run))),
    "with no numb frames the numb test should fail; it passed");
});

/* =====================================================================
   12. THE SPEC IS THE MOVE
   ===================================================================== */

/* EVERY NUMBER THIS CLASS READS IS READ OFF THE SPEC, and a missing one is
   not an error anywhere -- it is `undefined`, and `undefined` arithmetic is
   NaN. A banana thrown with a NaN velocity is a banana at NaN, which is
   nowhere: it never lands, never dies, never hits, and the only thing on
   screen is a move that does nothing. So the keys are asserted to exist, and
   then the three throw directions are measured through the real pad to prove
   the ones that steer it are actually wired to it. */
const theAims = (run) => run(`(function () {
  function throwWith(bits) {
    seat();
    var me = fighters[0];
    var b = drop(0, me.x);
    me.catchBanana(b, false);
    me.landLag = 0; me.facing = 1;
    tick(${GRAB} | bits);
    return { vx: +b.vx.toFixed(6), vy: +b.vy.toFixed(6), heldBy: b.heldBy };
  }
  return JSON.stringify({ fwd: throwWith(0), up: throwWith(${UPDIR}),
                          dn: throwWith(${DOWNDIR}) });
})()`);

function checkTheAims(run, r) {
  const s = spec(run);
  const NEEDED = ["kind", "label", "startup", "active", "recovery", "maxAlive",
                  "manaOverride", "lift", "drop", "life", "mine", "numb",
                  "reach", "lift2", "catchDream", "stunDream", "stun",
                  "damage", "base", "scale", "angle", "kx", "ky",
                  "fwdX", "fwdY", "upX", "upY", "dnX", "dnY"];
  for (const k of NEEDED) {
    assert.ok(s[k] !== undefined && s[k] === s[k],
      "`" + k + "` has to be on the spec: class Banana reads every number it " +
      "uses off this object, and a missing one is undefined rather than an " +
      "error -- which becomes NaN velocity, which is a banana nowhere at all. " +
      "It read " + s[k]);
  }
  assert.equal(s.kind, "toss", "the slot holds a `toss`; it is " + s.kind);
  assert.equal(s.label, "BANANA", "labelled BANANA; it is " + s.label);

  for (const [name, got, wantX, wantY] of [
    ["forward", r.fwd, s.fwdX, s.fwdY],
    ["up", r.up, s.upX, s.upY],
    ["down", r.dn, s.dnX, s.dnY]]) {
    assert.equal(got.heldBy, -1,
      "precondition: the " + name + " throw has to leave his hand at all");
    assert.ok(Math.abs(got.vx - wantX) < 1e-9,
      "the " + name + " throw leaves at the spec's own vector (" + wantX +
      "), facing right; it left at " + got.vx);
    /* Plus one frame of its own gravity, which has already run by the time
       the frame ends: the banana updates AFTER the fighter who threw it, and
       reading the velocity before that would mean reaching inside a frame. */
    assert.ok(Math.abs(got.vy - (wantY + s.drop)) < 1e-9,
      "and at its own vy (" + wantY + ", plus the " + s.drop + " of gravity " +
      "that has already run by the end of the frame); it left at " + got.vy);
  }
  assert.ok(r.up.vy < r.fwd.vy && r.fwd.vy < r.dn.vy,
    "AND THE THREE ARE ACTUALLY THREE. Holding up throws it higher than " +
    "neutral and holding down throws it lower, or the direction on the stick " +
    "is decoration: up " + r.up.vy + ", level " + r.fwd.vy + ", down " + r.dn.vy);
}

test("every number the banana reads is on the spec, and all three aims are wired", async () => {
  const run = await arena();
  checkTheAims(run, JSON.parse(theAims(run)));
});

test("negative control: a throw vector the spec does not carry", async () => {
  /* The forward throw with no `fwdX`, which is the one a player uses most.
     Nothing throws, nothing logs, and the banana goes to NaN -- where it
     never lands, never expires and never hits anybody. */
  const run = await arena(sabotage(
    "      fwdX: 4.6, fwdY: -0.9, upX: 0.7, upY: -5.0, dnX: 2.4, dnY: 2.2,",
    "      fwdY: -0.9, upX: 0.7, upY: -5.0, dnX: 2.4, dnY: 2.2,"));
  expectToFail(() => checkTheAims(run, JSON.parse(theAims(run))),
    "with `fwdX` off the spec the aim test should fail; it passed");
});

/* =====================================================================
   13. AND IT IS WHERE THE DRAGON COMES FROM
   ===================================================================== */

/* THE TEST THE BAKERY'S ONE BECAME. SALAMENCE is an instant kill, so the
   meter cannot buy damage -- there is nowhere above an instant kill for it to
   go -- and what it buys instead is SPEED: an empty meter strolls out at
   `speed` and a full one arrives at `speed` plus `dreamSpeed`, which is the
   difference between walking out of the way and having to commit to a jump.

   The daydream used to fill that meter in bulk and paid him for standing
   still. This fills it by being CAUGHT. The probe therefore throws and
   catches and does nothing else whatsoever -- no stars, no whip, nobody hit
   -- so the only thing the dragon can be made of is bananas. */
const theDragon = (run) => run(`(function () {
  seat();
  var me = fighters[0], catches = 0;
  for (var round = 0; round < 6; round++) {
    var g = 0;
    me.mana = 100; me.landLag = 0; me.specialSpawned = false;
    tick(${SP_DOWN});
    while (!me.heldBanana() && g++ < 200) tick(0);
    if (me.heldBanana()) catches++;
    // and put it back in the world so the next press is not refused
    projectiles.length = 0;
    me.setState('idle'); me.attackFrame = 0; me.landLag = 0;
  }
  var dream = me.dream;
  me.ultMeter = 999; me.landLag = 0; me.setState('idle');
  tick(${ULT});
  var vx = null;
  for (var i = 0; i < 240 && vx === null; i++) {
    tick(0);
    for (var k = 0; k < projectiles.length; k++) {
      if (projectiles[k].constructor.name === 'Salamence') {
        vx = Math.abs(projectiles[k].vx); break;
      }
    }
  }
  var u = ROSTER.squalls.ult;
  return JSON.stringify({ catches: catches, dream: dream, vx: vx,
                          floor: u.speed, span: u.dreamSpeed, max: u.dreamMax,
                          power: vx === null ? null : (vx - u.speed) / u.dreamSpeed });
})()`);

function checkTheDragon(r) {
  assert.ok(r.catches >= 3,
    "precondition: the probe has to actually catch several bananas, or the " +
    "meter is empty for the wrong reason; it caught " + r.catches);
  assert.ok(r.vx !== null, "precondition: the dragon has to fly at all");
  assert.ok(r.span > 0,
    "precondition: the meter has to buy something (" + r.span + ")");

  assert.ok(r.dream > 0,
    "A MAN WHO ONLY EVER THROWS AND CATCHES BANANAS STILL FILLS THE METER. " +
    "That is the supply the daydream used to be and it is the whole reason " +
    "this move has a `catchDream` at all; he banked " + r.dream);
  assert.ok(r.power >= 0.28,
    "AND THE DRAGON IS FASTER FOR IT. `dreamSpeed` is what the meter buys, " +
    "and a dragon at its floor speed is a dragon everybody walks away from " +
    "-- 1376 measured ults say so. He flew at " + r.vx + " against a floor " +
    "of " + r.floor + " and a ceiling of " + (r.floor + r.span) + ", which is " +
    Math.round(r.power * 100) + "% of the meter");
}

test("the banana is where the dragon's speed comes from now", async () => {
  const run = await arena();
  checkTheDragon(JSON.parse(theDragon(run)));
});

test("negative control: catchDream zeroed leaves him with the slow dragon", async () => {
  /* The ablation, and it is the failure that has no symptom. He still throws
     it, still catches it, still has an item on the floor and still plays the
     whole move exactly as designed. The meter simply never moves, and four
     casts later the dragon strolls across the stage at 2.1 and everybody
     walks out of the way. */
  const run = await arena(sabotage(
    "      catchDream: 16, stunDream: 6,",
    "      catchDream: 0, stunDream: 6,"));
  expectToFail(() => checkTheDragon(JSON.parse(theDragon(run))),
    "with catchDream zeroed the dragon test should fail; it passed");
});

/* =====================================================================
   14. A MAN IN FRONT OF YOU OUTRANKS FRUIT ON THE FLOOR
   ===================================================================== */

/* THE ONE CLAUSE IN THIS MOVE THAT IS THERE FOR THE OTHER TEN CHARACTERS.
   Picking a banana up is the grab button, and so is grabbing. Without a rule
   between them, any character standing on a banana loses his grab -- and the
   grab is the only move in this game that beats a raised shield, so what that
   costs is the answer to somebody turtling, taken away by an item he did not
   throw.

   The rule is: if anybody is standing in your grab box, the press is a grab.
   Fruit waits. */
const grabWins = (run) => run(`(function () {
  function trial(gap) {
    seat();
    var me = fighters[0], foe = fighters[1];
    var b = drop(0, me.x + 2);
    foe.x = me.x + gap;
    var inBox = overlap(me.relBox(BASIC_GRAB), foe.hurtbox());
    var reach = Math.abs(b.x - me.x) <= BS.reach;
    tick(${GRAB});
    return { inBox: inBox, reach: reach, heldBy: b.heldBy, state: me.state };
  }
  return JSON.stringify({ close: trial(12), far: trial(90) });
})()`);

function checkGrabWins(r) {
  assert.equal(r.far.inBox, false,
    "precondition: with the other man ninety pixels away he is not in the " +
    "grab box");
  assert.equal(r.close.inBox, true,
    "precondition: and standing twelve pixels away he is");
  assert.equal(r.far.reach, true, "precondition: the banana is in reach both times");
  assert.equal(r.close.reach, true, "precondition: both times");

  assert.equal(r.far.heldBy, 0,
    "with nobody in front of him, grab picks the banana up; heldBy read " +
    r.far.heldBy);

  assert.equal(r.close.heldBy, -1,
    "A MAN IN FRONT OF YOU OUTRANKS FRUIT ON THE FLOOR. Every character in " +
    "this game grabs with this button, and the grab is the only move that " +
    "beats a raised shield -- so a banana that swallowed the press would be " +
    "taking the answer to a turtle away from ten characters who did not " +
    "throw it. The banana was picked up instead");
  assert.equal(r.close.state, "grab",
    "and the press comes out as the grab it was meant to be; he ended in " +
    "state " + r.close.state);
}

test("picking one up is refused while somebody is standing in the grab box", async () => {
  const run = await arena();
  checkGrabWins(JSON.parse(grabWins(run)));
});

test("negative control: fruit that swallows the grab button", async () => {
  const run = await arena(sabotage(
    "        if (!somebodyThere) {",
    "        if (true) {"));
  expectToFail(() => checkGrabWins(JSON.parse(grabWins(run))),
    "with the grab clause gone the grab-wins test should fail; it passed");
});


/* =====================================================================
   15. A BANANA YOU ARE HOLDING IS NOT ROTTING

   `life: 900` is fifteen seconds, and the movelist advertises it as "stays in
   the world for 900f (15s)". THE WORLD is the operative word, and until this
   test the engine did not agree with it.

   `life--` ran at the top of update(), the carried branch returns before the
   three death tests at the bottom, and the death tests are therefore below
   that return. So a banana in a hand aged, could not die, and ran `life`
   negative without bound -- and then died on the FIRST FRAME IT WAS THROWN,
   at the pixel it left from, having travelled nothing, with the eight frames
   of landLag spent on a banana that no longer existed. Measured on the
   shipped engine: caught at life 867, carried 1400 frames to life -533 with
   `dead` still false, thrown, gone one frame later, zero pixels travelled.

   Fifteen seconds is a long time in a three-minute match but it is nothing
   at all in a human one, and the CPU never sees it: aiDecide throws as soon
   as a foe is inside 90 pixels and never carries long enough. No ladder can
   find this. Only somebody playing the move as an ITEM can, which is what
   the move is for.
   ===================================================================== */

const theLongCarry = (run) => run(`(function () {
  seat();
  var b = tossAndCatch();
  if (!b) return JSON.stringify({ err: 'never caught it' });
  var atCatch = b.life, spec = b.spec;
  /* Well past its life, so a banana that ages in a hand is deep into negative
     by the time he throws it. */
  for (var i = 0; i < spec.life + 500; i++) tick(0);
  b = fighters[0].heldBanana();
  var held = b ? { life: b.life, dead: b.dead } : null;
  if (!b) return JSON.stringify({ atCatch: atCatch, held: null, life: spec.life });
  var x0 = b.x;
  tick(${GRAB});
  var lived = 0, far = 0, alive = true;
  for (var i = 0; i < 40; i++) {
    tick(0);
    var q = nanas()[0];
    if (!q) { alive = false; break; }
    lived++; far = Math.abs(q.x - x0);
  }
  return JSON.stringify({ atCatch: atCatch, held: held, life: spec.life,
    framesAfterThrow: lived, stillAlive: alive, travelled: +far.toFixed(2) });
})()`);

function checkTheLongCarry(r) {
  assert.equal(r.err, undefined, "precondition: he has to catch his own toss");
  assert.ok(r.held, "AND HE IS STILL HOLDING IT. A banana carried past its " +
    "own `life` has to still be in his hand -- an item does not evaporate " +
    "out of a fist. It was gone");
  assert.equal(r.held.dead, false, "and it is not dead in his hand");
  assert.ok(r.held.life > 0,
    "AND ITS CLOCK HAS NOT RUN. `life` is the clock on a banana lying in the " +
    "world waiting for somebody to want it, not a clock on a man holding " +
    "one: carried past " + r.life + " frames it still reads " + r.held.life +
    ", and a number below zero is a banana that has been quietly dead for " +
    "seconds while sitting on his shoulder");
  assert.equal(r.held.life, r.atCatch,
    "and it has not moved at all since he caught it; it was " + r.atCatch +
    " and is now " + r.held.life);

  assert.equal(r.stillAlive, true,
    "AND THE THROW IS A THROW. Thrown after a long carry the banana has to " +
    "still be in the world forty frames later; it survived " +
    r.framesAfterThrow);
  assert.ok(r.travelled > 20,
    "and it has to have GONE somewhere -- a banana that dies on the frame it " +
    "leaves his hand looks exactly like a move that did nothing, and costs " +
    "him the eight frames of landLag for it. It travelled " + r.travelled +
    " pixels");
}

test("a banana carried a long time is still a banana when it is thrown", async () => {
  const run = await arena();
  checkTheLongCarry(JSON.parse(theLongCarry(run)));
});

test("negative control: a banana that ages in a hand fails the long-carry test", async () => {
  /* `life--` put back at the top of the frame, where it shipped and where
     anybody would write it. The bug is not that line on its own -- it is
     that line ABOVE a `return`, with the death tests below it. */
  const run = await arena(sabotageBoth(
    "  update() {\n    this.t++;\n    if (this.numb > 0) this.numb--;",
    "  update() {\n    this.t++;\n    this.life--;\n    if (this.numb > 0) this.numb--;",
    "    this.life--;\n\n    if (!this.grounded) {",
    "\n    if (!this.grounded) {"));
  expectToFail(() => checkTheLongCarry(JSON.parse(theLongCarry(run))),
    "with a carried banana ageing the long-carry test should fail; it passed");
});
