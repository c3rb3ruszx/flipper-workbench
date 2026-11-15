/* Signal viewer: look at the timing of a Sub-GHz (.sub) or infrared (.ir) signal like a logic analyzer.
   Input is signed microseconds (positive = on, negative = off), from capture.parse in Python.
   Everything here only reads and draws; nothing is sent to the Flipper. */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = (n) => Number(n || 0).toLocaleString("en-US");
function fmtT(us, digits) {
  const a = Math.abs(us);
  if (a < 1000) return Math.round(us) + " µs";
  if (a < 1e6) return (us / 1000).toFixed(digits != null ? digits : a < 1e4 ? 2 : 1) + " ms";
  return (us / 1e6).toFixed(digits != null ? digits : 3) + " s";
}

const SIG = { api: null, fb: null, file: null, sig: null, a: null, v0: 0, v1: 1, burst: -1, idx: 0, hover: null };
window.SIG = SIG;

/* ===================================================================== analysis */
function analyze(raw) {
  const w = [];                                     // merge neighbours with the same level, drop zeros
  for (const v of raw) { if (!v) continue; if (w.length && (w[w.length - 1] > 0) === (v > 0)) w[w.length - 1] += v; else w.push(v); }
  const n = w.length, t = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) t[i + 1] = t[i] + Math.abs(w[i]);
  const total = t[n] || 1;
  const sorted = w.map(Math.abs).sort((a, b) => a - b), med = sorted[n >> 1] || 1, p75 = sorted[Math.floor(n * 0.75)] || med;
  const gap = Math.max(3000, p75 * 6);             // an off-time this long separates bursts (sync gaps, pauses between repeats)
  const raws = []; let s = -1;
  for (let i = 0; i < n; i++) {
    if (w[i] < 0 && -w[i] >= gap) { if (s >= 0) { raws.push([s, i]); s = -1; } continue; }
    if (s < 0) s = i;
  }
  if (s >= 0) raws.push([s, n]);
  let bursts = raws.filter(([a, b]) => b - a >= 8);  // shorter ones are noise between transmissions
  if (!bursts.length && raws.length) bursts = raws;
  // coded bursts use a few pulse lengths; radio noise uses many. Keep the coded ones when there are any.
  const lengths = (s0, e0) => { const v = []; for (let i = s0; i < e0; i++) v.push(Math.abs(w[i])); v.sort((x, y) => x - y); let k = 0, lo = -1; for (const x of v) if (lo < 0 || x > lo * 1.35) { k++; lo = x; } return [k, v.length]; };
  const coded = bursts.filter(([s0, e0]) => { const [k, m] = lengths(s0, e0); return k <= 6 || k <= m * 0.12; });
  const noise = bursts.length - coded.length;
  if (coded.length) bursts = coded;
  // base unit (TE): the shortest pulse length that's common
  const d = [];
  for (const [a, b] of bursts) for (let i = a; i < b; i++) d.push(Math.abs(w[i]));
  d.sort((x, y) => x - y);
  const cl = [];
  for (const v of d) { const c = cl[cl.length - 1]; if (c && v <= c.lo * 1.35) { c.sum += v; c.n++; } else cl.push({ lo: v, sum: v, n: 1 }); }
  const modes = cl.filter((c) => c.n >= Math.max(3, d.length * 0.04)).map((c) => ({ us: c.sum / c.n, n: c.n }));
  const te = modes.length ? modes[0].us : d[0] || med;
  // bursts that look the same (same pulses in units of TE, allowing a little jitter)
  const sig = bursts.map(([a, b]) => w.slice(a, b).map((v) => Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / te))));
  const same = (x, y) => { if (Math.abs(x.length - y.length) > 1) return false; const m = Math.min(x.length, y.length); let k = 0; for (let i = 0; i < m; i++) if (x[i] === y[i]) k++; return k >= m * 0.9; };
  const group = new Array(bursts.length).fill(-1);
  for (let i = 0; i < bursts.length; i++) {
    if (group[i] >= 0) continue;
    group[i] = i;
    for (let j = i + 1; j < bursts.length; j++) if (group[j] < 0 && same(sig[i], sig[j])) group[j] = i;
  }
  const counts = {}; group.forEach((g) => counts[g] = (counts[g] || 0) + 1);
  const repeats = Math.max(0, ...Object.values(counts));
  return { w, t, n, total, gap, bursts, te, modes, group, repeats, noise: coded.length ? noise : 0,
    shortest: d[0] || 0, longest: d[d.length - 1] || 0, on: w.reduce((a, v) => a + (v > 0 ? v : 0), 0) };
}

function decode(a, k) {
  const [s, e] = a.bursts[k], te = a.te;
  const p = a.w.slice(s, e);
  let i = 0, lead = null;
  if (p[0] > 0 && p[0] >= 3.5 * te && p[1] < 0) { lead = [p[0], -p[1]]; i = 2; }
  const pairs = [];
  for (; i + 1 < p.length; i += 2) if (p[i] > 0 && p[i + 1] < 0) pairs.push([p[i], -p[i + 1]]);
  const tail = p.length - i === 1 && p[i] > 0 ? p[i] : null;
  if (pairs.length < 4) return { note: "Too short to guess the coding." };
  const ratio = (arr) => Math.max(...arr) / Math.max(1, Math.min(...arr));
  const mid = (arr) => (Math.min(...arr) + Math.max(...arr)) / 2;
  const hs = pairs.map((x) => x[0]), ls = pairs.map((x) => x[1]);
  const sums = pairs.map((x) => x[0] + x[1]), msum = [...sums].sort((x, y) => x - y)[sums.length >> 1];
  let scheme, bits;
  if (ratio(hs) < 1.5 && ratio(ls) >= 1.8) {
    scheme = "Pulse distance: every pulse is the same length and the gap after it sets the bit (like NEC remotes)";
    const th = mid(ls); bits = ls.map((x) => (x > th ? 1 : 0));
  } else if (ratio(ls) < 1.5 && ratio(hs) >= 1.8) {
    scheme = "Pulse width: every gap is the same length and the pulse sets the bit (like Sony remotes)";
    const th = mid(hs); bits = hs.map((x) => (x > th ? 1 : 0));
    if (tail != null) bits.push(tail > th ? 1 : 0);   // the last pulse is a bit too: nothing follows it
  } else if (ratio(hs) >= 1.8 && ratio(ls) >= 1.8 && sums.filter((x) => Math.abs(x - msum) <= msum * 0.2).length >= sums.length * 0.9) {
    scheme = "Pulse width, fixed period: a long pulse with a short gap is one value, a short pulse with a long gap the other (most fixed-code 433 MHz remotes)";
    bits = pairs.map(([h, l]) => (h > l ? 1 : 0));
  } else if (p.every((v) => Math.round(Math.abs(v) / te) <= 3)) {
    return { note: "Pulses of one and two base units in both levels: this looks like Manchester or biphase coding (RC5, RC6, many weather sensors). Not decoded here.", lead, pairs: pairs.length };
  } else {
    return { note: "No simple pulse coding found in this burst.", lead, pairs: pairs.length };
  }
  const groups = []; for (let j = 0; j < bits.length; j += 8) groups.push(bits.slice(j, j + 8));
  const hexMsb = groups.map((g) => g.reduce((v, b) => (v << 1) | b, 0).toString(16).toUpperCase().padStart(2, "0")).join(" ");
  const hexLsb = groups.map((g) => g.reduce((v, b, j) => v | (b << j), 0).toString(16).toUpperCase().padStart(2, "0")).join(" ");
  return { scheme, bits, lead, tail, hexMsb, hexLsb };
}

/* ===================================================================== open / pick a signal */
SIG.init = function (api, fb) {
  SIG.api = api; SIG.fb = fb;
  $("#sigClose").onclick = close;
  $("#sigModal").addEventListener("mousedown", (e) => { if (e.target.id === "sigModal") close(); });
  $("#sigOpen").onclick = openPc;
  $("#sigOpenPc").onclick = openPc;
  $("#sigCopy").onclick = copyTimings;
  $("#sigFit").onclick = () => fit();
  $("#sigZoomIn").onclick = () => zoomAt(0.5, 1 / 1.6);
  $("#sigZoomOut").onclick = () => zoomAt(0.5, 1.6);
  const drop = $("#sigDrop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) openDropped(f); });
  bindScope();
  document.addEventListener("keydown", (e) => {
    if ($("#sigModal").hidden || /INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || "")) return;
    if (e.key === "Escape") { close(); e.stopPropagation(); }
    else if (e.key === "+" || e.key === "=") zoomAt(0.5, 1 / 1.6);
    else if (e.key === "-") zoomAt(0.5, 1.6);
    else if (e.key === "0") fit();
    else if (e.key === "ArrowLeft") pan(-0.2);
    else if (e.key === "ArrowRight") pan(0.2);
    else return;
    e.preventDefault();
  }, true);
  new ResizeObserver(() => { if (!$("#sigModal").hidden) drawAll(); }).observe($("#sigScope"));
};
async function openPc() {
  const r = await SIG.api.sig_open_pc();
  if (!r || r.cancelled) return;
  if (r.error) { SIG.fb.toast(r.error); return; }
  SIG.open(r, { title: r.name, sub: "on this computer" });
}
async function openDropped(f) {
  if (f.size > 8 * 1024 * 1024) { SIG.fb.toast("That file is bigger than 8 MB"); return; }
  const b64 = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(",")[1] || ""); rd.readAsDataURL(f); });
  const r = await SIG.api.sig_parse(f.name, b64);
  if (r.error) { SIG.fb.toast(r.error); return; }
  SIG.open(r, { title: f.name, sub: "on this computer" });
}
function signals(file) {
  if (file.kind === "ir") return (file.buttons || []).map((b) => ({ name: b.name, detail: b.detail || b.type, wave: b.wave, synth: b.synth, carrier: b.carrier }));
  return [{ name: file.title || "Signal", wave: file.wave, synth: file.synth }];
}
/** Open the viewer on a parsed file. opts: {title, sub, index} */
SIG.open = function (file, opts = {}) {
  SIG.file = file; SIG.opts = opts;
  $("#sigTitle").textContent = opts.title || file.name || file.title || "Signal";
  $("#sigSub").textContent = opts.sub || "";
  const list = signals(file);
  const box = $("#sigList");
  box.hidden = file.kind !== "ir";
  if (file.kind === "ir") {
    box.innerHTML = list.map((s, i) => `<button class="sig-li" data-i="${i}"${s.wave ? "" : " disabled title=\"This protocol isn't drawn here\""}><b>${esc(s.name)}</b><small>${esc(s.detail || "")}</small></button>`).join("");
    $$(".sig-li", box).forEach((b) => b.onclick = () => pick(+b.dataset.i));
  }
  $("#sigModal").hidden = false;
  SIG.fb.renderIcons($("#sigModal"));
  let start = opts.index != null ? opts.index : list.findIndex((s) => s.wave && s.wave.length);
  if (start < 0) start = 0;
  setTimeout(() => pick(start), 0);   // after the modal has a size to draw into
};
function pick(i) {
  const list = signals(SIG.file), s = list[i];
  SIG.idx = i;
  $$("#sigList .sig-li").forEach((b) => b.classList.toggle("on", +b.dataset.i === i));
  SIG.sig = s;
  if (!s || !s.wave || !s.wave.length) {
    SIG.a = null;
    $("#sigInfo").innerHTML = `<span class="chip muted">${esc(s ? s.name : "")}</span>`;
    $("#sigStats").innerHTML = `<div class="sig-empty">${s && SIG.file.kind === "ir" ? "This button's protocol isn't drawn here. Raw buttons and NEC, Samsung, Sony (SIRC), RC5, RC6, RCA and Pioneer buttons are." : "No timing in this file. Sub-GHz recordings (RAW) and Princeton keys can be shown."}</div>`;
    $("#sigBursts").innerHTML = ""; $("#sigDecode").innerHTML = "";
    drawAll();
    return;
  }
  SIG.a = analyze(s.wave);
  SIG.burst = SIG.a.bursts.length ? 0 : -1;
  renderInfo(); renderStats(); renderBursts(); renderDecode();
  fit();
}
function close() { $("#sigModal").hidden = true; SIG.a = null; }

/* ===================================================================== side panels */
function renderInfo() {
  const f = SIG.file, s = SIG.sig, g = f.signal || {}, chips = [];
  if (f.kind === "subghz") {
    if (g.freq) chips.push(`${(g.freq / 1e6).toFixed(2)} MHz`);
    if (g.preset) chips.push(g.preset);
    if (g.protocol) chips.push(g.protocol === "RAW" ? "Recording (RAW)" : g.protocol);
    if (g.te) chips.push(`TE ${g.te} µs in the file`);
  } else {
    chips.push(s.name);
    if (s.carrier) chips.push(`${(s.carrier / 1000).toFixed(s.carrier % 1000 ? 1 : 0)} kHz carrier`);
    if (s.detail) chips.push(s.detail);
  }
  $("#sigInfo").innerHTML = chips.map((c) => `<span class="chip muted">${esc(c)}</span>`).join("") +
    (s.synth ? `<span class="chip sig-synth" title="Drawn from the protocol's ideal timing, not recorded">drawn from the ${f.kind === "ir" ? "protocol" : "key"}</span>` : "") +
    (f.kind === "ir" ? `<span class="sig-note">On-times are bursts of the carrier, shown here as solid.</span>` : "");
}
function renderStats() {
  const a = SIG.a;
  const tiles = [["Length", fmtT(a.total)], ["Pulses", fmtN(Math.ceil(a.n / 2))], ["Bursts", fmtN(a.bursts.length)],
    ["Base unit", a.te ? fmtT(a.te) : "-"], ["Shortest", fmtT(a.shortest)], ["On", Math.round(a.on / a.total * 100) + "% of the time"]];
  if (a.repeats > 1) tiles.push(["Repeats", `${a.repeats} the same`]);
  $("#sigStats").innerHTML = tiles.map(([k, v]) => `<div class="sig-tile"><b>${esc(v)}</b><span>${k}</span></div>`).join("");
  const key = a.modes.slice(0, 6).map((m) => `<span><i></i>${fmtT(m.us)} <small>${a.te ? "≈ " + Math.round(m.us / a.te) + "×" : ""} · ${Math.round(m.n / Math.max(1, a.modes.reduce((x, y) => x + y.n, 0)) * 100)}%</small></span>`).join("");
  $("#sigHistKey").innerHTML = key ? `<span class="sig-hk-on">on</span><span class="sig-hk-off">off</span>` + key : "";
}
function renderBursts() {
  const a = SIG.a, box = $("#sigBursts");
  if (!a.bursts.length) { box.innerHTML = `<div class="sig-empty">No clear bursts.</div>`; return; }
  const noiseNote = a.noise ? `<div class="sig-empty">${fmtN(a.noise)} stretch${a.noise === 1 ? "" : "es"} of noise left out</div>` : "";
  box.innerHTML = a.bursts.slice(0, 300).map(([s, e], k) => {
    const g = a.group[k], dup = g !== k ? ` · same as #${g + 1}` : "";
    return `<button class="sig-burst${k === SIG.burst ? " on" : ""}" data-b="${k}"><b>#${k + 1}</b><span>at ${fmtT(a.t[s])} · ${fmtN(Math.ceil((e - s) / 2))} pulses · ${fmtT(a.t[e] - a.t[s])}${dup}</span></button>`;
  }).join("") + (a.bursts.length > 300 ? `<div class="sig-empty">and ${fmtN(a.bursts.length - 300)} more</div>` : "") + noiseNote;
  $$(".sig-burst", box).forEach((b) => b.onclick = () => { SIG.burst = +b.dataset.b; renderBursts(); renderDecode(); zoomBurst(SIG.burst); });
}
function renderDecode() {
  const a = SIG.a, box = $("#sigDecode");
  if (!a || SIG.burst < 0) { box.innerHTML = ""; return; }
  const d = decode(a, SIG.burst);
  let h = `<div class="vw-sec">Burst #${SIG.burst + 1}: decoding guess</div>`;
  if (d.lead) h += `<div class="sig-dl">Starts with a ${fmtT(d.lead[0])} pulse and a ${fmtT(d.lead[1])} gap (a header).</div>`;
  if (d.note) h += `<div class="sig-dl">${esc(d.note)}</div>`;
  else {
    const grouped = d.bits.join("").replace(/(.{8})/g, "$1 ").trim();
    h += `<div class="sig-dl">${esc(d.scheme)}.</div>` +
      `<div class="sig-kv"><span><small>Bits</small>${d.bits.length}</span><span><small>As sent</small><code>${grouped}</code></span></div>` +
      `<div class="sig-kv"><span><small>Hex, first bit highest</small><code>${d.hexMsb}</code></span><span><small>Bytes, first bit lowest</small><code>${d.hexLsb}</code></span></div>`;
  }
  h += `<div class="sig-dl muted">A guess from the timing alone, to help you read the signal.</div>`;
  box.innerHTML = h;
}
async function copyTimings() {
  const a = SIG.a; if (!a) return;
  const [s, e] = SIG.burst >= 0 ? a.bursts[SIG.burst] : [0, a.n];
  await SIG.api.copy(a.w.slice(s, e).join(" "));
  SIG.fb.toast(`Copied ${fmtN(e - s)} timings`);
}

/* ===================================================================== scope: view, zoom, pan */
function fit() { if (!SIG.a) { drawAll(); return; } SIG.v0 = 0; SIG.v1 = SIG.a.total; drawAll(); }
function setView(v0, v1) {
  const a = SIG.a; if (!a) return;
  let span = Math.max(20, Math.min(a.total, v1 - v0));
  v0 = Math.max(0, Math.min(a.total - span, v0));
  SIG.v0 = v0; SIG.v1 = v0 + span; drawAll();
}
function zoomAt(fx, f) { const sp = SIG.v1 - SIG.v0, c = SIG.v0 + sp * fx; setView(c - sp * f * fx, c + sp * f * (1 - fx)); }
function pan(frac) { const sp = SIG.v1 - SIG.v0; setView(SIG.v0 + sp * frac, SIG.v1 + sp * frac); }
function zoomBurst(k) {
  const a = SIG.a, [s, e] = a.bursts[k], t0 = a.t[s], t1 = a.t[e], pad = (t1 - t0) * 0.06 + 50;
  setView(t0 - pad, t1 + pad);
}
function idxAt(time) {                     // pulse index under a time (binary search over start times)
  const t = SIG.a.t; let lo = 0, hi = SIG.a.n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] <= time) lo = m; else hi = m - 1; }
  return lo;
}
function bindScope() {
  const c = $("#sigScope");
  let drag = null;
  c.addEventListener("wheel", (e) => {
    if (!SIG.a) return; e.preventDefault();
    const r = c.getBoundingClientRect();
    zoomAt((e.clientX - r.left) / r.width, e.deltaY > 0 ? 1.25 : 1 / 1.25);
  }, { passive: false });
  c.addEventListener("mousedown", (e) => { if (SIG.a) drag = { x: e.clientX, v0: SIG.v0, v1: SIG.v1 }; });
  window.addEventListener("mouseup", () => { drag = null; });
  window.addEventListener("mousemove", (e) => {
    if (!drag || !SIG.a) return;
    const w = c.getBoundingClientRect().width, dt = (e.clientX - drag.x) / w * (drag.v1 - drag.v0);
    setView(drag.v0 - dt, drag.v1 - dt);
  });
  c.addEventListener("dblclick", () => (SIG.burst >= 0 && SIG.v1 - SIG.v0 >= SIG.a.total * 0.98 ? zoomBurst(SIG.burst) : fit()));
  c.addEventListener("mousemove", (e) => {
    if (!SIG.a) return;
    const r = c.getBoundingClientRect();
    SIG.hover = (e.clientX - r.left) / r.width;
    drawScope(); showTip(e.clientX - r.left, e.clientY - r.top, r.width);
  });
  c.addEventListener("mouseleave", () => { SIG.hover = null; $("#sigTip").hidden = true; drawScope(); });
  const m = $("#sigMini");
  const jump = (e) => { const r = m.getBoundingClientRect(), sp = SIG.v1 - SIG.v0, ct = (e.clientX - r.left) / r.width * SIG.a.total; setView(ct - sp / 2, ct + sp / 2); };
  let mdrag = false;
  m.addEventListener("mousedown", (e) => { if (!SIG.a) return; mdrag = true; jump(e); });
  window.addEventListener("mousemove", (e) => { if (mdrag && SIG.a) jump(e); });
  window.addEventListener("mouseup", () => { mdrag = false; });
}
function showTip(px, py, width) {
  const a = SIG.a, tip = $("#sigTip");
  const time = SIG.v0 + (SIG.v1 - SIG.v0) * (px / width), i = idxAt(time), v = a.w[i];
  if (v == null) { tip.hidden = true; return; }
  const units = a.te ? Math.abs(v) / a.te : 0;
  tip.innerHTML = `<b>${v > 0 ? "On" : "Off"} for ${fmtT(Math.abs(v))}</b>${a.te ? ` <small>≈ ${units < 10 ? units.toFixed(1) : Math.round(units)}× base unit</small>` : ""}<br><small>at ${fmtT(time)} · pulse ${fmtN(i + 1)} of ${fmtN(a.n)}</small>`;
  tip.hidden = false;
  tip.style.left = Math.min(px + 14, width - tip.offsetWidth - 6) + "px";
  tip.style.top = Math.max(4, py - tip.offsetHeight - 10) + "px";
}

/* ===================================================================== drawing */
function canvas2d(c) {
  const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  return [x, w, h];
}
const C = { on: "#ff8200", onFill: "rgba(255,130,0,.16)", off: "#4fb3ff", grid: "#232323", text: "#8d8780", burst: "rgba(255,255,255,.035)", sel: "rgba(255,210,74,.10)", selLine: "rgba(255,210,74,.55)" };
function drawAll() { drawScope(); drawMini(); drawHist(); $("#sigView").textContent = SIG.a ? `${fmtT(SIG.v0)} to ${fmtT(SIG.v1)} (${fmtT(SIG.v1 - SIG.v0)} shown)` : ""; }
function niceStep(span, px) {
  const raw = span / Math.max(1, px / 95), p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
/** One state per pixel column: 1 = on, 2 = off, 3 = both (too many pulses to tell apart). */
function columns(a, v0, v1, W) {
  const col = new Uint8Array(W), span = v1 - v0;
  let i = Math.max(0, idxAt(v0));
  for (; i < a.n && a.t[i] < v1; i++) {
    const x0 = Math.max(0, Math.floor((a.t[i] - v0) / span * W)), x1 = Math.min(W - 1, Math.ceil((a.t[i + 1] - v0) / span * W) - 1);
    const bit = a.w[i] > 0 ? 1 : 2;
    for (let k = x0; k <= Math.max(x0, x1); k++) col[k] |= bit;
  }
  return col;
}
function trace(x, col, yOn, yOff, fill) {
  const W = col.length;
  if (fill) { x.fillStyle = C.onFill; for (let k = 0; k < W; k++) if (col[k] & 1) x.fillRect(k, yOn, 1, yOff - yOn); }
  x.beginPath();
  let prev = 0;
  for (let k = 0; k < W; k++) {
    const s = col[k]; if (!s) { prev = 0; continue; }
    if (s === 3) { x.moveTo(k + .5, yOn); x.lineTo(k + .5, yOff); prev = 3; continue; }
    const y = s === 1 ? yOn : yOff;
    if (prev === 1 || prev === 2) { const py = prev === 1 ? yOn : yOff; if (py !== y) { x.moveTo(k, py); x.lineTo(k, y); } x.moveTo(k, y); }
    else x.moveTo(k, y);
    x.lineTo(k + 1, y); prev = s;
  }
  x.stroke();
}
function drawScope() {
  const c = $("#sigScope"); if (!c) return;
  const [x, W, H] = canvas2d(c);
  const a = SIG.a;
  if (!a) { x.fillStyle = C.text; x.font = "13px " + getComputedStyle(document.body).getPropertyValue("--px"); x.fillText("No timing to draw.", 14, H / 2); return; }
  const v0 = SIG.v0, v1 = SIG.v1, span = v1 - v0, X = (t) => (t - v0) / span * W;
  const top = 20, yOn = top + 26, yOff = H - 30;
  // bursts
  a.bursts.forEach(([s, e], k) => {
    const x0 = X(a.t[s]), x1 = X(a.t[e]); if (x1 < 0 || x0 > W) return;
    x.fillStyle = k === SIG.burst ? C.sel : C.burst; x.fillRect(x0, top, Math.max(1, x1 - x0), H - top);
    if (k === SIG.burst) { x.fillStyle = C.selLine; x.fillRect(x0, top, 1, H - top); x.fillRect(x1, top, 1, H - top); }
    if (x1 - x0 > 26) { x.fillStyle = C.text; x.font = "10px " + getComputedStyle(document.body).getPropertyValue("--mono"); x.fillText("#" + (k + 1), Math.max(2, x0 + 3), top + 11); }
  });
  // ruler
  const step = niceStep(span, W), mono = getComputedStyle(document.body).getPropertyValue("--mono");
  x.font = "10px " + mono; x.fillStyle = C.text; x.strokeStyle = C.grid; x.lineWidth = 1;
  for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
    const px = Math.round(X(t)) + .5;
    x.beginPath(); x.moveTo(px, top); x.lineTo(px, H); x.stroke();
    x.fillText(fmtT(t, step < 1000 ? 0 : step < 1e4 ? 1 : step < 1e6 ? 0 : 2), px + 3, 12);
  }
  // trace
  x.strokeStyle = C.on; x.lineWidth = 1.4;
  trace(x, columns(a, v0, v1, Math.max(1, Math.floor(W))), yOn, yOff, true);
  // pulse lengths, once there's room to write them
  let i = Math.max(0, idxAt(v0)), shown = 0;
  x.textAlign = "center";
  for (; i < a.n && a.t[i] < v1 && shown < 600; i++) {
    const x0 = X(a.t[i]), x1 = X(a.t[i + 1]);
    if (x1 - x0 < 38) continue;
    const label = fmtT(Math.abs(a.w[i]), Math.abs(a.w[i]) < 1e4 ? 2 : 1);
    x.fillStyle = a.w[i] > 0 ? C.on : C.off;
    x.fillText(label, Math.max(x0 + 20, Math.min(x1 - 20, (x0 + x1) / 2)), a.w[i] > 0 ? yOn - 6 : yOff + 14);
    shown++;
  }
  x.textAlign = "left";
  // cursor
  if (SIG.hover != null) { x.strokeStyle = "rgba(255,255,255,.35)"; x.beginPath(); x.moveTo(Math.round(SIG.hover * W) + .5, top); x.lineTo(Math.round(SIG.hover * W) + .5, H); x.stroke(); }
}
function drawMini() {
  const c = $("#sigMini"); if (!c) return;
  const [x, W, H] = canvas2d(c);
  const a = SIG.a; if (!a) return;
  x.strokeStyle = "rgba(255,130,0,.75)"; x.lineWidth = 1;
  trace(x, columns(a, 0, a.total, Math.max(1, Math.floor(W))), 5, H - 5, false);
  const x0 = SIG.v0 / a.total * W, x1 = SIG.v1 / a.total * W;
  x.fillStyle = "rgba(255,255,255,.08)"; x.fillRect(x0, 0, Math.max(2, x1 - x0), H);
  x.strokeStyle = "rgba(255,210,74,.8)"; x.strokeRect(x0 + .5, .5, Math.max(2, x1 - x0) - 1, H - 1);
}
function drawHist() {
  const c = $("#sigHist"); if (!c) return;
  const [x, W, H] = canvas2d(c);
  const a = SIG.a; if (!a || !a.bursts.length) return;
  const vals = []; for (const [s, e] of a.bursts) for (let i = s; i < e; i++) vals.push(a.w[i]);
  const lo = Math.max(1, a.shortest * 0.8), hi = Math.max(lo * 2, a.longest * 1.2), L0 = Math.log(lo), L1 = Math.log(hi);
  const B = Math.max(20, Math.min(90, Math.floor(W / 5))), on = new Array(B).fill(0), off = new Array(B).fill(0);
  for (const v of vals) { const b = Math.min(B - 1, Math.max(0, Math.floor((Math.log(Math.abs(v)) - L0) / (L1 - L0) * B))); (v > 0 ? on : off)[b]++; }
  const max = Math.max(1, ...on, ...off), mid = (H - 16) / 2, bw = W / B;
  const X = (us) => (Math.log(us) - L0) / (L1 - L0) * W;
  // base unit multiples
  x.strokeStyle = "rgba(255,210,74,.25)"; x.setLineDash([3, 3]); x.fillStyle = "rgba(255,210,74,.7)";
  x.font = "9px " + getComputedStyle(document.body).getPropertyValue("--mono");
  if (a.te) for (const m of [1, 2, 3, 4, 6, 8, 16, 30]) { const px = X(a.te * m); if (px < 2 || px > W - 2) continue; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H - 14); x.stroke(); x.fillText(m + "×", px + 2, 9); }
  x.setLineDash([]);
  for (let b = 0; b < B; b++) {
    if (on[b]) { x.fillStyle = C.on; const h = on[b] / max * (mid - 4); x.fillRect(b * bw + 1, mid - h, Math.max(1, bw - 2), h); }
    if (off[b]) { x.fillStyle = C.off; const h = off[b] / max * (mid - 4); x.fillRect(b * bw + 1, mid + 1, Math.max(1, bw - 2), h); }
  }
  x.fillStyle = C.text; x.fillText(fmtT(lo), 2, H - 3); x.textAlign = "right"; x.fillText(fmtT(hi), W - 2, H - 3); x.textAlign = "left";
}
SIG._analyze = analyze; SIG._decode = decode;   // for tests
})();
