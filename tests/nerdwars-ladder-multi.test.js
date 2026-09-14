/* What a free-for-all is worth.
 *
 * The ladder used to count four-way matches and refuse to rate them, because
 * Elo is written for two people and nobody had decided what the third and
 * fourth seat meant. The decision is now made -- the winner takes rating off
 * the losers, scored as though every pair in the room played at once -- and
 * these are the tests that pin the decision down.
 *
 * The one that matters most is the first: a change to how four people are
 * rated must not move a single rating that two people earned. Everything
 * already on the board was folded by the two-player formula, so the new
 * arithmetic has to reproduce it exactly rather than approximately.
 *
 * The rules these lean on -- what counts, what is disputed, where the season
 * starts -- are argued in nerdwars-ladder.test.js. This file is only about
 * the arithmetic once a match has been agreed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LADDER = readFileSync(
  path.join(HERE, "..", "assets", "js", "nerdwars", "ladder.js"), "utf8");

/** ladder.js is a classic script, so it wants a window to attach to. */
function kit(source) {
  const sb = { console, Math, JSON, Object, Array, Promise, String, Number };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(source || LADDER, sb, { filename: "ladder.js" });
  return sb.window.NerdWarsLadderKit;
}

const BASE = kit().SEASON_START;

/** A match as the host writes it, with whatever confirms came back. */
function match(mid, at, uids, winnerSlot, extra) {
  return Object.assign({
    mid, at: BASE + at, uids,
    names: uids.map((u) => u.toUpperCase()),
    chars: uids.map(() => "kel"),
    stage: "space",
    winnerSlot,
    host: uids[0],
    /* Somebody who is not the author has to say so out loud, or the match is
       pending rather than counted. The last seat is the least likely to be
       the host, so it is the one that confirms. */
    confirm: { [uids[uids.length - 1]]: { agree: true, winnerSlot } },
  }, extra || {});
}

/* Anything built inside the vm carries the SANDBOX's Object.prototype, and
   deepEqual compares prototypes, so a record with the right contents fails as
   "same structure but not reference-equal". Spreading rebuilds it here. */
const here = (o) => ({ ...o });

const ratingOf = (v, uid) => v.rows.find((r) => r.uid === uid).rating;
const rowOf = (v, uid) => v.rows.find((r) => r.uid === uid);

/* ---------------------------------------------------------------- */

test("two players fold to exactly the numbers the old formula gave", async () => {
  /* The whole point of the pairwise generalization is that n = 2 is not a
     special case of it, it IS it: n - 1 is 1, there is one pair, and the
     arithmetic is the same arithmetic. If that were only true to within a
     rounding error, then shipping this would silently rewrite every rating
     anybody had earned, which is the one thing a ladder may never do.

     So the expectation here is not "close": it is the exact output of the
     code this replaced, reimplemented below from the old source and also
     written out as literals so that a future edit to BOTH implementations
     still cannot quietly agree with itself. */
  const L = kit();

  const START = L.START, K_NEW = L.K_NEW, K = L.K, PROVISIONAL = L.PROVISIONAL;
  const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
  function oldFold(log) {
    const P = {};
    const seat = (u) => P[u] || (P[u] = { uid: u, rating: START, w: 0, l: 0, d: 0, played: 0 });
    for (const m of log) {
      m.uids.forEach((u) => seat(u));
      const a = seat(m.uids[0]), b = seat(m.uids[1]);
      const sa = m.winnerSlot === 0 ? 1 : m.winnerSlot === 1 ? 0 : 0.5;
      const ea = expected(a.rating, b.rating);
      const ka = a.played < PROVISIONAL ? K_NEW : K;
      const kb = b.played < PROVISIONAL ? K_NEW : K;
      a.rating += ka * (sa - ea);
      b.rating += kb * ((1 - sa) - (1 - ea));
      a.played++; b.played++;
      if (sa === 1) { a.w++; b.l++; }
      else if (sa === 0) { a.l++; b.w++; }
      else { a.d++; b.d++; }
    }
    return P;
  }

  const log = [
    match("m1", 1, ["a", "b"], 0),
    match("m2", 2, ["b", "c"], 0),
    match("m3", 3, ["a", "c"], null),    // both last stocks on the same frame
    match("m4", 4, ["c", "a"], 0),
    match("m5", 5, ["b", "a"], 1),
  ];

  const v = L.fold(log);
  const old = oldFold(log);

  for (const uid of ["a", "b", "c"]) {
    const row = rowOf(v, uid);
    assert.equal(row.rating, Math.round(old[uid].rating),
      uid + " must fold to the rating the two-player code gave it");
    assert.equal(row.w, old[uid].w);
    assert.equal(row.l, old[uid].l);
    assert.equal(row.d, old[uid].d);
    assert.equal(row.played, old[uid].played);
  }

  // The same numbers again, as literals, from the formula as it was written.
  assert.equal(ratingOf(v, "a"), 1016);
  assert.equal(ratingOf(v, "b"), 981);
  assert.equal(ratingOf(v, "c"), 1003);
  assert.deepEqual(here(L.between(v, "a", "b")), { w: 2, l: 0, d: 0 });
  assert.deepEqual(here(L.between(v, "a", "c")), { w: 0, l: 1, d: 1 });
});

test("a four-way pays the winner and charges the other three", async () => {
  /* The decision the owner made, in one assertion: points come out of the
     losers and go to whoever was left standing. Before this, a free-for-all
     moved nothing at all and four people could play all evening without the
     board noticing. */
  const L = kit();
  const v = L.fold([match("m1", 1, ["a", "b", "c", "d"], 2)]);

  assert.equal(v.counted, 1);
  assert.equal(v.unrated, 0, "a four-way is rated now");
  assert.equal(v.matches[0].rated, true);

  assert.ok(ratingOf(v, "c") > L.START,
    "the survivor should have gained, got " + ratingOf(v, "c"));
  for (const uid of ["a", "b", "d"]) {
    assert.ok(ratingOf(v, uid) < L.START,
      uid + " went out and should have paid for it, got " + ratingOf(v, uid));
  }

  // The winner takes one win; everybody else who sat down takes one loss.
  assert.deepEqual(
    ["a", "b", "c", "d"].map((u) => { const r = rowOf(v, u); return [r.w, r.l, r.d, r.played]; }),
    [[0, 1, 0, 1], [0, 1, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1]]);

  /* Head to head says what the rating saw. The winner beat each of the three
     separately; the three who went out drew with each other, because the
     match genuinely did not separate them -- it records who survived, not
     the order the rest were eliminated in. */
  assert.deepEqual(here(L.between(v, "c", "a")), { w: 1, l: 0, d: 0 });
  assert.deepEqual(here(L.between(v, "a", "c")), { w: 0, l: 1, d: 0 });
  assert.deepEqual(here(L.between(v, "a", "b")), { w: 0, l: 0, d: 1 });
  assert.deepEqual(here(L.between(v, "d", "b")), { w: 0, l: 0, d: 1 });
});

test("a win costs the losers exactly what it pays the winner", async () => {
  /* Zero-sum, with equal K. S_ij + S_ji is 1 and E_ij + E_ji is 1, so every
     pair's two deltas cancel and nothing is minted. A ladder that quietly
     prints points inflates until the numbers stop meaning anything.

     Three settled players at exactly the same rating make it checkable
     without fighting the display rounding: the winner takes K * (2 - 1) / 2,
     which is 10, and each loser pays K * (0 - 0.5) / 2, which is 5. */
  const L = kit();

  /* Ten drawn matches leave two equal players on exactly START -- S and E are
     both 0.5, so the delta is exactly zero -- and take them past PROVISIONAL,
     which is the only way to get four settled players who have not moved. */
  const warm = [];
  let at = 0;
  for (const [x, y] of [["a", "b"], ["c", "d"]]) {
    for (let i = 0; i < L.PROVISIONAL; i++) {
      warm.push(match("w" + (++at), at, [x, y], null));
    }
  }
  const flat = L.fold(warm);
  for (const uid of ["a", "b", "c", "d"]) {
    assert.equal(ratingOf(flat, uid), L.START, "warm-up must not move anybody");
    assert.equal(rowOf(flat, uid).provisional, false, uid + " should be settled");
  }

  const three = L.fold(warm.concat([match("ffa", 500, ["a", "b", "c"], 1)]));
  assert.equal(ratingOf(three, "b"), L.START + 10);
  assert.equal(ratingOf(three, "a"), L.START - 5);
  assert.equal(ratingOf(three, "c"), L.START - 5);
  const sum3 = ["a", "b", "c"].reduce((t, u) => t + ratingOf(three, u) - L.START, 0);
  assert.equal(sum3, 0, "three settled players must be exactly zero-sum");

  /* Four of them is zero-sum too -- +10 against three lots of -10/3 -- but
     -10/3 does not land on an integer, and the board only ever shows whole
     numbers, so the visible total is allowed to be off by the rounding of
     four rows and no more. */
  const four = L.fold(warm.concat([match("ffa", 500, ["a", "b", "c", "d"], 0)]));
  const sum4 = ["a", "b", "c", "d"].reduce((t, u) => t + ratingOf(four, u) - L.START, 0);
  assert.ok(Math.abs(sum4) <= 2,
    "a four-way must not mint or burn rating, moved " + sum4);
  assert.equal(ratingOf(four, "a"), L.START + 10, "the winner takes about one win's worth");
  for (const uid of ["b", "c", "d"]) {
    assert.equal(ratingOf(four, uid), L.START - 3);
  }
});

test("a four-way win is worth about one win, not three", async () => {
  /* The divide by n - 1, defended. Without it the three pairwise payouts in a
     four-way are simply added up and beating three people at once moves a
     rating three times as far as beating one does -- at which point the only
     sensible thing to play is a free-for-all and the 1v1 ladder is scenery. */
  const L = kit();
  const warm = [];
  let at = 0;
  for (const [x, y] of [["a", "b"], ["c", "d"]]) {
    for (let i = 0; i < L.PROVISIONAL; i++) {
      warm.push(match("w" + (++at), at, [x, y], null));
    }
  }
  const solo = L.fold(warm.concat([match("duel", 500, ["a", "b"], 0)]));
  const ffa = L.fold(warm.concat([match("ffa", 500, ["a", "b", "c", "d"], 0)]));

  const oneWin = ratingOf(solo, "a") - L.START;
  const bigWin = ratingOf(ffa, "a") - L.START;
  assert.equal(oneWin, 10, "beating one equal settled player is half of K");
  assert.equal(bigWin, oneWin,
    "beating three at once should pay about the same, got " + bigWin);
});

test("where people sit in the document does not change the ladder", async () => {
  /* Elo is order dependent, so the obvious way to write this -- walk the
     seats, update each rating as you go -- makes the result depend on the
     order the uids happen to appear in the match document. Two clients, one
     log, two different ladders: exactly the failure the id tiebreak in
     inOrder() exists to prevent, one level down.

     Every rating is therefore read before any is written, and the proof is
     that shuffling the seats of one match changes nothing but the seating. */
  const L = kit();

  // Unequal ratings first, or the pairwise terms are all 0.5 and any bug of
  // this kind would cancel itself out before the assertion could see it.
  const warm = [
    match("w1", 1, ["a", "b"], 0),
    match("w2", 2, ["a", "c"], 0),
    match("w3", 3, ["d", "b"], 0),
    match("w4", 4, ["c", "d"], 0),
    match("w5", 5, ["b", "c"], 1),
  ];

  const seats = ["a", "b", "c", "d"];
  const winner = "c";
  const straight = L.fold(warm.concat([
    match("ffa", 9, seats, seats.indexOf(winner)),
  ]));

  for (const order of [["d", "c", "b", "a"], ["b", "d", "a", "c"], ["c", "a", "d", "b"]]) {
    const shuffled = L.fold(warm.concat([
      match("ffa", 9, order, order.indexOf(winner)),
    ]));
    for (const uid of seats) {
      assert.equal(ratingOf(shuffled, uid), ratingOf(straight, uid),
        uid + " should not care where it sat, seats " + order.join(""));
      assert.deepEqual(here(rowOf(shuffled, uid)), here(rowOf(straight, uid)));
    }
  }
});

test("a three-way nobody won is a draw all round and moves nothing", async () => {
  /* Both last stocks can go on the same frame, and with three people on the
     stage so can all three. Nobody scored against anybody, so from equal
     ratings every pairwise term is 0.5 against an expectation of 0.5 and
     every delta is exactly zero -- and each pair records a draw, because a
     match they all played is not the same thing as a match that never
     happened. */
  const L = kit();
  const v = L.fold([match("m1", 1, ["a", "b", "c"], null)]);

  assert.equal(v.counted, 1);
  assert.equal(v.unrated, 0);
  assert.equal(v.matches[0].rated, true, "it was rated -- the rating just did not move");

  for (const uid of ["a", "b", "c"]) {
    const r = rowOf(v, uid);
    assert.equal(r.rating, L.START, uid + " should be exactly where it started");
    assert.deepEqual([r.w, r.l, r.d, r.played], [0, 0, 1, 1],
      uid + " should have one draw and one match played");
  }
  assert.deepEqual(here(L.between(v, "a", "b")), { w: 0, l: 0, d: 1 });
  assert.deepEqual(here(L.between(v, "b", "c")), { w: 0, l: 0, d: 1 });
  assert.deepEqual(here(L.between(v, "c", "a")), { w: 0, l: 0, d: 1 });
});

test("the host can play a match that counts without rating anybody", async () => {
  /* `rated: false` is the unrated switch, for the evening somebody wants to
     try a character out without paying for it. The match is still written,
     still confirmed, still shown on the board -- it simply moves nothing,
     which is the treatment a free-for-all used to get. */
  const L = kit();
  const v = L.fold([
    match("m1", 1, ["a", "b"], 0, { rated: false }),
    match("m2", 2, ["a", "b", "c", "d"], 0, { rated: false }),
  ]);

  assert.equal(v.counted, 2, "an unrated match still happened");
  assert.equal(v.unrated, 2);
  assert.equal(v.matches.every((m) => m.rated === false), true);
  assert.equal(v.rows.every((r) => r.rating === L.START), true,
    "nobody's rating may move");
  assert.equal(v.rows.every((r) => r.played === 0 && r.w === 0 && r.l === 0 && r.d === 0),
    true, "and nobody's record either");
  assert.deepEqual(here(L.between(v, "a", "b")), { w: 0, l: 0, d: 0 });

  /* A record written before the switch existed has no `rated` field at all,
     and every one of those was rated. Absent must therefore mean true, or the
     first refold after this ships wipes the whole season. */
  const legacy = L.fold([match("m1", 1, ["a", "b"], 0)]);
  assert.equal(legacy.unrated, 0);
  assert.equal(legacy.matches[0].rated, true);
  assert.ok(ratingOf(legacy, "a") > L.START,
    "a match with no rated field is a rated match");

  // And `rated: true` is not a magic word either way.
  const explicit = L.fold([match("m1", 1, ["a", "b"], 0, { rated: true })]);
  assert.equal(explicit.unrated, 0);
  assert.equal(ratingOf(explicit, "a"), ratingOf(legacy, "a"));
});

test("somebody sitting on the stage alone is still not a rating", async () => {
  /* One seat has no opponent and n - 1 would be zero. It counts as a match
     that happened and goes no further. */
  const L = kit();
  // The lone seat is also the host, so somebody else has to corroborate it.
  const v = L.fold([match("m1", 1, ["a"], 0,
    { confirm: { ref: { agree: true, winnerSlot: 0 } } })]);
  assert.equal(v.counted, 1);
  assert.equal(v.unrated, 1);
  assert.equal(ratingOf(v, "a"), L.START);
  assert.equal(rowOf(v, "a").played, 0);
});
