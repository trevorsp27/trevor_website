// Page wiring: lobby setup, host/client roles, input, and rendering.
//
// The one idea that keeps this manageable: every player action goes through
// `send()`. On the host that calls the game directly; on a client it posts to
// the host. Nothing else in the UI needs to know which role it is running.

import { generateBoard, makeLobbyCode } from "./board.js?v=20260803b";
import { HostGame, PHASES, DEFAULT_SETTINGS, HEARTBEAT_MS } from "./game.js?v=20260803b";
import { createHost, createClient } from "./net.js?v=20260803b";
import { BoardView, ROBOT_COLORS, colorFor } from "./ui.js?v=20260803b";
import { botLevel } from "./bot.js?v=20260803b";
import { COLORS, ROBOT_COUNT } from "./constants.js?v=20260803b";

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
  heartbeat: null
};

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

  if (event.key >= "1" && event.key <= String(ROBOT_COUNT)) {
    selectRobot(Number(event.key) - 1);
    event.preventDefault();
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

  $("bb-code").textContent = snap.code;
  $("bb-round").textContent = snap.round ? `Round ${snap.round} / ${snap.totalRounds}` : "Lobby";
  $("bb-phase").textContent = phaseLabel(snap);

  renderTarget(snap);
  renderPlayers(snap);
  renderControls(snap);
  renderClock();

  // A live clock is worth showing on the board itself, not just in the panel.
  syncClockPulse(snap);

  document.querySelectorAll(".bb-robot-btn").forEach((btn) => {
    btn.classList.toggle("is-active", Number(btn.dataset.robot) === state.selected);
  });
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
      // Bids are public: underbidding is the whole game.
      const bidText = bid ? `<span class="bb-bid-chip">${bid}</span>` : "";
      const you = player.id === state.me ? " is-you" : "";

      return `<li class="bb-player${you}${player.connected ? "" : " is-offline"}">
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

  const canBid = snap.phase === PHASES.THINKING || snap.phase === PHASES.BIDDING;
  $("bb-bid-form").hidden = !canBid;
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

  // The move counter means different things in each phase, so label it.
  const counter = $("bb-moves");
  if (amDemonstrating()) {
    counter.textContent = `${snap.demoMoveCount} / ${snap.currentBid} moves used`;
  } else if (snap.phase === PHASES.DEMO) {
    // Spectators need the running count too, or a slow demonstration reads as
    // nothing happening.
    const who = snap.players.find((p) => p.id === snap.currentDemo);
    counter.textContent = `${who?.name || "They"}: ${snap.demoMoveCount} / ${snap.currentBid} moves`;
  } else if (canBid) {
    counter.textContent = "Work it out in your head — the board is locked.";
  } else {
    counter.textContent = "";
  }

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
  const el = $("bb-timer");
  if (!snap || !el) return;

  let deadline = 0;
  if (snap.phase === PHASES.BIDDING) deadline = snap.bidDeadline;
  else if (snap.phase === PHASES.DEMO) deadline = snap.demoDeadline;
  else if (snap.phase === PHASES.REVEAL) deadline = snap.revealDeadline;

  if (!deadline) {
    el.textContent = "";
    el.classList.remove("is-urgent");
    return;
  }

  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.textContent = `${left}s`;
  el.classList.toggle("is-urgent", left <= 10);
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

boot();
