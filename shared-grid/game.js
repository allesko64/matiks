/* ===================================================================
   SHARED GRID  —  half-day prototype
   One screen. You vs a bot. No backend.

   Decisions (locked in):
   1. Expressions evaluate LEFT TO RIGHT.
   2. A path cannot revisit a cell.
   3. A round is 2 minutes.
   4. Bot claims one edge every 4 seconds.
   5. When nothing is reachable, the round ends.
   =================================================================== */

/* ---------- Tunables ---------- */
const ROUND_SECONDS = 120;
const BOT_INTERVAL_MS = 4000;   // how often the bot claims an edge
const BOT_SCORE_CHANCE = 0.25;  // chance a claim also bumps the bot's score

/* ---------- The board ----------
   0 1 2      3  /  8
   3 4 5      -  2  -
   6 7 8      4  +  1
   Corners + centre = numbers. Edges = operators (checkerboard).
*/
const CELLS = [
  { id: 0, type: "num", val: 3,   r: 0, c: 0 },
  { id: 1, type: "op",  val: "/", r: 0, c: 1 },
  { id: 2, type: "num", val: 8,   r: 0, c: 2 },
  { id: 3, type: "op",  val: "-", r: 1, c: 0 },
  { id: 4, type: "num", val: 2,   r: 1, c: 1 },
  { id: 5, type: "op",  val: "-", r: 1, c: 2 },
  { id: 6, type: "num", val: 4,   r: 2, c: 0 },
  { id: 7, type: "op",  val: "+", r: 2, c: 1 },
  { id: 8, type: "num", val: 1,   r: 2, c: 2 },
];

const OP_GLYPH = { "/": "÷", "-": "−", "+": "+", "*": "×" };

/* Geometry: cell centre in the 360x360 viewBox */
function cx(cell) { return 60 + cell.c * 120; }
function cy(cell) { return 60 + cell.r * 120; }

/* ---------- Neighbours & edges ---------- */
function areNeighbours(a, b) {
  const dr = Math.abs(a.r - b.r), dc = Math.abs(a.c - b.c);
  return (dr + dc) === 1;
}
function edgeKey(a, b) { return Math.min(a, b) + "-" + Math.max(a, b); }

const EDGES = [];
for (let i = 0; i < CELLS.length; i++) {
  for (let j = i + 1; j < CELLS.length; j++) {
    if (areNeighbours(CELLS[i], CELLS[j])) EDGES.push(edgeKey(i, j));
  }
}
// 12 edges total (6 horizontal, 6 vertical)

function neighbourIds(id) {
  const cell = CELLS[id];
  return CELLS.filter((o) => areNeighbours(cell, o)).map((o) => o.id);
}

/* ===================================================================
   PHASE 3 — THE SOLVER
   Enumerate every valid path once at startup.
   A path: starts on a number, alternates (free, thanks to the
   checkerboard), never revisits a cell, ends on a number.
   =================================================================== */
function evaluatePath(cellIds) {
  let value = CELLS[cellIds[0]].val;
  for (let i = 1; i < cellIds.length; i += 2) {
    const op = CELLS[cellIds[i]].val;
    const n = CELLS[cellIds[i + 1]].val;
    if (op === "+") value += n;
    else if (op === "-") value -= n;
    else if (op === "*") value *= n;
    else if (op === "/") value = value / n;
  }
  return value;
}

function pathEdges(cellIds) {
  const es = [];
  for (let i = 0; i < cellIds.length - 1; i++) es.push(edgeKey(cellIds[i], cellIds[i + 1]));
  return es;
}

const ALL_PATHS = [];
(function enumerate() {
  const numberCells = CELLS.filter((c) => c.type === "num").map((c) => c.id);
  function dfs(pathIds, visited) {
    const last = pathIds[pathIds.length - 1];
    if (CELLS[last].type === "num" && pathIds.length >= 3) {
      const value = evaluatePath(pathIds);
      ALL_PATHS.push({
        cells: pathIds.slice(),
        edges: pathEdges(pathIds),
        value,
        isInt: Number.isInteger(value),
      });
    }
    for (const nb of neighbourIds(last)) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      pathIds.push(nb);
      dfs(pathIds, visited);
      pathIds.pop();
      visited.delete(nb);
    }
  }
  for (const start of numberCells) dfs([start], new Set([start]));
})();

/* ===================================================================
   GAME STATE
   =================================================================== */
const state = {
  locked: {},          // edgeKey -> "mine" | "bot"
  playerPath: [],       // cell ids being traced
  target: null,
  youScore: 0,
  botScore: 0,
  timeLeft: ROUND_SECONDS,
  rerouteCount: 0,
  cursor: 0,            // keyboard focus cell
  running: false,
};

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- Solver queries against current locked set ---------- */
function isLocked(key) { return !!state.locked[key]; }

function pathIsOpen(p) {
  for (const e of p.edges) if (isLocked(e)) return false;
  return true;
}

// paths that currently reach `value` using no locked edge
function solutionPathsFor(value) {
  return ALL_PATHS.filter((p) => p.value === value && pathIsOpen(p));
}

// every integer target still solvable right now
function reachableTargets() {
  const counts = new Map();
  for (const p of ALL_PATHS) {
    if (!p.isInt) continue;
    if (!pathIsOpen(p)) continue;
    counts.set(p.value, (counts.get(p.value) || 0) + 1);
  }
  return counts; // value -> number of open paths
}

// is `value` still reachable if we additionally lock `extraEdge`?
function reachableAfterLocking(value, extraEdge) {
  return ALL_PATHS.some(
    (p) => p.value === value && !p.edges.includes(extraEdge) && pathIsOpen(p)
  );
}

/* ---------- Target generation ---------- */
function pickTarget() {
  const counts = reachableTargets();
  if (counts.size === 0) return null;
  // Prefer values reachable by more than one path (blocking stays interesting,
  // not instantly fatal).
  const multi = [...counts.entries()].filter(([, n]) => n >= 2).map(([v]) => v);
  const pool = multi.length ? multi : [...counts.keys()];
  // avoid immediately repeating the same target when we have options
  let choices = pool;
  if (pool.length > 1 && state.target !== null) {
    const filtered = pool.filter((v) => v !== state.target);
    if (filtered.length) choices = filtered;
  }
  return choices[Math.floor(Math.random() * choices.length)];
}

/* ===================================================================
   RENDERING
   =================================================================== */
const svg = document.getElementById("board");
const edgeLayer = document.getElementById("edgeLayer");
const cellLayer = document.getElementById("cellLayer");
const pathLine = document.getElementById("pathLine");
const SVGNS = "http://www.w3.org/2000/svg";

function buildBoard() {
  // edges first (behind cells)
  for (const key of EDGES) {
    const [a, b] = key.split("-").map(Number);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", cx(CELLS[a]));
    line.setAttribute("y1", cy(CELLS[a]));
    line.setAttribute("x2", cx(CELLS[b]));
    line.setAttribute("y2", cy(CELLS[b]));
    line.setAttribute("class", "edge");
    line.dataset.edge = key;
    edgeLayer.appendChild(line);

    // little lock nub at the edge midpoint (hidden until the edge is spent)
    const mx = (cx(CELLS[a]) + cx(CELLS[b])) / 2;
    const my = (cy(CELLS[a]) + cy(CELLS[b])) / 2;
    const lock = document.createElementNS(SVGNS, "g");
    lock.setAttribute("class", "edge-lock");
    lock.dataset.lock = key;
    const nub = document.createElementNS(SVGNS, "circle");
    nub.setAttribute("cx", mx);
    nub.setAttribute("cy", my);
    nub.setAttribute("r", 8);
    const mark = document.createElementNS(SVGNS, "text");
    mark.setAttribute("x", mx);
    mark.setAttribute("y", my + 0.5);
    lock.appendChild(nub);
    lock.appendChild(mark);
    edgeLayer.appendChild(lock);
  }

  // cells on top
  for (const cell of CELLS) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "cell " + cell.type);
    g.dataset.id = cell.id;
    g.setAttribute("tabindex", "-1");
    g.setAttribute("role", "gridcell");

    let shape;
    if (cell.type === "num") {
      shape = document.createElementNS(SVGNS, "rect");
      shape.setAttribute("x", cx(cell) - 38);
      shape.setAttribute("y", cy(cell) - 38);
      shape.setAttribute("width", 76);
      shape.setAttribute("height", 76);
      shape.setAttribute("rx", 18);
    } else {
      shape = document.createElementNS(SVGNS, "circle");
      shape.setAttribute("cx", cx(cell));
      shape.setAttribute("cy", cy(cell));
      shape.setAttribute("r", 32);
    }
    shape.setAttribute("class", "shape");

    const text = document.createElementNS(SVGNS, "text");
    text.setAttribute("x", cx(cell));
    text.setAttribute("y", cy(cell) + 1);
    text.setAttribute("class", "glyph");
    text.textContent = cell.type === "num" ? cell.val : OP_GLYPH[cell.val];

    g.appendChild(shape);
    g.appendChild(text);
    g.addEventListener("click", () => onCellClick(cell.id));
    cellLayer.appendChild(g);
  }
}

function cellEl(id) { return cellLayer.querySelector(`.cell[data-id="${id}"]`); }
function edgeEl(key) { return edgeLayer.querySelector(`.edge[data-edge="${key}"]`); }
function lockEl(key) { return edgeLayer.querySelector(`.edge-lock[data-lock="${key}"]`); }

function renderEdges() {
  for (const key of EDGES) {
    const el = edgeEl(key);
    el.classList.remove("mine", "bot");
    const owner = state.locked[key];
    if (owner) el.classList.add(owner);

    // lock nub: ✓ for routes you spent, ✕ for links the bot took
    const lock = lockEl(key);
    lock.classList.remove("on", "mine", "bot");
    const mark = lock.querySelector("text");
    if (owner) {
      lock.classList.add("on", owner);
      mark.textContent = owner === "mine" ? "✓" : "✕";
    } else {
      mark.textContent = "";
    }
  }
}

// which cells can the player move to right now
function reachableCells() {
  const set = new Set();
  const path = state.playerPath;
  if (path.length === 0) {
    // any number cell can start
    for (const c of CELLS) if (c.type === "num") set.add(c.id);
  } else {
    const last = path[path.length - 1];
    for (const nb of neighbourIds(last)) {
      if (path.includes(nb)) continue;
      if (isLocked(edgeKey(last, nb))) continue;
      set.add(nb);
    }
  }
  return set;
}

function renderCells() {
  const reach = reachableCells();
  const path = state.playerPath;
  for (const cell of CELLS) {
    const el = cellEl(cell.id);
    el.classList.remove("reachable", "inpath", "endpoint", "cursor");
    if (path.includes(cell.id)) {
      el.classList.add("inpath");
      if (cell.id === path[0] || cell.id === path[path.length - 1]) {
        if (cell.type === "num") el.classList.add("endpoint");
      }
    } else if (reach.has(cell.id)) {
      el.classList.add("reachable");
    }
    if (cell.id === state.cursor) el.classList.add("cursor");
  }
}

function renderPathLine(flash) {
  const pts = state.playerPath.map((id) => `${cx(CELLS[id])},${cy(CELLS[id])}`).join(" ");
  pathLine.setAttribute("points", pts);
  if (flash && !reduceMotion) {
    pathLine.classList.add("flash");
    setTimeout(() => pathLine.classList.remove("flash"), 90);
  }
}

/* ---------- Expression + value ---------- */
function currentValue() {
  const path = state.playerPath;
  if (path.length === 0) return null;
  const last = CELLS[path[path.length - 1]];
  if (last.type !== "num" || path.length < 3) return null;
  return evaluatePath(path);
}

function exprString() {
  const path = state.playerPath;
  if (path.length === 0) return null;
  return path
    .map((id) => (CELLS[id].type === "num" ? CELLS[id].val : OP_GLYPH[CELLS[id].val]))
    .join(" ");
}

function renderExpr() {
  const exprEl = document.getElementById("expr");
  const str = exprString();
  if (!str) {
    exprEl.innerHTML = '<span class="hint">Tap a number to start</span>';
    return;
  }
  const val = currentValue();
  if (val === null) {
    exprEl.textContent = str;
  } else {
    exprEl.innerHTML = `${str} <span class="eq">= ${fmt(val)}</span>`;
  }
}

function fmt(v) {
  if (Number.isInteger(v)) return String(v);
  return (Math.round(v * 100) / 100).toString();
}

/* ---------- Submit button state ---------- */
function refreshSubmit() {
  const btn = document.getElementById("submitBtn");
  const val = currentValue();
  btn.disabled = val === null;
}

/* ---------- Full render ---------- */
function render() {
  renderEdges();
  renderCells();
  renderPathLine(false);
  renderExpr();
  refreshSubmit();
}

/* ---------- Messages ---------- */
let msgTimer = null;
function setMsg(text, alert) {
  const el = document.getElementById("msg");
  el.textContent = text || " ";
  el.classList.toggle("alert", !!alert);
}

// Always-visible cue that the bot just consumed a link (even when you're
// not the one being blocked). Makes the shared-board consumption legible.
let toastTimer = null;
function showBotToast(text) {
  const el = document.getElementById("botToast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1200);
}

/* ===================================================================
   PHASE 2 — TRACING A PATH
   =================================================================== */
function onCellClick(id) {
  if (!state.running) return;
  const path = state.playerPath;

  // undo: click the current last cell
  if (path.length && id === path[path.length - 1]) {
    path.pop();
    state.cursor = path.length ? path[path.length - 1] : id;
    setMsg("");
    afterPathChange();
    return;
  }

  if (path.length === 0) {
    if (CELLS[id].type !== "num") {
      setMsg("Start on a number.");
      return;
    }
    path.push(id);
    state.cursor = id;
    afterPathChange();
    return;
  }

  // extend
  const last = path[path.length - 1];
  if (path.includes(id)) { setMsg("Can't cross your own route."); return; }
  if (!areNeighbours(CELLS[last], CELLS[id])) { setMsg("Only next-door cells."); return; }
  if (isLocked(edgeKey(last, id))) { setMsg("That link is taken."); return; }

  path.push(id);
  state.cursor = id;
  popCell(id);
  afterPathChange();
}

function popCell(id) {
  if (reduceMotion) return;
  const shape = cellEl(id).querySelector(".shape");
  shape.style.transform = "scale(1.18)";
  setTimeout(() => { shape.style.transform = ""; }, 120);
}

// after any change to the path: re-render, then maybe auto-submit
function afterPathChange() {
  render();
  const val = currentValue();
  if (val !== null && val === state.target) {
    submitPath();
  }
}

/* ---------- Submit ---------- */
function submitPath() {
  const path = state.playerPath;
  const val = currentValue();
  if (val === null) return;

  if (val === state.target) {
    // correct
    renderPathLine(true);
    for (const e of pathEdges(path)) state.locked[e] = "mine";
    state.youScore++;
    document.getElementById("youScore").textContent = state.youScore;
    bounce(document.getElementById("youScore"));
    state.playerPath = [];
    setMsg("");
    nextTarget();
    render();
  } else {
    // wrong — no penalty, just clear
    shakeBoard();
    setMsg(`That makes ${fmt(val)}, not ${state.target}.`);
    state.playerPath = [];
    render();
  }
}

function bounce(el) {
  if (reduceMotion) return;
  el.style.transform = "scale(1.3)";
  setTimeout(() => { el.style.transform = ""; }, 150);
}
function shakeBoard() {
  if (reduceMotion) return;
  const wrap = document.getElementById("boardWrap");
  wrap.classList.add("shake");
  setTimeout(() => wrap.classList.remove("shake"), 240);
}

/* ---------- Target handling ---------- */
function setTargetDisplay(value) {
  const el = document.getElementById("target");
  if (reduceMotion) { el.textContent = value === null ? "—" : value; return; }
  el.classList.add("swapping");
  setTimeout(() => {
    el.textContent = value === null ? "—" : value;
    el.classList.remove("swapping");
  }, 180);
}

function nextTarget() {
  const t = pickTarget();
  if (t === null) { endRound("No routes left."); return; }
  state.target = t;
  setTargetDisplay(t);
}

// If current target became unreachable (after a bot lock), reroll it.
function ensureTargetReachable() {
  if (state.target === null) return;
  const counts = reachableTargets();
  if (!counts.has(state.target)) {
    const t = pickTarget();
    if (t === null) { endRound("No routes left."); return; }
    state.target = t;
    setTargetDisplay(t);
    setMsg("Target moved — that one's out of reach now.");
  }
}

/* ===================================================================
   PHASE 4 — THE BOT
   Claims an edge on a live solution path, but never one that would
   make the target unreachable (the slide-10 fix, running live).
   =================================================================== */
let botTimer = null;

function botTick() {
  if (!state.running || state.target === null) return;

  const openEdges = EDGES.filter((e) => !isLocked(e));
  if (openEdges.length === 0) { endRound("Every link is gone."); return; }

  const solPaths = solutionPathsFor(state.target);
  if (solPaths.length === 0) { ensureTargetReachable(); return; }

  const solEdgeSet = new Set();
  for (const p of solPaths) for (const e of p.edges) if (!isLocked(e)) solEdgeSet.add(e);

  // Prefer edges on a solution path that STILL leave the target reachable.
  let candidates = shuffle([...solEdgeSet]).filter((e) =>
    reachableAfterLocking(state.target, e)
  );

  let pick = candidates[0];

  // If every solution edge is critical, don't kill the board — squeeze
  // elsewhere instead (a non-solution open edge is always safe here).
  if (!pick) {
    const nonSol = openEdges.filter((e) => !solEdgeSet.has(e));
    pick = shuffle(nonSol)[0];
  }
  if (!pick) return; // nothing safe to take this tick

  claimEdge(pick);
}

function claimEdge(key) {
  state.locked[key] = "bot";

  // does this break the route the player is building?
  const path = state.playerPath;
  let broke = false;
  for (let i = 0; i < path.length - 1; i++) {
    if (edgeKey(path[i], path[i + 1]) === key) {
      state.playerPath = path.slice(0, i + 1); // truncate at the break
      broke = true;
      break;
    }
  }

  if (broke) {
    state.rerouteCount++;
    setMsg("That route's gone.", true);
    showBotToast("Broke your route");
  } else {
    showBotToast("Bot locked a link");
  }

  // bump the bot's score sometimes, so it feels alive
  if (Math.random() < BOT_SCORE_CHANCE) {
    state.botScore++;
    document.getElementById("botScore").textContent = state.botScore;
    bounce(document.getElementById("botScore"));
  }

  render();
  ensureTargetReachable();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ===================================================================
   PHASE 5 — ROUND & RESULT
   =================================================================== */
let clockTimer = null;

function tickClock() {
  state.timeLeft--;
  renderClock();
  if (state.timeLeft <= 0) endRound("Time!");
}

function renderClock() {
  const el = document.getElementById("timer");
  const m = Math.floor(state.timeLeft / 60);
  const s = state.timeLeft % 60;
  el.textContent = `${m}:${String(s).padStart(2, "0")}`;
  el.classList.toggle("amber", state.timeLeft <= 30 && state.timeLeft > 10);
  el.classList.toggle("red", state.timeLeft <= 10);
}

function endRound(reason) {
  if (!state.running) return;
  state.running = false;
  clearInterval(clockTimer);
  clearInterval(botTimer);

  document.getElementById("endScoreLine").textContent =
    `You ${state.youScore} — Bot ${state.botScore}`;
  const n = state.rerouteCount;
  document.getElementById("endRerouteLine").textContent =
    n === 0
      ? "Their locks never forced you to reroute. Locking was decoration this round."
      : `Their locks forced you to reroute ${n} time${n === 1 ? "" : "s"}.`;
  document.getElementById("endScreen").classList.remove("hidden");
  if (reason) setMsg(reason);
}

/* ===================================================================
   START / RESET
   =================================================================== */
function startRound() {
  state.locked = {};
  state.playerPath = [];
  state.youScore = 0;
  state.botScore = 0;
  state.timeLeft = ROUND_SECONDS;
  state.rerouteCount = 0;
  state.target = null;
  state.cursor = 0;
  state.running = true;

  document.getElementById("youScore").textContent = "0";
  document.getElementById("botScore").textContent = "0";
  document.getElementById("endScreen").classList.add("hidden");
  setMsg("");
  renderClock();

  const t = pickTarget();
  state.target = t;
  document.getElementById("target").textContent = t === null ? "—" : t;

  render();

  clockTimer = setInterval(tickClock, 1000);
  botTimer = setInterval(botTick, BOT_INTERVAL_MS);
}

/* ===================================================================
   KEYBOARD  (arrows move, Enter activates, Esc clears)
   =================================================================== */
function moveCursor(dr, dc) {
  const cur = CELLS[state.cursor];
  const nr = cur.r + dr, nc = cur.c + dc;
  const target = CELLS.find((c) => c.r === nr && c.c === nc);
  if (target) { state.cursor = target.id; render(); }
}

document.addEventListener("keydown", (e) => {
  if (!state.running) {
    if (e.key === "Enter" && !document.getElementById("endScreen").classList.contains("hidden")) {
      startRound();
    }
    return;
  }
  switch (e.key) {
    case "ArrowUp": e.preventDefault(); moveCursor(-1, 0); break;
    case "ArrowDown": e.preventDefault(); moveCursor(1, 0); break;
    case "ArrowLeft": e.preventDefault(); moveCursor(0, -1); break;
    case "ArrowRight": e.preventDefault(); moveCursor(0, 1); break;
    case "Enter": e.preventDefault(); onCellClick(state.cursor); break;
    case "Escape":
      e.preventDefault();
      state.playerPath = [];
      setMsg("");
      render();
      break;
    default: break;
  }
});

/* ---------- Buttons ---------- */
document.getElementById("submitBtn").addEventListener("click", () => {
  if (currentValue() !== null) submitPath();
});
document.getElementById("clearBtn").addEventListener("click", () => {
  state.playerPath = [];
  setMsg("");
  render();
});
document.getElementById("playAgain").addEventListener("click", startRound);

/* ---------- Boot ---------- */
buildBoard();
startRound();

// expose a little debug hook (handy while tuning)
window.SG = { state, ALL_PATHS, reachableTargets };
