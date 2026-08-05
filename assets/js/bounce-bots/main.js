// Page wiring: lobby setup, host/client roles, input, and rendering.
//
// The one idea that keeps this manageable: every player action goes through
// `send()`. On the host that calls the game directly; on a client it posts to
// the host. Nothing else in the UI needs to know which role it is running.

import { generateBoard, makeLobbyCode } from "./board.js?v=20260804b";
import { HostGame, PHASES, DEFAULT_SETTINGS, HEARTBEAT_MS } from "./game.js?v=20260804b";
import { createHost, createClient } from "./net.js?v=20260804b";
import { BoardView, ROBOT_COLORS, colorFor } from "./ui.js?v=20260804b";
import { botLevel } from "./bot.js?v=20260804b";
import { COLORS, ROBOT_COUNT } from "./constants.js?v=20260804b";

const $ = (id) => document.getElementById(id);

const HOST_ID = "host";

const state = {
  role: null, // "host" | "client"
  me: null,
  name: "",
  net: null,
  game: null, // host only
  snapshot: null,
  board: null,
  boardKey: "",
  view: null,
  selected: 0,
  // Tracked so the clock pulse is only re-aligned when the deadline actually
  // changes, rather than on every snapshot.
  bidDeadline: 0,
  round: -1,
  // Last render's bids, so a landing bid can be animated exactly once.
  seenBids: new Map(),
  heartbeat: null
};

// Buttons cover the range real solutions fall in; anything longer goes in the
// text field. Two is the floor because the generator never ships a shorter round.
const BID_BUTTONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  state.view = new BoardView($("bb-canvas"), { onRobotPick: selectRobot });
  window.addEventListener("resize", () => state.view.resize());

  const savedName = localStorage.getItem("bb-name") || "";
  $("bb-name").value = savedName;

  const params = new URLSearchParams(window.location.search);
  const invited = params.get("lobby");
  if (invited) {
    $("bb-join-code").value = invited.toUpperCase();
    $("bb-mode-join").checked = true;
    syncModePanels();
  }

  $("bb-mode-host").addEventListener("change", syncModePanels);
  $("bb-mode-join").addEventListener("change", syncModePanels);
  $("bb-bot-level").addEventListener("input", syncBotLevelLabel);
  syncBotLevelLabel();
  $("bb-create").addEventListener("click", startHosting);
  $("bb-join").addEventListener("click", startJoining);

  $("bb-bid-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitBid();
  });

  $("bb-reset").addEventListener("click", resetBoardForMe);
  $("bb-pass").addEventListener("click", () => send({ type: "demo-pass" }));
  $("bb-resign").addEventListener("click", () => send({ type: "vote-resign" }));
  $("bb-start").addEventListener("click", () => send({ type: "start" }));
  $("bb-lock").addEventListener("click", () => send({ type: "lock" }));
  $("bb-skip").addEventListener("click", () => send({ type: "skip" }));
  $("bb-copy").addEventListener("click", copyInvite);

  buildRobotButtons();
  buildNumpad();
  document.addEventListener("keydown", handleKey);
  setInterval(renderClock, 250);

  syncModePanels();
}

function syncBotLevelLabel() {
  const level = botLevel(Number($("bb-bot-level").value));
  $("bb-bot-level-name").textContent = level.name;
  $("bb-bot-level-blurb").textContent = level.blurb;
}

function syncModePanels() {
  const hosting = $("bb-mode-host").checked;
  $("bb-host-fields").hidden = !hosting;
  $("bb-join-fields").hidden = hosting;
}

function buildRobotButtons() {
  const wrap = $("bb-robots");
  wrap.innerHTML = "";
  COLORS.forEach((color, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bb-robot-btn";
    button.dataset.robot = String(index);
    button.style.setProperty("--bb-robot", ROBOT_COLORS[color]);
    button.innerHTML = `<span class="bb-dot"></span>${index + 1}`;
    button.title = `Select the ${color} robot (press ${index + 1})`;
    button.addEventListener("click", () => selectRobot(index));
    wrap.appendChild(button);
  });
}

function buildNumpad() {
  const pad = $("bb-numpad");
  pad.innerHTML = "";
  BID_BUTTONS.forEach((n) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bb-num";
    button.dataset.bid = String(n);
    button.textContent = String(n);
    button.addEventListener("click", () => send({ type: "bid", moves: n }));
    pad.appendChild(button);
  });
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

function readName() {
  const name = ($("bb-name").value || "").trim().slice(0, 18) || "Player";
  localStorage.setItem("bb-name", name);
  return name;
}

function startHosting() {
  state.name = readName();
  state.role = "host";
  state.me = HOST_ID;

  const settings = {
    ...DEFAULT_SETTINGS,
    difficulty: $("bb-difficulty").value,
    useDiagonals: $("bb-diagonals").checked,
    rounds: Number($("bb-rounds").value),
    bidSeconds: Number($("bb-bid-seconds").value),
    botCount: Number($("bb-bot-count").value),
    botLevel: Number($("bb-bot-level").value)
  };

  openLobby(makeLobbyCode(), settings);
}

function openLobby(code, settings) {
  setStatus(`Opening lobby ${code}…`);

  state.game = new HostGame({
    code,
    hostId: HOST_ID,
    hostName: state.name,
    settings,
    onChange: (snapshot) => {
      state.net?.broadcast({ type: "state", snapshot });
      applySnapshot(snapshot);
    }
  });

  state.net = createHost(code, {
    onReady: () => {
      showGame();
      setStatus(`Lobby ${code} is open. Share the link and press Start.`);
      applySnapshot(state.game.snapshot());
    },
    // Another lobby already owns this code, so quietly take a different one.
    onCodeTaken: () => {
      state.net?.destroy();
      openLobby(makeLobbyCode(), settings);
    },
    onJoin: (peerId, conn) => {
      conn.send({ type: "state", snapshot: state.game.snapshot() });
    },
    onLeave: (peerId) => state.game.removePlayer(peerId),
    onMessage: handleHostMessage,
    onError: (err) => setStatus(`Connection error: ${err?.message || err}`)
  });

  setInterval(() => state.game?.tick(), 250);
}

function startJoining() {
  state.name = readName();
  state.role = "client";

  const code = ($("bb-join-code").value || "").trim().toUpperCase();
  if (code.length < 4) {
    setStatus("Enter the four-character lobby code.");
    return;
  }

  setStatus(`Connecting to ${code}…`);
  state.net = createClient(code, {
    onOpen: () => {
      state.net.send({ type: "join", name: state.name });
      showGame();
      setStatus(`Connected to ${code}. Waiting for the leader to start.`);

      // Report in regularly so the host can tell a closed tab from a quiet one.
      clearInterval(state.heartbeat);
      state.heartbeat = setInterval(() => state.net?.send({ type: "ping" }), HEARTBEAT_MS);
    },
    onMessage: (message) => {
      if (message?.type === "state") {
        state.me = message.snapshot.youAre || state.me;
        applySnapshot(message.snapshot);
      }
    },
    onNoSuchLobby: () => setStatus(`No lobby named ${code} is open right now.`),
    onClose: () => setStatus("Lost connection to the lobby leader."),
    onError: (err) => setStatus(`Connection error: ${err?.message || err}`)
  });
}

// The host receives every client action here and applies it under its own
// authority. A client can only ever speak for itself: `peerId` comes from the
// connection, never from the message body.
function handleHostMessage(peerId, message) {
  const game = state.game;
  if (!game || !message) return;

  switch (message.type) {
    case "ping":
      game.heartbeat(peerId);
      break;
    case "join":
      game.addPlayer(peerId, String(message.name || "Player").slice(0, 18));
      // Tell the newcomer which player they are.
      state.net.sendTo(peerId, {
        type: "state",
        snapshot: { ...game.snapshot(), youAre: peerId }
      });
      break;
    case "bid":
      game.bid(peerId, message.moves);
      break;
    case "demo-move":
      game.demoMove(peerId, message.robot, message.dir);
      break;
    case "demo-reset":
      game.resetDemo(peerId);
      break;
    case "demo-pass":
      game.passDemo(peerId);
      break;
    case "vote-resign":
      game.voteResign(peerId);
      break;
    default:
      break;
  }
}

// One entry point for every action, whichever role we are.
function send(action) {
  if (state.role === "host") {
    const game = state.game;
    if (!game) return;
    switch (action.type) {
      case "start":
        game.start(HOST_ID);
        break;
      case "lock":
        game.lockBids(HOST_ID);
        break;
      case "skip":
        game.skipRound(HOST_ID);
        break;
      case "bid":
        game.bid(HOST_ID, action.moves);
        break;
      case "demo-move":
        game.demoMove(HOST_ID, action.robot, action.dir);
        break;
      case "demo-reset":
        game.resetDemo(HOST_ID);
        break;
      case "demo-pass":
        game.passDemo(HOST_ID);
        break;
      case "vote-resign":
        game.voteResign(HOST_ID);
        break;
      default:
        break;
    }
    return;
  }
  state.net?.send(action);
}

// ---------------------------------------------------------------------------
// Snapshot handling
// ---------------------------------------------------------------------------

function applySnapshot(snapshot) {
  state.snapshot = snapshot;

  // Rebuild the board only when the seed or generation settings actually
  // change -- generation is deterministic, so this is safe to skip otherwise.
  const key = `${snapshot.code}|${snapshot.settings.difficulty}|${snapshot.settings.useDiagonals}`;
  if (key !== state.boardKey) {
    state.boardKey = key;
    state.board = generateBoard({
      code: snapshot.code,
      difficulty: snapshot.settings.difficulty,
      useDiagonals: snapshot.settings.useDiagonals
    });
    state.view.setBoard(state.board);
  }

  if (snapshot.round !== state.round) {
    state.round = snapshot.round;
    $("bb-bid-input").value = "";
  }

  render();
}

// The board pulses once per second while the clock runs, so the passing time is
// visible without looking away from the board.
function syncClockPulse(snapshot) {
  const wrap = $("bb-board-wrap");
  const running = snapshot.phase === PHASES.BIDDING && snapshot.bidDeadline > 0;

  wrap.classList.toggle("is-bidding", running);
  if (!running) {
    state.bidDeadline = 0;
    return;
  }
  if (snapshot.bidDeadline === state.bidDeadline) return;
  state.bidDeadline = snapshot.bidDeadline;

  // A CSS animation starts when its class is applied, which is a fraction of a
  // second off from where the countdown happens to be. A negative delay shifts
  // the cycle so each flash lands on the same beat as the number changing.
  const offset = (((Date.now() - snapshot.bidDeadline) % 1000) + 1000) % 1000;
  wrap.style.setProperty("--bb-tick-delay", `-${offset}ms`);
}

function canBidNow() {
  const phase = state.snapshot?.phase;
  return phase === PHASES.THINKING || phase === PHASES.BIDDING;
}

function myBid() {
  return state.snapshot?.bids.find((b) => b.id === state.me)?.moves ?? null;
}

function amDemonstrating() {
  return state.snapshot?.phase === PHASES.DEMO && state.snapshot.currentDemo === state.me;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function selectRobot(index) {
  if (index < 0 || index >= ROBOT_COUNT) return;
  state.selected = index;
  state.view.setSelected(index);
  render();
}

const KEY_DIRS = {
  ArrowUp: 0,
  ArrowRight: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
  w: 0,
  d: 1,
  s: 2,
  a: 3
};

function handleKey(event) {
  // Never hijack keys while someone is typing a bid or a name.
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (!state.snapshot) return;

  // Digits mean different things depending on what you are doing. While the
  // board is locked there is nothing to select, so they go to the bid field;
  // during your proof they pick a robot. Typing never bids on its own -- Enter
  // does -- so a stray keystroke cannot commit you to a number.
  if (event.key >= "0" && event.key <= "9") {
    if (canBidNow()) {
      const input = $("bb-bid-input");
      input.value = event.key;
      input.focus();
      input.select();
      event.preventDefault();
      return;
    }
    const robot = Number(event.key) - 1;
    if (robot >= 0 && robot < ROBOT_COUNT) {
      selectRobot(robot);
      event.preventDefault();
    }
    return;
  }

  const dir = KEY_DIRS[event.key];
  if (dir === undefined) return;
  event.preventDefault();
  moveSelected(dir);
}

// Robots only ever move during your own demonstration. The host enforces this
// too -- this is just so the board does not pretend otherwise.
function moveSelected(dir) {
  if (!amDemonstrating()) return;
  // Authoritative: the host validates and echoes the result back.
  send({ type: "demo-move", robot: state.selected, dir });
}

function resetBoardForMe() {
  if (!amDemonstrating()) return;
  send({ type: "demo-reset" });
}

function submitBid() {
  const raw = Number($("bb-bid-input").value);
  if (!Number.isFinite(raw) || raw < 1) {
    setStatus("Enter how many moves your solution takes.");
    return;
  }
  send({ type: "bid", moves: Math.round(raw) });
}

function copyInvite() {
  const code = state.snapshot?.code;
  if (!code) return;
  const url = `${window.location.origin}${window.location.pathname}?lobby=${code}`;
  navigator.clipboard?.writeText(url).then(
    () => setStatus("Invite link copied."),
    () => setStatus(`Invite link: ${url}`)
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function showGame() {
  $("bb-setup").hidden = true;
  $("bb-game").hidden = false;
  state.view.resize();
}

function setStatus(text) {
  $("bb-status").textContent = text;
}

function render() {
  const snap = state.snapshot;
  if (!snap) return;

  state.view.setState({
    positions: snap.positions,
    target: snap.target,
    // Grey the board while someone else demonstrates: you are watching, not playing.
    dim: snap.phase === PHASES.DEMO && !amDemonstrating(),
    celebrateUntil: snap.celebrateUntil || 0
  });
  renderTrail(snap);

  $("bb-code").textContent = snap.code;
  $("bb-round").textContent = snap.round ? `Round ${snap.round} / ${snap.totalRounds}` : "Lobby";
  $("bb-phase").textContent = phaseLabel(snap);

  renderTarget(snap);
  renderSteps(snap);
  renderPlayers(snap);
  renderControls(snap);
  renderBidBar(snap);
  renderClock();

  // A live clock is worth showing on the board itself, not just in the panel.
  syncClockPulse(snap);

  document.querySelectorAll(".bb-robot-btn").forEach((btn) => {
    btn.classList.toggle("is-active", Number(btn.dataset.robot) === state.selected);
  });
}

// The proof is drawn during the demonstration, and again over the reveal so a
// round that nobody won still shows the line that existed.
function renderTrail(snap) {
  if (snap.phase === PHASES.DEMO) {
    state.view.setTrail({ startPositions: snap.startPositions, moves: snap.demoTrail || [] });
    return;
  }
  if (snap.phase === PHASES.REVEAL) {
    state.view.setTrail({
      startPositions: snap.startPositions,
      moves: snap.lastRound?.solution || []
    });
    return;
  }
  state.view.setTrail(null);
}

function renderSteps(snap) {
  const step =
    snap.phase === PHASES.THINKING
      ? "think"
      : snap.phase === PHASES.BIDDING
        ? "bid"
        : snap.phase === PHASES.DEMO
          ? "prove"
          : null;

  const order = ["think", "bid", "prove"];
  const at = order.indexOf(step);

  $("bb-steps").querySelectorAll("li").forEach((li) => {
    const index = order.indexOf(li.dataset.step);
    li.classList.toggle("is-current", li.dataset.step === step);
    li.classList.toggle("is-done", at >= 0 && index < at);
  });
}

function renderBidBar(snap) {
  const bidding = canBidNow();
  const proving = snap.phase === PHASES.DEMO;

  $("bb-bidbar").hidden = !bidding;
  $("bb-proofbar").hidden = !proving;
  $("bb-robot-panel").hidden = !amDemonstrating();

  if (bidding) {
    const mine = myBid();
    const best = snap.bids.length ? Math.min(...snap.bids.map((b) => b.moves)) : null;

    // Only numbers that would actually improve your position stay live.
    $("bb-numpad").querySelectorAll(".bb-num").forEach((btn) => {
      const value = Number(btn.dataset.bid);
      btn.disabled = mine !== null && value >= mine;
      btn.classList.toggle("is-mine", mine === value);
    });

    $("bb-bidbar-title").textContent =
      mine === null ? "How many moves do you need?" : `You bid ${mine} — can you go lower?`;

    const parts = [];
    if (best !== null) {
      const leaders = snap.bids
        .filter((b) => b.moves === best)
        .map((b) => snap.players.find((p) => p.id === b.id)?.name || "Someone");
      parts.push(
        `Lowest bid <span class="bb-lead">${best}</span> — ${escapeHtml(leaders.join(", "))}`
      );
    } else {
      parts.push("No bids yet. The first one starts the clock for everyone.");
    }
    if (mine !== null && best !== null && mine > best) {
      parts.push("You are not the lowest, so you will not have to prove it.");
    }
    $("bb-bidbar-state").innerHTML = parts.join(" · ");
  }

  if (proving) {
    const who = snap.players.find((p) => p.id === snap.currentDemo);
    $("bb-proof-title").textContent = amDemonstrating()
      ? `Your turn — show it in ${snap.currentBid}`
      : `${who?.name || "Someone"} is proving ${snap.currentBid}`;
    $("bb-proof-hint").textContent = amDemonstrating()
      ? "Each move is numbered on the board as you make it."
      : "Numbered arrows show every move, so you can follow along or check the count.";
  }
}

function phaseLabel(snap) {
  switch (snap.phase) {
    case PHASES.LOBBY:
      return "Waiting in the lobby";
    case PHASES.THINKING:
      return "Find a solution — the first bid starts the clock";
    case PHASES.BIDDING:
      return "Bidding open";
    case PHASES.DEMO: {
      const who = snap.players.find((p) => p.id === snap.currentDemo);
      return amDemonstrating()
        ? `Your turn — solve it in ${snap.currentBid}`
        : `${who?.name || "Someone"} is demonstrating (${snap.currentBid})`;
    }
    case PHASES.REVEAL: {
      const last = snap.lastRound;
      if (last?.winnerId) return `${last.winnerName} solved it in ${last.used}`;
      return "Nobody solved it";
    }
    case PHASES.OVER:
      return "Game over";
    default:
      return "";
  }
}

function renderTarget(snap) {
  const box = $("bb-target");
  if (!snap.target) {
    box.textContent = "—";
    box.style.color = "";
    return;
  }
  // The shape is no longer drawn on the board, so naming it would only confuse.
  const label =
    snap.target.color === "wild"
      ? "Get any robot to the marker"
      : `Get the ${snap.target.color} robot to the marker`;
  box.textContent = label;
  box.style.color = colorFor(snap.target.color);
}

function renderPlayers(snap) {
  const bids = new Map(snap.bids.map((b) => [b.id, b.moves]));
  const best = snap.bids.length ? Math.min(...snap.bids.map((b) => b.moves)) : null;

  // A bid is only "new" on the render where it actually changed, so the pulse
  // fires once rather than on every snapshot that happens to arrive.
  const landed = new Set();
  bids.forEach((moves, id) => {
    if (state.seenBids.get(id) !== moves) landed.add(id);
  });
  state.seenBids = new Map(bids);

  const rows = [...snap.players]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((player) => {
      const marks = [];
      if (player.id === snap.hostId) marks.push("leader");
      if (player.isBot) marks.push("bot");
      if (!player.connected && !player.isBot) marks.push("offline");
      // Only while they actually are: currentDemo still points at them during
      // the reveal that follows.
      if (snap.phase === PHASES.DEMO && player.id === snap.currentDemo) {
        marks.push("demonstrating");
      }

      const bid = bids.get(player.id);
      // Bids are public: underbidding is the whole game, so show who is where.
      const showBids = snap.phase === PHASES.THINKING || snap.phase === PHASES.BIDDING;
      const chipClass = [
        "bb-bid-chip",
        bid === best && bid !== undefined ? "is-lowest" : "",
        landed.has(player.id) ? "is-new" : "",
        bid === undefined ? "is-none" : ""
      ]
        .filter(Boolean)
        .join(" ");
      const bidText = bid
        ? `<span class="${chipClass}">${bid}</span>`
        : showBids
          ? `<span class="${chipClass}">–</span>`
          : "";
      const you = player.id === state.me ? " is-you" : "";
      const fresh = landed.has(player.id) ? " is-new-bid" : "";

      return `<li class="bb-player${you}${fresh}${player.connected ? "" : " is-offline"}">
        <span class="bb-player-name">${escapeHtml(player.name)}</span>
        ${bidText}
        <span class="bb-score">${player.score}</span>
        ${marks.length ? `<span class="bb-tags">${marks.join(" · ")}</span>` : ""}
      </li>`;
    })
    .join("");

  $("bb-players").innerHTML = rows;
}

function renderControls(snap) {
  const isHost = state.me === snap.hostId;
  const inPlay = snap.phase !== PHASES.LOBBY && snap.phase !== PHASES.OVER;

  $("bb-host-controls").hidden = !isHost;
  $("bb-start").hidden = inPlay;
  $("bb-start").textContent = snap.phase === PHASES.OVER ? "Play again" : "Start game";
  $("bb-lock").hidden = snap.phase !== PHASES.BIDDING;
  $("bb-skip").hidden = !inPlay;

  const canBid = canBidNow();
  $("bb-pass").hidden = !amDemonstrating();
  $("bb-reset").hidden = !amDemonstrating();

  // You only get a vote if you are one of the players the decision rests on:
  // everyone before a bid, and only the players still searching after one.
  const vote = $("bb-resign");
  const voters = snap.resignVoters || [];
  vote.hidden = !canBid || !voters.includes(state.me);

  if (!vote.hidden) {
    const votes = (snap.resignVotes || []).filter((id) => voters.includes(id));
    const mine = votes.includes(state.me);
    const tally = `${votes.length}/${voters.length}`;
    const label =
      snap.phase === PHASES.BIDDING ? "Stop the clock" : "Resign the round";
    vote.textContent = mine ? `Resigned (${tally})` : `${label} (${tally})`;
    vote.classList.toggle("is-active", mine);
    vote.title =
      snap.phase === PHASES.BIDDING
        ? "Everyone who has not bid must agree to end the clock early."
        : "Everyone must agree to throw the round away. Nobody scores.";
  }

  // Spectators need the running count too, or a slow proof reads as nothing
  // happening at all.
  const counter = $("bb-moves");
  counter.textContent =
    snap.phase === PHASES.DEMO
      ? `Move ${snap.demoMoveCount} of ${snap.currentBid}`
      : "";

  const note = $("bb-note");
  if (snap.phase === PHASES.REVEAL && snap.lastRound) {
    const optimal = snap.lastRound.optimal;
    const parts = [];

    // Everyone who claimed a line and could not show it.
    const charged = (snap.lastRound.failures || []).filter((f) => f.penalty);
    if (charged.length) {
      parts.push(charged.map((f) => `${f.name} bid ${f.bid}, −1`).join(" · "));
    }
    parts.push(
      snap.lastRound.winnerId
        ? `Best possible was ${optimal ?? "?"}.`
        : `The optimal solution was ${optimal ?? "?"} moves.`
    );
    note.textContent = parts.join("  ");
  } else if (snap.notice) {
    note.textContent = snap.notice;
  } else {
    note.textContent = "";
  }
}

function renderClock() {
  const snap = state.snapshot;
  if (!snap) return;

  let deadline = 0;
  if (snap.phase === PHASES.BIDDING) deadline = snap.bidDeadline;
  else if (snap.phase === PHASES.DEMO) deadline = snap.demoDeadline;
  else if (snap.phase === PHASES.REVEAL) deadline = snap.revealDeadline;

  // The clock appears wherever the current action is, not only in the panel.
  const faces = [$("bb-timer"), $("bb-bidbar-clock"), $("bb-proof-clock")].filter(Boolean);

  if (!deadline) {
    // Before the first bid there is no clock, and saying so is the point.
    const idle = snap.phase === PHASES.THINKING ? "no clock yet" : "";
    faces.forEach((face) => {
      face.textContent = face.id === "bb-bidbar-clock" ? idle : "";
      face.classList.remove("is-urgent");
    });
    return;
  }

  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  faces.forEach((face) => {
    face.textContent = `${left}s`;
    face.classList.toggle("is-urgent", left <= 10);
  });
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

boot();
