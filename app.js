"use strict";

/*
 * Клиент игры «Воздушный Шар».
 *
 * Клиент ничего не решает: точку краха знает только сервер. Здесь — отрисовка
 * и отправка намерений («запустить», «забрать»). Коэффициент между опросами
 * сервера экстраполируется по той же экспоненте, чтобы шар летел плавно,
 * но итог всегда берётся из ответа сервера.
 */

const USERNAME = "demo";
const POLL_MS = 150;

const $ = (id) => document.getElementById(id);

const api = {
  base: resolveApiBase(),
  async call(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, data };
  },
};

function resolveApiBase() {
  const fromQuery = new URLSearchParams(location.search).get("api");
  if (fromQuery) {
    try { localStorage.setItem("balloon-api", fromQuery); } catch (_) { /* приватный режим */ }
    return fromQuery.replace(/\/$/, "");
  }
  try {
    const saved = localStorage.getItem("balloon-api");
    if (saved) return saved;
  } catch (_) { /* ignore */ }
  return (window.BALLOON_DEFAULT_API || "http://localhost:8080").replace(/\/$/, "");
}

const state = {
  config: null,
  user: null,
  theme: "green",
  betId: 1,
  round: null,      // { id, startedAt (performance.now), rate, multiplier, status }
  trail: [],        // [{ t, m }]
  pollTimer: null,
  resultTimer: null,
  popAt: null,
};

/* ------------------------------------------------------------------ загрузка */

async function boot() {
  $("api-url").textContent = api.base;
  bindUi();
  resizeCanvas();
  draw();
  try {
    await Promise.all([loadConfig(), loadUser()]);
    renderBets();
    renderThemes();
    loadHistory();
  } catch (e) {
    showError("Сервер недоступен по адресу " + api.base + ". Запустите backend или нажмите «сменить» внизу страницы.");
  }
}

async function loadConfig() {
  const r = await api.call("GET", "/api/config/public");
  if (!r.ok) throw new Error("config");
  state.config = r.data;
  const reward = r.data.reward;
  $("collection-bonus").textContent = reward && reward.enabled
    ? "набор из " + reward.collectionSize + " — +" + reward.bonusForFullSet + " бонусов" : "выключена";
}

async function loadUser() {
  const r = await api.call("GET", "/api/users/" + USERNAME);
  if (!r.ok) throw new Error("user");
  state.user = r.data;
  $("balance").textContent = fmtInt(r.data.bonusBalance);
  $("points").textContent = fmtInt(r.data.points);
  $("username").textContent = r.data.username;
  renderFragments();
  renderBets();
}

async function loadHistory() {
  const mine = $("only-mine").checked;
  const r = await api.call("GET", "/api/history?size=12" + (mine ? "&username=" + USERNAME : ""));
  const body = $("history");
  if (!r.ok || !r.data.items.length) {
    body.innerHTML = '<tr><td class="empty" colspan="9">Полётов пока не было</td></tr>';
    return;
  }
  body.innerHTML = r.data.items.map((e) => `
    <tr>
      <td>${e.roundId}</td>
      <td>${escapeHtml(e.username)}</td>
      <td><span class="dot ${e.theme === "red" ? "red" : "green"}"></span>${e.theme === "red" ? "красный" : "зелёный"}</td>
      <td class="num">${fmtInt(e.bet)}</td>
      <td class="num ${e.won ? "won" : ""}">${e.cashoutMultiplier != null ? "x" + e.cashoutMultiplier.toFixed(2) : "—"}</td>
      <td class="num ${e.won ? "" : "lost"}">x${e.crashMultiplier.toFixed(2)}</td>
      <td class="num">${e.payout ? "+" + fmtInt(e.payout) : "0"}</td>
      <td class="num">${fmtInt(e.pointsEarned)}</td>
      <td>${e.reward ? escapeHtml(e.reward.split(" — ")[0]) : ""}</td>
    </tr>`).join("");
}

/* ------------------------------------------------------------------ панель */

function bindUi() {
  document.querySelectorAll('input[name="theme"]').forEach((el) =>
    el.addEventListener("change", () => { state.theme = el.value; draw(); }));
  $("launch").addEventListener("click", launch);
  $("cashout").addEventListener("click", cashout);
  $("again").addEventListener("click", closeResult);
  $("only-mine").addEventListener("change", loadHistory);
  $("change-api").addEventListener("click", () => {
    const next = prompt("Адрес backend", api.base);
    if (next) { location.search = "?api=" + encodeURIComponent(next.trim()); }
  });
  window.addEventListener("resize", () => { resizeCanvas(); draw(); });
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.target.closest("input, button")) return;
    e.preventDefault();
    if (!$("cashout").disabled) cashout();
    else if (!$("launch").disabled) launch();
  });
}

function renderThemes() {
  if (!state.config) return;
  for (const [name, theme] of Object.entries(state.config.themes)) {
    const meta = document.querySelector(`[data-theme-meta="${name}"]`);
    if (meta) meta.textContent = theme.levels + " уровней · до x" + theme.levelMultipliers.at(-1);
  }
}

function renderBets() {
  if (!state.config) return;
  const flying = isFlying();
  $("bets").innerHTML = state.config.bets.map((b) => {
    const tooExpensive = state.user && b.cost > state.user.bonusBalance;
    const booster = b.boosterMultiplier > 1 ? "бустер x" + b.boosterMultiplier : "без бустера";
    return `<button class="bet" type="button" id="bet-${b.id}" data-bet="${b.id}"
      aria-pressed="${b.id === state.betId}" ${tooExpensive || flying ? "disabled" : ""}>
      <span class="bet-cost">${fmtInt(b.cost)}</span>
      <span class="bet-meta">${tooExpensive ? "не хватает бонусов" : booster}</span>
    </button>`;
  }).join("");
  $("bets").querySelectorAll(".bet").forEach((el) =>
    el.addEventListener("click", () => { state.betId = Number(el.dataset.bet); renderBets(); }));
}

function renderFragments() {
  const size = state.config?.reward?.collectionSize || 6;
  const have = new Set(state.user?.fragments || []);
  $("fragments").innerHTML = Array.from({ length: size }, (_, i) =>
    `<li class="${have.has(i + 1) ? "have" : ""}" title="Фрагмент ${i + 1}">${i + 1}</li>`).join("");
}

function setControls() {
  const flying = isFlying();
  $("launch").disabled = flying;
  document.querySelectorAll('input[name="theme"]').forEach((el) => { el.disabled = flying; });
  const canCash = flying && currentLevel(state.round.multiplier) >= 1;
  $("cashout").disabled = !canCash;
  renderBets();
}

/* ------------------------------------------------------------------ раунд */

async function launch() {
  hideError();
  closeResult(true);
  $("launch").disabled = true;
  const r = await api.call("POST", "/api/rounds", { username: USERNAME, theme: state.theme, betId: state.betId });

  if (r.status === 409 && r.data?.error === "active_round_exists") {
    // Прошлый полёт ещё идёт (например, страницу перезагрузили) — продолжаем его.
    startRound(r.data.activeRoundId, null);
    $("hint").textContent = "Продолжаем начатый полёт №" + r.data.activeRoundId + ".";
    return;
  }
  if (!r.ok) {
    $("launch").disabled = false;
    showError(r.data?.error === "insufficient_balance"
      ? "Не хватает бонусов: на счёте " + r.data.balance + ", ставка " + r.data.required + "."
      : (r.data?.message || "Не удалось начать раунд."));
    return;
  }
  startRound(r.data.roundId, r.data.multiplier);
  loadUser();
}

function startRound(id, multiplier) {
  state.round = { id, startedAt: performance.now(), rate: null, multiplier: multiplier || 1, status: "RUNNING", serverAt: performance.now(), serverM: multiplier || 1 };
  state.trail = [{ t: 0, m: state.round.multiplier }];
  state.popAt = null;
  $("stamp").hidden = true;
  document.querySelector(".readout").className = "readout";
  $("round-label").textContent = "раунд №" + id + " · " + (state.theme === "red" ? "красный" : "зелёный");
  $("hint").textContent = "Шар набирает высоту. «Забрать» откроется после первого уровня. Пробел — то же, что кнопка.";
  setControls();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(poll, POLL_MS);
  requestAnimationFrame(tick);
}

async function poll() {
  const round = state.round;
  if (!round || round.status !== "RUNNING") return;
  let r;
  try { r = await api.call("GET", "/api/rounds/" + round.id + "/state"); } catch (_) { return; }
  if (!r.ok || state.round !== round) return;

  const now = performance.now();
  if (r.data.state === "RUNNING") {
    const m = r.data.multiplier;
    if (m > 1.005) {
      // m = exp(rate · t): темп считаем по серверному ответу, а не угадываем.
      round.rate = Math.log(m) / ((now - round.startedAt) / 1000);
    }
    round.serverAt = now;
    round.serverM = m;
  } else {
    finish(r.data);
  }
}

function tick() {
  const round = state.round;
  if (!round) return;
  if (round.status === "RUNNING") {
    const t = (performance.now() - round.startedAt) / 1000;
    let m = round.serverM;
    if (round.rate) {
      // Экстраполяция не уходит дальше, чем на 0.4 с от последнего ответа сервера.
      const ahead = Math.min(0.4, (performance.now() - round.serverAt) / 1000);
      m = round.serverM * Math.exp(round.rate * ahead);
    }
    round.multiplier = Math.max(round.multiplier, m);
    state.trail.push({ t, m: round.multiplier });
    updateReadout(round.multiplier);
    setCashoutOnly();
  }
  draw();
  if (round.status === "RUNNING" || (state.popAt && performance.now() - state.popAt < 900)) {
    requestAnimationFrame(tick);
  }
}

function setCashoutOnly() {
  const can = isFlying() && currentLevel(state.round.multiplier) >= 1;
  if ($("cashout").disabled === can) $("cashout").disabled = !can;
}

async function cashout() {
  const round = state.round;
  if (!round || round.status !== "RUNNING") return;
  $("cashout").disabled = true;
  const r = await api.call("POST", "/api/rounds/" + round.id + "/cashout?username=" + USERNAME);
  if (r.ok) {
    finish(r.data);
  } else if (r.data?.error === "cashout_too_early") {
    setControls();
  } else {
    showError(r.data?.message || "Не удалось забрать выигрыш.");
    setControls();
  }
}

function finish(result) {
  const round = state.round;
  if (!round || round.status !== "RUNNING") return;
  clearInterval(state.pollTimer);
  round.status = result.state;
  round.multiplier = result.multiplier;
  const won = result.state === "CASHED_OUT";
  const t = (performance.now() - round.startedAt) / 1000;
  state.trail.push({ t, m: won ? state.trail.at(-1).m : result.multiplier });

  updateReadout(result.multiplier);
  document.querySelector(".readout").classList.add(won ? "is-won" : "is-crashed");
  const stamp = $("stamp");
  stamp.hidden = false;
  stamp.className = "stamp" + (won ? " won" : "");
  stamp.textContent = won ? "Забрал" : "Лопнул";
  $("hint").textContent = won
    ? "Выигрыш зафиксирован сервером на x" + result.multiplier.toFixed(2) + "."
    : "Шар лопнул на x" + result.multiplier.toFixed(2) + ". Ставка сгорела, очки за уровни начислены.";

  if (!won) { state.popAt = performance.now(); requestAnimationFrame(tick); }
  setControls();
  loadUser();
  loadHistory();
  setTimeout(() => showResult(result, round), won ? 500 : 1100);
}

function showResult(result, round) {
  if (state.round !== round) return;
  const won = result.state === "CASHED_OUT";
  $("result-title").textContent = won ? "Забрали " + fmtInt(result.payout) + " бонусов" : "Шар лопнул";
  $("r-mult").textContent = "x" + result.multiplier.toFixed(2);
  $("r-payout").textContent = won ? "+" + fmtInt(result.payout) : "0";
  $("r-points").textContent = "+" + fmtInt(result.pointsEarned);
  $("r-booster").textContent = result.boosterHit ? "сработал" : "нет";
  $("r-reward").textContent = result.reward ? "Награда: " + result.reward : "";
  $("result").hidden = false;
  $("again").focus();

  let left = state.config?.round?.idleTimeoutSeconds || 10;
  $("r-timer").textContent = "Закроется через " + left + " с";
  clearInterval(state.resultTimer);
  state.resultTimer = setInterval(() => {
    left -= 1;
    $("r-timer").textContent = "Закроется через " + left + " с";
    if (left <= 0) closeResult();
  }, 1000);
}

function closeResult(silent) {
  clearInterval(state.resultTimer);
  $("result").hidden = true;
  if (!silent && !isFlying()) $("launch").focus();
}

/* ------------------------------------------------------------------ график */

const canvas = $("chart");
const ctx = canvas.getContext("2d");
const INK = "#1d2b3a", INK_SOFT = "#56657a", GRID = "#e1e7da", GRID_STRONG = "#b3c0a8", BALLOON = "#c8412a";

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function levels() {
  return state.config?.themes?.[state.theme]?.levelMultipliers || [1.05, 1.5, 1.9, 2.4, 3.1, 4, 5.2, 6.8, 9];
}

function currentLevel(m) {
  return levels().filter((b) => m >= b).length;
}

function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const pad = { left: 16, right: 92, top: 110, bottom: 28 };
  ctx.clearRect(0, 0, w, h);

  // Миллиметровка
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 12) { ctx.strokeStyle = x % 60 === 0 ? "#d9e0d1" : GRID; line(x + 0.5, 0, x + 0.5, h); }
  for (let y = 0; y < h; y += 12) { ctx.strokeStyle = y % 60 === 0 ? "#d9e0d1" : GRID; line(0, y + 0.5, w, y + 0.5); }

  const lv = levels();
  const last = state.trail.at(-1);
  const top = Math.max(lv.at(-1) * 1.08, last ? last.m * 1.1 : 0);
  const tMax = Math.max(16, last ? last.t + 3 : 0);
  const y = (m) => pad.top + (h - pad.top - pad.bottom) * (1 - Math.log(m) / Math.log(top));
  const x = (t) => pad.left + (w - pad.left - pad.right) * (t / tMax);
  const reached = last ? currentLevel(last.m) : 0;

  // Отметки уровней — как изобары на бланке
  ctx.font = "500 11px 'JetBrains Mono', Consolas, monospace";
  ctx.textBaseline = "middle";
  lv.forEach((bound, i) => {
    const yy = Math.round(y(bound)) + 0.5;
    const passed = i < reached;
    ctx.strokeStyle = passed ? INK : GRID_STRONG;
    ctx.setLineDash(passed ? [] : [4, 4]);
    line(pad.left, yy, w - pad.right + 6, yy);
    ctx.setLineDash([]);
    ctx.fillStyle = passed ? INK : INK_SOFT;
    ctx.fillText((i + 1) + " · x" + bound.toFixed(2), w - pad.right + 12, yy);
  });

  // Земля
  ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  line(0, h - pad.bottom + 0.5, w, h - pad.bottom + 0.5);
  ctx.fillStyle = INK_SOFT;
  ctx.textBaseline = "top";
  for (let s = 0; s <= tMax; s += tMax > 40 ? 10 : 5) ctx.fillText(s + " с", x(s) + 3, h - pad.bottom + 8);

  if (!state.trail.length) { drawBalloon(x(0), y(1) - 34, 1); return; }

  // След полёта
  ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.beginPath();
  state.trail.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.m)) : ctx.moveTo(x(p.t), y(p.m))));
  ctx.stroke();

  const px = x(last.t), py = y(last.m);
  if (state.round?.status === "CRASHED") {
    drawPop(px, py - 34);
  } else {
    drawBalloon(px, py - 34, 1);
  }
}

function drawBalloon(cx, cy, scale) {
  const r = 18 * scale;
  ctx.strokeStyle = INK; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(cx, cy + r * 1.15);
  ctx.quadraticCurveTo(cx - 5, cy + r * 1.6, cx, cy + 34); ctx.stroke();
  ctx.fillStyle = BALLOON;
  ctx.beginPath(); ctx.ellipse(cx, cy, r * 0.88, r * 1.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - 4, cy + r * 1.1 + 4); ctx.lineTo(cx + 4, cy + r * 1.1 + 4); ctx.lineTo(cx, cy + r * 1.1 - 1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath(); ctx.ellipse(cx - r * 0.35, cy - r * 0.45, r * 0.16, r * 0.3, -0.5, 0, Math.PI * 2); ctx.fill();
}

function drawPop(cx, cy) {
  const k = state.popAt ? Math.min(1, (performance.now() - state.popAt) / 600) : 1;
  ctx.strokeStyle = BALLOON; ctx.lineWidth = 3; ctx.lineCap = "round";
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const r1 = 8 + 14 * k, r2 = r1 + 10 * (1 - k * 0.5);
    line(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
  }
  ctx.lineCap = "butt";
}

function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

/* ------------------------------------------------------------------ мелочи */

function isFlying() { return !!state.round && state.round.status === "RUNNING"; }

function updateReadout(m) {
  $("multiplier").textContent = m.toFixed(2);
  const lvl = currentLevel(m);
  const total = levels().length;
  $("level-label").textContent = lvl === 0 ? "до первого уровня x" + levels()[0].toFixed(2) : "уровень " + lvl + " из " + total;
}

function showError(text) { const el = $("error"); el.textContent = text; el.hidden = false; }
function hideError() { $("error").hidden = true; }
function fmtInt(n) { return Number(n || 0).toLocaleString("ru-RU"); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

boot();
