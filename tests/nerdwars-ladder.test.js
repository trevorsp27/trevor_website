/* The ladder's rules, with no network and no game attached.
 *
 * Everything in ladder.js is a pure function of a match log plus a four-call
 * storage port, which is the whole reason it is a separate file: the rules
 * that decide what counts, who beat whom, and what a rating is can be argued
 * with directly, in milliseconds, without PeerJS or Firebase or a canvas.
 *
 * The end-to-end version -- two real machines playing a real match into a
 * real record -- lives in nerdwars-online-4p.test.js. This is the half that
 * says what the record MEANS.
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
function kit() {
  const sb = { console, Math, JSON, Object, Array, Promise, String, Number };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(LADDER, sb, { filename: "ladder.js" });
  return sb.window.NerdWarsLadderKit;
}

/** A match as the host writes it, with whatever confirms came back. */
function match(mid, at, uids, winnerSlot, confirm) {
  return {
    mid, at, uids,
    names: uids.map((u) => u.toUpperCase()),
    chars: uids.map(() => "kel"),
    stage: "space",
    winnerSlot,
    host: uids[0],
    confirm: confirm || {},
  };
}
const agrees = (uid, winnerSlot) => ({ [uid]: { agree: true, winnerSlot } });

/* Anything built inside the vm carries the SANDBOX's Object.prototype, and
   assert/strict's deepEqual compares prototypes -- so a record with exactly
   the right contents fails as "same structure but not reference-equal".
   Spreading it rebuilds it in this realm. */
const here = (o) => ({ ...o });

test("a match counts when nobody contradicts it and somebody confirms", async () => {
  const L = kit();
  const v = L.fold([
    match("m1", 1, ["a", "b"], 0, agrees("b", 0)),
  ]);
  assert.equal(v.counted, 1);
  assert.equal(v.disputed, 0);
  assert.equal(v.pending, 0);
});

test("silence is not agreement, and it is not a loss either", async () => {
  /* The rule this replaces was "count it when everybody agrees", which
     sounds like anti-cheat and is the opposite: nobody has to forge
     anything, the loser just closes the tab and the defeat evaporates. That
     is free, invisible, and indistinguishable from a flat battery.

     So an unconfirmed match is PENDING -- visible, unscored, and obviously
     waiting on somebody -- rather than quietly gone. */
  const L = kit();
  const v = L.fold([match("m1", 1, ["a", "b"], 0, {})]);
  assert.equal(v.pending, 1, "an unconfirmed match should be pending");
  assert.equal(v.counted, 0, "and must not be scored");
  assert.equal(v.rows.find((r) => r.uid === "a").w, 0,
    "the winner should not be credited until somebody agrees");
  assert.equal(v.rows.find((r) => r.uid === "b").l, 0,
    "and the loser should not be debited");
});

test("the host agreeing with the host proves nothing", async () => {
  /* A confirm from the person who wrote the match is not corroboration.
     Without this, a fabricated match would count itself. */
  const L = kit();
  const v = L.fold([
    match("m1", 1, ["a", "b"], 0, { a: { agree: true, winnerSlot: 0 } }),
  ]);
  assert.equal(v.counted, 0, "self-confirmation should not count");
  assert.equal(v.pending, 1);
});

test("a contradiction is disputed, and stays visible", async () => {
  /* Two honest clients can genuinely disagree: the desync check compares a
     32-bit hash every thirty confirmed frames, so a divergence inside the
     last thirty frames of a match is never caught. Dropping those silently
     would throw away the only evidence that the engine has a bug. */
  const L = kit();
  const v = L.fold([
    match("m1", 1, ["a", "b"], 0, { b: { agree: false } }),
    match("m2", 2, ["a", "b"], 0, { b: { agree: true, winnerSlot: 1 } }),
  ]);
  assert.equal(v.disputed, 2,
    "both an explicit refusal and a different winner are disputes");
  assert.equal(v.counted, 0);
  assert.equal(v.matches.filter((m) => m.verdict === "disputed").length, 2,
    "and disputed matches must still appear in the log, not vanish");
});

test("head-to-head is what nine friends actually argue about", async () => {
  const L = kit();
  const v = L.fold([
    match("m1", 1, ["a", "b"], 0, agrees("b", 0)),
    match("m2", 2, ["a", "b"], 0, agrees("b", 0)),
    match("m3", 3, ["a", "b"], 1, agrees("b", 1)),
    match("m4", 4, ["a", "c"], 0, agrees("c", 0)),
  ]);
  assert.deepEqual(here(L.between(v, "a", "b")), { w: 2, l: 1, d: 0 });
  assert.deepEqual(here(L.between(v, "b", "a")), { w: 1, l: 2, d: 0 },
    "and it reads the same from the other side");
  assert.deepEqual(here(L.between(v, "a", "c")), { w: 1, l: 0, d: 0 });
  assert.deepEqual(here(L.between(v, "b", "c")), { w: 0, l: 0, d: 0 },
    "two people who have never played should show nothing, not a guess");
});

test("a draw is a result, not a disagreement", async () => {
  /* Both last stocks can go on the same frame -- the engine has a DRAW
     branch on the results screen. If the schema treats a null winner as a
     malformed report, real draws start showing up as disputes. */
  const L = kit();
  const v = L.fold([match("m1", 1, ["a", "b"], null, agrees("b", null))]);
  assert.equal(v.counted, 1);
  assert.equal(v.disputed, 0);
  const a = v.rows.find((r) => r.uid === "a");
  assert.equal(a.d, 1, "it should be recorded as a draw");
  assert.equal(a.w + a.l, 0);
  assert.equal(v.rows[0].rating, v.rows[1].rating,
    "two equal players drawing should stay equal");
});

test("beating a stronger player is worth more than beating a weaker one", async () => {
  const L = kit();
  // `a` grinds up a rating against `c`, then `b` (fresh) beats each of them.
  const climb = [];
  for (let i = 0; i < 12; i++) {
    climb.push(match("w" + i, i + 1, ["a", "c"], 0, agrees("c", 0)));
  }
  const strong = L.fold(climb).rows.find((r) => r.uid === "a");
  assert.ok(strong.rating > 1000, "a should have climbed, got " + strong.rating);

  const beatStrong = L.fold(climb.concat([
    match("x", 99, ["b", "a"], 0, agrees("a", 0)),
  ])).rows.find((r) => r.uid === "b");
  const beatWeak = L.fold(climb.concat([
    match("x", 99, ["b", "c"], 0, agrees("c", 0)),
  ])).rows.find((r) => r.uid === "b");

  assert.ok(beatStrong.rating > beatWeak.rating,
    "beating the stronger player should pay more: " + beatStrong.rating +
    " vs " + beatWeak.rating);
});

test("a rating nobody has earned yet says so", async () => {
  /* Three wins and a big number is not a position on a ladder, it is three
     wins. Provisional players sort below settled ones whatever their rating,
     or the whole table reads as noise for the first fortnight. */
  const L = kit();
  const log = [];
  for (let i = 0; i < 3; i++) {
    log.push(match("n" + i, i + 1, ["new", "x"], 0, agrees("x", 0)));
  }
  for (let i = 0; i < 12; i++) {
    log.push(match("v" + i, 20 + i, ["vet", "y"], i % 2, agrees("y", i % 2)));
  }
  const v = L.fold(log);
  const fresh = v.rows.find((r) => r.uid === "new");
  const vet = v.rows.find((r) => r.uid === "vet");
  assert.equal(fresh.provisional, true, "three matches is provisional");
  assert.equal(vet.provisional, false, "twelve is not");
  assert.ok(v.rows.indexOf(vet) < v.rows.indexOf(fresh),
    "a settled player outranks a provisional one whatever the number says");
});

test("every client folds the same log into the same ladder", async () => {
  /* The ladder is a pure function of the log, so two people looking at it
     must see the same thing. Elo is ORDER DEPENDENT, so that requires a
     TOTAL order -- and `at` alone is not one: two matches written in the
     same millisecond would fold in whatever order the query happened to
     return them, and two clients would disagree. */
  const L = kit();
  const log = [
    match("bbb", 5, ["a", "b"], 0, agrees("b", 0)),
    match("aaa", 5, ["a", "b"], 1, agrees("b", 1)),   // same timestamp
    match("ccc", 7, ["a", "c"], 0, agrees("c", 0)),
  ];
  const forward = L.fold(log).rows.map((r) => r.uid + ":" + r.rating).join(",");
  const backward = L.fold(log.slice().reverse())
    .rows.map((r) => r.uid + ":" + r.rating).join(",");
  const shuffled = L.fold([log[2], log[0], log[1]])
    .rows.map((r) => r.uid + ":" + r.rating).join(",");
  assert.equal(forward, backward,
    "the same log in a different order must fold identically");
  assert.equal(forward, shuffled);
});

test("a four-way is logged but not rated", async () => {
  /* Elo has no agreed meaning for a free-for-all, and this game does not
     record the order people went out in -- at the end every loser simply has
     no stocks. So a four-way carries nothing to rate with beyond who
     survived. It is kept, shown, and left unrated rather than guessed at. */
  const L = kit();
  const v = L.fold([
    match("m1", 1, ["a", "b", "c", "d"], 2,
          { b: { agree: true, winnerSlot: 2 } }),
  ]);
  assert.equal(v.counted, 1, "it still counts as a match that happened");
  assert.equal(v.unrated, 1, "but it does not move anybody's rating");
  assert.equal(v.rows.every((r) => r.rating === L.START), true,
    "everybody should still be on the starting rating");
  assert.equal(v.matches[0].rated, false);
});

test("the store is create-only, so a result cannot be rewritten", async () => {
  /* The one thing a loser could otherwise do: wait to see the result, then
     overwrite their own confirm to erase it. Both writes are create-only,
     which is also what the Firestore rules will enforce. */
  const L = kit();
  const store = L.memoryStore();
  const doc = { at: 1, uids: ["a", "b"], names: ["A", "B"], chars: ["kel", "trev"],
                stage: "space", winnerSlot: 0, stocks: [1, 0], frames: 900,
                build: "x", host: "a" };
  assert.equal(await store.writeMatch("m1", doc), true);
  assert.equal(await store.writeMatch("m1", { ...doc, winnerSlot: 1 }), false,
    "a match must not be rewritable once it exists");

  assert.equal(await store.writeConfirm("m1", "b", { agree: true, winnerSlot: 0 }), true);
  assert.equal(await store.writeConfirm("m1", "b", { agree: false }), false,
    "and a confirm must not be retractable after the fact");

  const [m] = await store.listMatches();
  assert.equal(m.winnerSlot, 0);
  assert.equal(m.confirm.b.agree, true);
});

test("the ladder only reads what it has not already seen", async () => {
  /* The log is append-only, so everything already folded stays folded.
     Re-reading all of it on every view is what breaks first on the free
     tier -- a year of play is thousands of documents, and a few leaderboard
     views a day would spend the daily read quota. */
  const L = kit();
  const store = L.memoryStore();
  let reads = [];
  const counting = Object.assign({}, store, {
    listMatches: (since) => { reads.push(since); return store.listMatches(since); },
  });
  const ladder = L.createLadder(counting);

  await store.writeMatch("m1", { at: 10, uids: ["a", "b"], names: ["A", "B"],
    chars: ["kel", "trev"], stage: "space", winnerSlot: 0, host: "a" });
  await store.writeConfirm("m1", "b", { agree: true, winnerSlot: 0 });
  await ladder.refresh();
  assert.equal(ladder.view().counted, 1);

  await ladder.refresh();
  assert.equal(reads[0], 0, "the first read starts from the beginning");
  assert.ok(reads[1] >= 10,
    "the second should only ask for what is newer than it already has, asked from " +
    reads[1]);
});


/** The match document as the host writes it. */
function hostDoc(uids) {
  return { at: 1, uids, names: uids.map((u) => u.toUpperCase()),
           chars: uids.map(() => "kel"), stage: "space", winnerSlot: 0,
           stocks: [1, 0], frames: 900, build: "x", host: uids[0] };
}

test("two machines reporting the same match write one record between them", async () => {
  /* The bug this replaced: the room's HOST wrote the match and everybody else
     confirmed it, so the record depended on one particular machine getting
     there first. It did not. The winner leaves the results screen first --
     the winner is the one still pressing attack -- and leaving is what used
     to trigger reporting, so when the guest won, its confirm arrived seconds
     before the host had written anything for it to confirm. A confirm on a
     document that does not exist is refused outright, not queued.

     Now whoever is first writes it down and the other one agrees, so it does
     not matter which machine that is. */
  const L = kit();
  const store = L.memoryStore();
  const ladder = L.createLadder(store, { wait: () => Promise.resolve() });
  const report = (me) => ladder.report({
    mid: "m1", me, at: 1, uids: ["a", "b"], names: ["A", "B"],
    chars: ["kel", "trev"], stage: "space", winnerSlot: 1, stocks: [0, 2],
    frames: 900, build: "x",
  });

  // b -- the guest, and the winner -- gets there first.
  assert.equal(await report("b"), true, "the first one to report writes it down");
  assert.equal(await report("a"), true, "and the second one still records something");

  const all = await store.listMatches();
  assert.equal(all.length, 1, "exactly one match document, got " + all.length);
  const m = all[0];
  assert.equal(m.host, "b", "written down by whoever got there first");
  assert.equal(Object.keys(m.confirm).join(","), "a",
    "and corroborated by the other one");
  assert.equal(m.confirm.a.winnerSlot, 1);

  // Which is what makes it count, with the win credited to b.
  const v = L.fold([Object.assign({ mid: "m1" }, m)]);
  assert.equal(v.counted, 1, "the match should count");
  assert.equal(v.rows.find((r) => r.uid === "b").w, 1,
    "and the win should belong to b, who won it");
  assert.equal(v.rows.find((r) => r.uid === "a").l, 1);
});

test("it counts whichever machine happened to write it down", async () => {
  /* The same match, reported in the other order, has to fold to the same
     result -- or the ladder would depend on network luck. */
  const L = kit();
  const order = [];
  for (const first of ["a", "b"]) {
    const store = L.memoryStore();
    const ladder = L.createLadder(store, { wait: () => Promise.resolve() });
    const report = (me) => ladder.report({
      mid: "m1", me, at: 1, uids: ["a", "b"], names: ["A", "B"],
      chars: ["kel", "trev"], stage: "space", winnerSlot: 1, stocks: [0, 2],
      frames: 900, build: "x",
    });
    await report(first);
    await report(first === "a" ? "b" : "a");
    const [m] = await store.listMatches();
    const v = L.fold([Object.assign({ mid: "m1" }, m)]);
    assert.equal(m.host, first, "whoever reported first is the author");
    order.push(v.counted + ":" + v.rows.map((r) => r.uid + r.w + "-" + r.l).sort().join(","));
  }
  assert.equal(order[0], order[1],
    "the ladder must not depend on which machine got there first: " +
    order.join("  vs  "));
});

test("a confirm still waits for a match that has not landed yet", async () => {
  /* Belt and braces. Writing first and confirming second should mean the
     document is always there by the time anybody confirms -- but a store that
     refuses the write for its own reasons would drop this machine straight
     into confirming something that does not exist. */
  const L = kit();
  const store = L.memoryStore();
  // A store that will not let this machine author, so it has to confirm.
  const cannotAuthor = Object.assign({}, store, {
    writeMatch: () => Promise.resolve(false),
  });
  const waits = [];
  const ladder = L.createLadder(cannotAuthor, {
    wait: (ms) => {
      waits.push(ms);
      // The other machine's write lands while this one is waiting.
      if (waits.length === 2) return store.writeMatch("m1", hostDoc(["a", "b"]));
      return Promise.resolve();
    },
  });

  const ok = await ladder.report({ mid: "m1", me: "b", winnerSlot: 0, agree: true });
  assert.equal(ok, true, "the confirm should land once the match exists");
  assert.equal(waits.length, 2,
    "it should have waited twice and then succeeded, waited " + waits.length);
  assert.ok(waits[1] > waits[0],
    "and backed off rather than hammering: " + waits.join(", "));

  const [m] = await store.listMatches();
  assert.equal(m.confirm.b.agree, true, "and the confirm should be on the match");
  assert.equal(m.confirm.b.winnerSlot, 0);
});

test("a confirm gives up rather than retrying forever", async () => {
  /* A match that never appears is the other machine crashed, or offline, or
     never signed in. Retrying into that until the tab closes would spend
     somebody's Firestore quota on a document that is not coming. */
  const L = kit();
  const store = L.memoryStore();
  let waits = 0;
  const ladder = L.createLadder(
    Object.assign({}, store, { writeMatch: () => Promise.resolve(false) }),
    { wait: () => { waits++; return Promise.resolve(); } });

  const ok = await ladder.report({ mid: "gone", me: "b", winnerSlot: 0, agree: true });
  assert.equal(ok, false, "it should report that the confirm did not land");
  assert.ok(waits > 0 && waits < 20,
    "and should have tried a bounded number of times, waited " + waits);
  // Length, not deepEqual: an array built inside the vm carries the
  // sandbox's Array.prototype, and deepEqual compares prototypes.
  assert.equal((await store.listMatches()).length, 0,
    "with nothing invented to hang the confirm on");
});

test("the machine that wrote it down does not wait around for itself", async () => {
  /* Only the confirm can race. Writing the match CREATES the document, so
     there is nothing to wait for -- and retrying a create-only write that was
     refused precisely because it already succeeded would be pure noise. */
  const L = kit();
  const store = L.memoryStore();
  let waits = 0;
  const ladder = L.createLadder(store, {
    wait: () => { waits++; return Promise.resolve(); },
  });

  const ok = await ladder.report(Object.assign({ mid: "m1", me: "a" },
                                               hostDoc(["a", "b"])));
  assert.equal(ok, true);
  assert.equal(waits, 0, "the author should not have waited for anything");

  /* Reporting the same match twice from the same machine finds its own
     document, tries to confirm it, and is refused -- you cannot corroborate
     yourself. It must not sit there retrying that. */
  const again = await ladder.report(Object.assign({ mid: "m1", me: "a" },
                                                  hostDoc(["a", "b"])));
  assert.equal(again, true,
    "a second report from the author is harmless, got " + again);
  const [m] = await store.listMatches();
  assert.equal(Object.keys(m.confirm).join(","), "a",
    "even though it leaves a self-confirm, which verdictOf ignores");
  assert.equal(L.verdictOf(Object.assign({ mid: "m1" }, m)), "pending",
    "so the match is still waiting on somebody else");
});
