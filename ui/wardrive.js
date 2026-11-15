/* Wardrive tab: wardriving logs on an offline OpenStreetMap map. Everything stays on this computer.
   Uses Leaflet + protomaps-leaflet (vector tiles from local .pmtiles files served by gui.py's MapServer). */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = (n) => Number(n || 0).toLocaleString("en-US");
const fmtB = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";

// network row: [id, lat, lon, kind, sec, band, channel, best_rssi, ssid, mac, maker, first, last, n, fdrive, drives[], has_handshake]
const I = { id: 0, lat: 1, lon: 2, kind: 3, sec: 4, band: 5, ch: 6, rssi: 7, ssid: 8, mac: 9, maker: 10, first: 11, last: 12, n: 13, fd: 14, dr: 15, hs: 16 };
const SEC = {
  open: { label: "Open", color: "#5fdd7a" }, wep: { label: "WEP", color: "#ff5a4f" }, wpa: { label: "WPA", color: "#ffc247" },
  wpa2: { label: "WPA2", color: "#ff8200" }, wpa3: { label: "WPA3", color: "#4fb3ff" }, ent: { label: "Enterprise", color: "#c38bff" },
  none: { label: "Not WiFi", color: "#9aa3ad" },
};
const KIND = { wifi: { label: "WiFi", color: "#ff8200" }, ble: { label: "Bluetooth LE", color: "#4fb3ff" },
  bt: { label: "Bluetooth", color: "#c38bff" }, cell: { label: "Cell", color: "#9aa3ad" } };
const BAND = { "2.4": "2.4 GHz", "5": "5 GHz", "6": "6 GHz" };

// points of interest: worked out from what's already in each row (name, security, maker)
const DEFAULT_RE = new RegExp("^(" + [
  "TP-?LINK[_-].*", "NETGEAR\\d{0,3}(-5G)?", "NETGEAR-.*", "Linksys\\d{0,5}(_5GHz)?", "dlink-?[0-9A-F]{4}.*", "D-Link_.*",
  "ASUS(_[0-9A-F]{2})?(_5G)?", "ASUS_RT-.*", "HUAWEI-[0-9A-Z]{4,}.*", "FRITZ!Box \\d{4}.*", "Vodafone-[0-9A-Z]{4,}", "o2-WLAN\\d{0,2}",
  "WLAN-[0-9A-F]{6}", "Speedport.*", "EasyBox-[0-9A-F]{6}", "SKY[0-9A-Z]{5}", "BTHub\\d?-[0-9A-Z]{4}", "BT-[0-9A-Z]{6}",
  "Livebox-[0-9A-F]{4}", "TALKTALK[0-9A-F]{6}", "VM[0-9]{7}", "Tenda_[0-9A-F]{6}", "Xiaomi_[0-9A-F]{4}.*", "MERCUSYS_.*",
  "ZTE[_-].*", "Orange-[0-9A-F]{4}", "MOVISTAR_[0-9A-F]{4}", "Ziggo[0-9]{7}", "UPC[0-9]{7}", "ARRIS-[0-9A-F]{4}",
  "TOTOLINK_.*", "MikroTik.*", "Belkin[._].*", "HOME-[0-9A-F]{4}", "ATT[0-9A-Za-z]{3}", "Alice-.*", "Wireless", "default", "dlink",
].join("|") + ")$", "i");
const IOT_RE = /^(DIRECT-|HP[- ]?Print|HP[- ]?(OfficeJet|ENVY|DeskJet|LaserJet)|EPSON|Canon_|Brother|ESP[_-]?[0-9A-F]{6}$|ESP32|ESP8266|shelly|tasmota|sonoff|Chromecast|Ring-|wyze|SmartLife|Tuya|Philips[- ]?hue|hue|YI_|Dyson|LG_Smart|\[LG\]|\[TV\]|AndroidTV|BRAVIA|Sonos|Nest|Arlo|EZVIZ|Hikvision|Dahua|roborock|Ecovacs|Meross|Govee|Kasa|Tapo_|Broadlink)|roku|ipcam|ip-cam|camera/i;
const HOTSPOT_RE = /iphone|^androidap|^android_?[0-9a-f]{4}$|galaxy|^pixel|redmi|^oneplus|^poco|^huawei (p|mate|nova)|^xperia|^moto|^oppo|^vivo|^realme|^honor|hotspot/i;
const POI = {
  open: { label: "Open WiFi", hint: "no password at all", test: (n) => n[I.kind] === "wifi" && n[I.sec] === "open" },
  weak: { label: "Weak security", hint: "WEP or old WPA", test: (n) => n[I.kind] === "wifi" && (n[I.sec] === "wep" || n[I.sec] === "wpa") },
  default: { label: "Default router names", hint: "name never changed, often the password neither", test: (n) => n[I.kind] === "wifi" && DEFAULT_RE.test(n[I.ssid] || "") },
  hidden: { label: "Hidden networks", hint: "WiFi that doesn't send its name", test: (n) => n[I.kind] === "wifi" && !n[I.ssid] },
  iot: { label: "Printers, cameras and smart home", hint: "from the device name", test: (n) => IOT_RE.test(n[I.ssid] || "") },
  hotspot: { label: "Phone hotspots", hint: "phone names or random addresses", test: (n) => n[I.kind] === "wifi" && (HOTSPOT_RE.test(n[I.ssid] || "") || n[I.maker] === "Random address") },
  shake: { label: "With a captured handshake", hint: "", test: (n) => !!n[I.hs] },
  mine: { label: "My devices", hint: "", test: (n) => WD.watchSet.has(n[I.mac]) },
};
function poiOf(n) {
  let s = WD.poiCache.get(n[I.id]);
  if (!s) { s = new Set(Object.keys(POI).filter((k) => POI[k].test(n))); WD.poiCache.set(n[I.id], s); }
  return s;
}
const CHG = {
  new: { label: "New", hint: "never seen on an earlier drive" },
  gone: { label: "Gone", hint: "seen before, you drove past, not there now" },
  moved: { label: "Moved", hint: "its likely spot shifted more than 200 m" },
  renamed: { label: "Renamed", hint: "same device, new name" },
  sec: { label: "Security changed", hint: "e.g. went from WPA2 to open" },
};
function sigColor(r) {
  if (r == null) return "#6a645e";
  const t = Math.max(0, Math.min(1, (r + 95) / 60));            // -95 dBm .. -35 dBm
  const h = 0 + t * 120;                                        // red -> green
  return `hsl(${h}, 85%, 55%)`;
}

const WD = {
  inited: false, api: null, fb: null,
  nets: [], tracks: {}, drives: [], dmap: {}, maps: [], home: null, prefs: {}, bounds: null, shakes: [], summary: null,
  watch: [], watchSet: new Set(), poiCache: new Map(), chgData: {}, chgPick: "",
  f: { q: "", kind: "all", sec: new Set(), band: new Set(), drive: "all", maker: "", cmp: null, chg: null, poi: "" },
  side: "overview", sel: null, list: { sort: "rssi", limit: 300 },
  map: null, L: {}, base: [], replay: null, settingHome: false, dl: null, cmpPick: { a: "", b: "" },
};
window.WD = WD;

/* ===================================================================== boot */
WD.init = function (api, fb) { WD.api = api; WD.fb = fb; };
WD.show = async function () {
  document.body.classList.add("wd-wide");
  if (!WD.inited) {
    WD.inited = true;
    bind();
    const r = await WD.api.wd_init();
    if (r.error) { WD.fb.toast(r.error); return; }
    WD.maps = r.maps || []; WD.home = r.home; WD.prefs = r.prefs || {};
    setWatch(r.watch || [], false);
    Object.assign(WD.prefs, { color: WD.prefs.color || "sec", mode: WD.prefs.mode || "dots", route: WD.prefs.route !== false });
    initMap();
    await reload(true);
  } else if (WD.map) {
    setTimeout(() => WD.map.invalidateSize(), 60);
  }
};
WD.hide = function () { document.body.classList.remove("wd-wide"); stopReplay(); };

async function reload(fit) {
  const d = await WD.api.wd_data();
  WD.nets = d.nets || []; WD.tracks = d.tracks || {}; WD.drives = (d.summary && d.summary.drives) || []; WD.bounds = d.bounds;
  WD.shakes = d.shakes || []; WD.summary = d.summary || null;
  WD.poiCache.clear(); WD.chgData = {};
  if (WD.f.chg && !WD.dmap[WD.f.chg.did]) WD.f.chg = null;
  if (WD.chgPick && !WD.dmap[WD.chgPick]) WD.chgPick = "";
  WD.dmap = Object.fromEntries(WD.drives.map((x) => [x.id, x]));
  if (WD.f.drive !== "all" && !WD.dmap[WD.f.drive]) WD.f.drive = "all";
  if (WD.f.cmp && (!WD.dmap[WD.f.cmp.a] || !WD.dmap[WD.f.cmp.b])) WD.f.cmp = null;
  if (WD.cmpPick.a && !WD.dmap[WD.cmpPick.a]) WD.cmpPick.a = "";
  if (WD.cmpPick.b && !WD.dmap[WD.cmpPick.b]) WD.cmpPick.b = "";
  if (WD.sel && !WD.nets.find((n) => n[I.id] === WD.sel.id)) WD.sel = null;
  $("#wdEmpty").hidden = WD.nets.length > 0 || WD.drives.length > 0;
  $("#wdCount").textContent = WD.nets.length ? fmtN(WD.nets.length) : "";
  renderFilters();
  draw();
  if (fit) fitAll();
}

/* ===================================================================== filtering */
function inHome(lat, lon) {
  const h = WD.home; if (!h || !h.on) return false;
  return dist(lat, lon, h.lat, h.lon) <= h.r;
}
function dist(a, b, c, d) {
  const R = 6371000, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = p2 - p1, dl = (d - b) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function filtered(ignore) {
  const f = WD.f, q = f.q.trim().toLowerCase(), hide = WD.home && WD.home.on && WD.home.hide;
  const out = [];
  for (const n of WD.nets) {
    if (f.kind !== "all" && ignore !== "kind" && n[I.kind] !== f.kind) continue;
    if (f.sec.size && ignore !== "sec" && !f.sec.has(n[I.sec])) continue;
    if (f.band.size && ignore !== "band" && !f.band.has(n[I.band])) continue;
    if (f.drive !== "all" && !n[I.dr].includes(+f.drive)) continue;
    if (f.maker && n[I.maker] !== f.maker) continue;
    if (f.cmp) {
      const a = n[I.dr].includes(+f.cmp.a), b = n[I.dr].includes(+f.cmp.b);
      if (f.cmp.mode === "a" ? !(a && !b) : f.cmp.mode === "b" ? !(b && !a) : !(a && b)) continue;
    }
    if (f.chg && !f.chg.ids.has(n[I.id])) continue;
    if (f.poi && ignore !== "poi" && !poiOf(n).has(f.poi)) continue;
    if (q && !((n[I.ssid] || "").toLowerCase().includes(q) || n[I.mac].toLowerCase().includes(q) || (n[I.maker] || "").toLowerCase().includes(q))) continue;
    if (hide && inHome(n[I.lat], n[I.lon])) continue;
    out.push(n);
  }
  return out;
}
function anyFilter() {
  const f = WD.f;
  return f.q || f.kind !== "all" || f.sec.size || f.band.size || f.drive !== "all" || f.maker || f.cmp || f.chg || f.poi;
}
function setWatch(list, save = true) {
  WD.watch = list; WD.watchSet = new Set(list.map((w) => w.mac)); WD.poiCache.clear();
  if (save) WD.api.wd_set("watch", list);
}
function realDrives() { return WD.drives.filter((d) => d.fmt !== "Packet capture"); }

/* ===================================================================== map */
function initMap() {
  const L = window.L;
  WD.map = L.map("wdMap", { preferCanvas: true, zoomControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 19, zoomSnap: 0.5 })
    .setView([25, 10], 2);
  L.control.zoom({ position: "bottomright" }).addTo(WD.map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(WD.map);
  WD.canvas = L.canvas({ padding: 0.4 });
  addBaseMaps();
  WD.map.on("click", (e) => {
    if (WD.settingHome) { setHome(e.latlng); return; }
  });
  WD.map.on("zoomend", () => { if (WD.prefs.mode === "dots" && !WD.replay && WD.L.dots) drawDots(); });
  new ResizeObserver(() => WD.map && WD.map.invalidateSize()).observe($("#wdMap"));
}
function addBaseMaps() {
  const L = window.L;
  WD.base.forEach((l) => WD.map.removeLayer(l)); WD.base = [];
  if (!window.protomapsL) return;
  const order = [...WD.maps].sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0));
  for (const m of order) {
    const opts = { url: m.url, flavor: "dark", lang: "en", maxDataZoom: m.maxzoom, maxZoom: 20 };
    if (!m.builtin) { const [w, s, e, n] = m.bounds; opts.bounds = L.latLngBounds([s, w], [n, e]); opts.minZoom = Math.max(0, m.minzoom); }
    const layer = window.protomapsL.leafletLayer(opts);
    layer.addTo(WD.map); WD.base.push(layer);
  }
}
function fitAll() {
  if (!WD.map) return;
  const b = WD.bounds;
  if (b && b[0] != null) WD.map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [30, 30], maxZoom: 16 });
}
function clearLayers(keep) {
  for (const k of Object.keys(WD.L)) {
    if (keep && keep.includes(k)) continue;
    if (WD.L[k]) WD.map.removeLayer(WD.L[k]);
    delete WD.L[k];
  }
}
function colorOf(n) {
  const c = WD.prefs.color;
  if (c === "sig") return sigColor(n[I.rssi]);
  if (c === "kind") return (KIND[n[I.kind]] || KIND.cell).color;
  return (SEC[n[I.sec]] || SEC.none).color;
}
function draw() {
  if (!WD.map) return;
  if (WD.replay) return;
  WD.F = filtered();
  clearLayers(["home"]);
  if (WD.prefs.route) drawRoutes();
  const mode = WD.prefs.mode;
  if (mode === "heat") drawHeat();
  else if (mode === "cluster") drawClusters();
  else drawDots();
  if (WD.f.chg && WD.f.chg.cat === "moved") drawMoves();
  drawHome();
  drawSel();
  renderLegend();
  renderSide();
  $("#wdShown").textContent = anyFilter() ? `${fmtN(WD.F.length)} of ${fmtN(WD.nets.length)} shown` : "";
}
function tip(n) {
  return `<b>${esc(n[I.ssid] || (n[I.kind] === "wifi" ? "(hidden network)" : "(no name)"))}</b><br><span class="mono">${esc(n[I.mac])}</span>` +
    `<br>${esc((SEC[n[I.sec]] || {}).label || "")}${n[I.rssi] != null ? " · " + n[I.rssi] + " dBm" : ""}${n[I.hs] ? `<br><span style="color:#ffd24a">◉ handshake captured</span>` : ""}`;
}
function drawDots() {
  const L = window.L;
  if (WD.L.dots) WD.map.removeLayer(WD.L.dots);
  const z = WD.map.getZoom(), r = z >= 17 ? 6 : z >= 15 ? 5 : z >= 13 ? 4 : 3;
  const g = L.layerGroup();
  for (const n of WD.F) {
    if (n[I.hs]) g.addLayer(L.circleMarker([n[I.lat], n[I.lon]], { renderer: WD.canvas, radius: r + 3, weight: 1.5,
      color: "#ffd24a", opacity: .95, fill: false, interactive: false }));
    const m = L.circleMarker([n[I.lat], n[I.lon]], { renderer: WD.canvas, radius: r, weight: 1, color: "#0b0b0b", opacity: .9,
      fillColor: colorOf(n), fillOpacity: .9 });
    m.on("click", (e) => { L.DomEvent.stopPropagation(e); select(n[I.id]); });
    m.bindTooltip(() => tip(n), { direction: "top", offset: [0, -4], className: "wd-tip" });
    g.addLayer(m);
  }
  WD.L.dots = g.addTo(WD.map);
}
function drawClusters() {
  const L = window.L;
  const g = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50, chunkedLoading: true,
    iconCreateFunction: (c) => {
      const k = c.getChildCount(), s = k < 10 ? 30 : k < 100 ? 36 : k < 1000 ? 42 : 50;
      return L.divIcon({ html: `<span>${k >= 1000 ? Math.round(k / 100) / 10 + "k" : k}</span>`, className: "wd-cluster", iconSize: [s, s] });
    } });
  for (const n of WD.F) {
    const m = L.circleMarker([n[I.lat], n[I.lon]], { radius: 5, weight: 1, color: "#0b0b0b", fillColor: colorOf(n), fillOpacity: .95 });
    m.on("click", () => select(n[I.id]));
    m.bindTooltip(() => tip(n), { direction: "top", className: "wd-tip" });
    g.addLayer(m);
  }
  WD.L.cluster = g.addTo(WD.map);
}
function drawHeat() {
  const pts = WD.F.map((n) => [n[I.lat], n[I.lon], n[I.rssi] == null ? .5 : Math.max(.15, Math.min(1, (n[I.rssi] + 100) / 60))]);
  WD.L.heat = window.L.heatLayer(pts, { radius: 22, blur: 18, minOpacity: .25, maxZoom: 17,
    gradient: { 0.2: "#2a1c10", 0.45: "#c35f00", 0.7: "#ff8200", 0.9: "#ffc247", 1: "#fff1c9" } }).addTo(WD.map);
}
function drawRoutes() {
  const L = window.L, ids = WD.f.cmp ? [WD.f.cmp.a, WD.f.cmp.b] : WD.f.drive !== "all" ? [WD.f.drive] : Object.keys(WD.tracks);
  const g = L.layerGroup();
  for (const id of ids) {
    const t = WD.tracks[id]; if (!t || t.length < 2) continue;
    const pts = (WD.home && WD.home.on && WD.home.hide) ? t.filter((p) => !inHome(p[0], p[1])) : t;
    for (const seg of splitGaps(pts)) {
      L.polyline(seg, { renderer: WD.canvas, color: "#ffa040", weight: 2.5, opacity: .55, interactive: false }).addTo(g);
    }
  }
  WD.L.route = g.addTo(WD.map);
}
function drawMoves() {         // old spot (hollow) -> new spot, for networks that moved between drives
  const L = window.L, c = WD.chgData[WD.f.chg.did]; if (!c || !c.moved) return;
  const g = L.layerGroup();
  for (const m of c.moved) {
    L.polyline([m.from, m.to], { color: "#ffd24a", weight: 2, opacity: .85, dashArray: "6 5", interactive: false }).addTo(g);
    L.circleMarker(m.from, { radius: 5, color: "#ffd24a", weight: 1.5, fill: false, interactive: false }).addTo(g);
    L.circleMarker(m.to, { radius: 3, color: "#ffd24a", weight: 0, fillColor: "#ffd24a", fillOpacity: 1, interactive: false }).addTo(g);
  }
  WD.L.moves = g.addTo(WD.map);
}
function splitGaps(pts) {     // don't draw a line across a GPS jump or between sessions
  const out = []; let cur = [];
  for (const p of pts) {
    if (cur.length && dist(cur[cur.length - 1][0], cur[cur.length - 1][1], p[0], p[1]) > 1500) { if (cur.length > 1) out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
function drawHome() {
  const L = window.L;
  if (WD.L.home) { WD.map.removeLayer(WD.L.home); delete WD.L.home; }
  const h = WD.home; if (!h || !h.on) return;
  WD.L.home = L.circle([h.lat, h.lon], { radius: h.r, color: "#ff5a4f", weight: 1.5, dashArray: "5 5", fillColor: "#ff5a4f",
    fillOpacity: h.hide ? .28 : .08, interactive: false }).addTo(WD.map);
}

/* ===================================================================== selection / detail */
async function select(id) {
  const d = await WD.api.wd_net(id);
  if (d.error) { WD.fb.toast(d.error); return; }
  WD.sel = d; WD.side = "net";
  drawSel(); renderSide(true);
}
function drawSel() {
  const L = window.L;
  if (WD.L.sel) { WD.map.removeLayer(WD.L.sel); delete WD.L.sel; }
  const d = WD.sel; if (!d || WD.side !== "net") return;
  const g = L.layerGroup();
  for (const s of d.sightings) {
    if (WD.home && WD.home.on && WD.home.hide && inHome(s[2], s[3])) continue;
    L.polyline([[s[2], s[3]], [d.lat, d.lon]], { color: sigColor(s[1]), weight: 1, opacity: .35, interactive: false }).addTo(g);
    L.circleMarker([s[2], s[3]], { radius: 4, weight: 0, fillColor: sigColor(s[1]), fillOpacity: .95 })
      .bindTooltip(`${esc(s[0])}<br>${s[1] == null ? "?" : s[1]} dBm`, { className: "wd-tip" }).addTo(g);
  }
  L.circleMarker([d.lat, d.lon], { radius: 11, weight: 3, color: "#fff", fill: false, interactive: false }).addTo(g);
  L.circleMarker([d.lat, d.lon], { radius: 5, weight: 0, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(g);
  WD.L.sel = g.addTo(WD.map);
}
function zoomToSel() {
  const d = WD.sel; if (!d) return;
  const pts = d.sightings.map((s) => [s[2], s[3]]).concat([[d.lat, d.lon]]);
  WD.map.fitBounds(pts, { padding: [60, 60], maxZoom: 18 });
}

/* ===================================================================== side panel */
function renderSide(scrollTop) {
  $$("#wdSeg button").forEach((b) => b.classList.toggle("on", b.dataset.side === WD.side));
  const box = $("#wdSide");
  const fn = { overview: sideOverview, list: sideList, drives: sideDrives, shakes: sideHandshakes, maps: sideMaps, privacy: sidePrivacy, net: sideNet }[WD.side];
  box.innerHTML = fn();
  WD.fb.renderIcons(box);
  bindSide(box);
  if (scrollTop) box.scrollTop = 0;
}
function bars(rows, { max, kind, click } = {}) {
  const m = max || Math.max(1, ...rows.map((r) => r.v));
  return `<div class="wd-bars">` + rows.map((r) => `<button class="wd-barrow${r.on ? " on" : ""}" ${click ? `data-${kind}="${esc(r.k)}"` : "disabled"}>` +
    `<span class="wd-bl">${r.dot ? `<i class="wd-dot" style="background:${r.dot}"></i>` : ""}${esc(r.label)}</span>` +
    `<span class="wd-bt"><span class="wd-bf" style="width:${Math.max(2, r.v / m * 100)}%;${r.dot ? `background:${r.dot}` : ""}"></span></span>` +
    `<span class="wd-bv">${fmtN(r.v)}</span></button>`).join("") + `</div>`;
}
function count(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (k == null || k === "") continue; m.set(k, (m.get(k) || 0) + 1); } return m; }
function sideOverview() {
  const F = WD.F || [];
  if (!WD.nets.length) return `<div class="wd-note">Import a wardrive log to see what's in it here.</div>`;
  const wifi = F.filter((n) => n[I.kind] === "wifi"), bt = F.filter((n) => n[I.kind] === "ble" || n[I.kind] === "bt");
  const open = wifi.filter((n) => n[I.sec] === "open").length;
  const drives = WD.f.cmp ? [WD.f.cmp.a, WD.f.cmp.b] : WD.f.drive !== "all" ? [WD.f.drive] : WD.drives.map((d) => d.id);
  const km = drives.reduce((a, id) => a + ((WD.dmap[id] || {}).km || 0), 0);
  const tiles = [["Networks", fmtN(F.length)], ["WiFi", fmtN(wifi.length)], ["Bluetooth", fmtN(bt.length)],
    ["Open WiFi", wifi.length ? Math.round(open / wifi.length * 100) + "%" : "-"], ["Drives", fmtN(drives.length)], ["Driven", km >= 10 ? Math.round(km) + " km" : km.toFixed(1) + " km"]];
  let h = `<div class="wd-tiles">${tiles.map(([k, v]) => `<div class="wd-tile"><b>${v}</b><span>${k}</span></div>`).join("")}</div>`;
  // points of interest, clickable as filters
  const pc = {};
  for (const n of filtered("poi")) for (const k of poiOf(n)) pc[k] = (pc[k] || 0) + 1;
  const prow = Object.keys(POI).filter((k) => pc[k] || WD.f.poi === k).map((k) => ({ k, label: POI[k].label, v: pc[k] || 0, on: WD.f.poi === k }));
  if (prow.length) h += `<div class="wd-h">Points of interest <small>click to filter</small></div>` + bars(prow, { kind: "poi", click: true });
  if (!WD.watch.length) h += `<div class="wd-note small">Tip: open your own router or phone and press <b>This is mine</b>. Your devices get their own filter and can be left out of exports and reports.</div>`;
  // security (WiFi only), with all security classes clickable as filters
  const secBase = filtered("sec").filter((n) => n[I.kind] === "wifi");
  const sc = count(secBase, (n) => n[I.sec]);
  h += `<div class="wd-h">WiFi security <small>click to filter</small></div>` + bars(["open", "wep", "wpa", "wpa2", "wpa3", "ent"].filter((k) => sc.get(k))
    .map((k) => ({ k, label: SEC[k].label, v: sc.get(k), dot: SEC[k].color, on: WD.f.sec.has(k) })), { kind: "sec", click: true });
  const bc = count(filtered("band").filter((n) => n[I.kind] === "wifi"), (n) => n[I.band]);
  if (bc.size) h += `<div class="wd-h">Bands</div>` + bars(["2.4", "5", "6"].filter((k) => bc.get(k)).map((k) => ({ k, label: BAND[k], v: bc.get(k), on: WD.f.band.has(k) })), { kind: "band", click: true });
  // channels
  const ch24 = count(wifi.filter((n) => n[I.band] === "2.4"), (n) => n[I.ch]);
  if (ch24.size) {
    const max = Math.max(...ch24.values());
    h += `<div class="wd-h">2.4 GHz channels <small>1, 6 and 11 don't overlap</small></div><div class="wd-chans">` +
      Array.from({ length: 13 }, (_, i) => i + 1).map((c) => `<div class="wd-ch${[1, 6, 11].includes(c) ? " main" : ""}" title="Channel ${c}: ${ch24.get(c) || 0}">` +
      `<div class="wd-chb"><span style="height:${(ch24.get(c) || 0) / max * 100}%"></span></div><em>${c}</em></div>`).join("") + `</div>`;
  }
  const ch5 = [...count(wifi.filter((n) => n[I.band] === "5"), (n) => n[I.ch])].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (ch5.length) h += `<div class="wd-h">Busiest 5 GHz channels</div>` + bars(ch5.map(([k, v]) => ({ k, label: "Channel " + k, v })));
  const mk = [...count(F, (n) => n[I.maker] || null)].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (mk.length) h += `<div class="wd-h">Device makers <small>from the MAC address</small></div>` +
    bars(mk.map(([k, v]) => ({ k, label: k, v, on: WD.f.maker === k })), { kind: "maker", click: true });
  const nm = [...count(wifi, (n) => n[I.ssid] || null)].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (nm.length) h += `<div class="wd-h">Most common WiFi names</div>` + bars(nm.map(([k, v]) => ({ k, label: k, v })), { kind: "name", click: true });
  if (WD.drives.length > 1 && !WD.f.cmp && WD.f.drive === "all") {
    const nw = count(F, (n) => n[I.fd]);
    h += `<div class="wd-h">New networks per drive <small>not seen on an earlier drive</small></div>` +
      bars(WD.drives.map((d) => ({ k: d.id, label: d.name, v: nw.get(d.id) || 0 })), { kind: "drive", click: true });
  }
  return h;
}
function sideList() {
  const F = [...(WD.F || [])];
  const s = WD.list.sort;
  const cmp = { rssi: (a, b) => (b[I.rssi] ?? -999) - (a[I.rssi] ?? -999), name: (a, b) => (a[I.ssid] || "~").localeCompare(b[I.ssid] || "~"),
    last: (a, b) => (b[I.last] || "").localeCompare(a[I.last] || ""), n: (a, b) => b[I.n] - a[I.n] }[s];
  F.sort(cmp);
  const rows = F.slice(0, WD.list.limit);
  return `<div class="wd-listhead"><span>${fmtN(F.length)} networks</span><select id="wdSort">` +
    [["rssi", "Strongest"], ["name", "Name"], ["last", "Last seen"], ["n", "Times seen"]].map(([k, l]) => `<option value="${k}"${k === s ? " selected" : ""}>${l}</option>`).join("") +
    `</select></div><div class="wd-list">` + rows.map((n) => `<button class="wd-row" data-net="${n[I.id]}"><i class="wd-dot" style="background:${colorOf(n)}"></i>` +
      `<span class="wd-rn"><b>${esc(n[I.ssid] || (n[I.kind] === "wifi" ? "(hidden network)" : (KIND[n[I.kind]] || {}).label || ""))}</b><small>${esc(n[I.mac])}${n[I.maker] ? " · " + esc(n[I.maker]) : ""}</small></span>` +
      `<span class="wd-rs">${n[I.rssi] == null ? "" : n[I.rssi] + " dBm"}<small>${esc((SEC[n[I.sec]] || {}).label || "")}</small></span></button>`).join("") +
    (F.length > rows.length ? `<button class="mini wd-more" id="wdMore">Show ${fmtN(Math.min(300, F.length - rows.length))} more</button>` : "") + `</div>`;
}
function msgDots(msgs) {
  const have = new Set(String(msgs || "").split(",").filter(Boolean).map(Number));
  return `<span class="wd-msgs" title="Handshake messages captured (M1-M4)">` +
    [1, 2, 3, 4].map((m) => `<i class="wd-msg${have.has(m) ? " on" : ""}">${m}</i>`).join("") + `</span>`;
}
function shakeName(h) { return h.ssid || "(hidden network)"; }
function shakeStat(x) { return x.complete ? "complete" : x.pmkid ? "PMKID" : "partial"; }
function pmkidTag(x) { return x.pmkid ? `<i class="wd-pmkid" title="A PMKID was captured in the first message">PMKID</i>` : ""; }
function sideHandshakes() {
  const sh = WD.shakes || [];
  if (!sh.length) return `<div class="wd-note">No handshakes imported yet.<br><br>Open a <b>.pcap</b> / <b>.pcapng</b> capture (from <b>Open files</b>, <b>From Flipper</b>, or by dropping it on the map) and each WPA handshake or PMKID inside it is filed here under the network it belongs to. Nothing is cracked or sent anywhere.</div>`;
  const complete = sh.filter((h) => h.complete).length, pmkid = sh.filter((h) => h.pmkid).length;
  const nets = new Set(sh.map((h) => h.bssid)).size;
  let h = `<div class="wd-tiles"><div class="wd-tile"><b>${fmtN(sh.length)}</b><span>Handshakes</span></div>` +
    `<div class="wd-tile"><b>${fmtN(complete)}</b><span>Complete</span></div>` +
    (pmkid ? `<div class="wd-tile"><b>${fmtN(pmkid)}</b><span>With PMKID</span></div>` : "") +
    `<div class="wd-tile"><b>${fmtN(nets)}</b><span>Networks</span></div></div>`;
  h += `<div class="wd-note small">A handshake is <b>complete</b> when the first two messages were both captured (that pairs the access point with a client); a <b>PMKID</b> can come from the first message alone. Click one to see its network, or save it as its own capture.</div>`;
  h += `<div class="wd-list">` + sh.map((x) => {
    const loc = x.lat != null;
    return `<div class="wd-shake${(x.complete || x.pmkid) ? " done" : ""}">` +
      `<button class="wd-shrow" ${loc ? `data-shnet="${x.net}"` : "disabled"}>` +
      `<span class="wd-rn"><b>${esc(shakeName(x))}</b><small class="mono">${esc(x.bssid)}</small>` +
      `<small>client ${esc(x.client)}${x.t ? " · " + esc(x.t) : ""}</small></span>` +
      `<span class="wd-shr">${pmkidTag(x)}${msgDots(x.msgs)}<small>${shakeStat(x)}${loc ? "" : " · not located"}</small></span></button>` +
      `<button class="mini wd-shexp" data-shexp="${x.id}" title="Save this handshake as its own .pcap"><i data-icon="download"></i></button></div>`;
  }).join("") + `</div>`;
  return h;
}
function sideNet() {
  const d = WD.sel; if (!d) return sideOverview();
  const dr = d.drives.map((id) => (WD.dmap[id] || {}).name || "?");
  const best = d.sightings.find((s) => s[1] === d.best_rssi);
  const row = (k, v) => v === "" || v == null ? "" : `<div class="wd-kv"><span>${k}</span><b>${v}</b></div>`;
  return `<button class="mini wd-back" id="wdBack"><i data-icon="back"></i>Back</button>` +
    `<div class="wd-netname">${esc(d.ssid || (d.kind === "wifi" ? "(hidden network)" : "(no name)"))}</div>` +
    `<div class="wd-chips">${d.kind === "wifi" ? `<span class="chip" style="color:${(SEC[d.sec] || SEC.none).color}">${esc((SEC[d.sec] || SEC.none).label)}</span>` : ""}` +
    `<span class="chip muted">${esc((KIND[d.kind] || {}).label || d.kind)}</span>${d.band ? `<span class="chip muted">${BAND[d.band]}</span>` : ""}` +
    (() => { const n = WD.nets.find((x) => x[I.id] === d.id); return n ? [...poiOf(n)].filter((k) => k !== "shake" && !(k === "open" || k === "weak"))
      .map((k) => `<span class="chip wd-poichip${k === "mine" ? " mine" : ""}">${esc(POI[k].label.replace(/s$/, "").replace("My device", "Mine"))}</span>`).join("") : ""; })() + `</div>` +
    `<div class="wd-kvs">` + row("MAC", `<span class="mono">${esc(d.mac)}</span>`) + row("Maker", esc(d.maker)) + row("Security", d.kind === "wifi" ? esc(d.auth) : "") +
    row("Channel", d.channel || "") + row("Frequency", d.freq ? d.freq + " MHz" : "") + row("First seen", esc(d.first)) + row("Last seen", esc(d.last)) +
    row("Seen", `${fmtN(d.n)} times on ${dr.length} drive${dr.length === 1 ? "" : "s"}`) +
    row("Strongest", d.best_rssi == null ? "" : `${d.best_rssi} dBm${best ? " at " + esc(best[0].slice(11)) : ""}`) +
    row("Likely spot", `<span class="mono">${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}</span>`) + `</div>` +
    `<div class="wd-note small">The likely spot is the signal-weighted middle of the strongest sightings. Lines on the map go from each sighting to it, colored by signal.</div>` +
    `<div class="wd-acts"><button class="mini" id="wdZoomSel"><i data-icon="search"></i>Zoom to it</button>` +
    `<button class="mini" id="wdCopyMac"><i data-icon="copy"></i>Copy MAC</button>` +
    `<button class="mini${WD.watchSet.has(d.mac) ? " on" : ""}" id="wdMine" title="Mark your own router, phone or gadgets: they get a filter and can be left out of exports">${WD.watchSet.has(d.mac) ? "Mine ✓" : "This is mine"}</button></div>` +
    `<div class="wd-h">Drives</div><div class="wd-note small">${dr.map(esc).join(", ")}</div>` +
    ((d.shakes && d.shakes.length) ? `<div class="wd-h">Captured handshakes <small>${d.shakes.length}</small></div>` +
      `<div class="wd-list">` + d.shakes.map((x) => `<div class="wd-shake${(x.complete || x.pmkid) ? " done" : ""}">` +
        `<span class="wd-rn"><b>${x.complete ? "Complete" : x.pmkid ? "PMKID" : "Partial"}</b><small>client ${esc(x.client)}${x.t ? " · " + esc(x.t) : ""}</small></span>` +
        `<span class="wd-shr">${pmkidTag(x)}${msgDots(x.msgs)}</span>` +
        `<button class="mini wd-shexp" data-shexp="${x.id}" title="Save this handshake as its own .pcap"><i data-icon="download"></i></button></div>`).join("") + `</div>` : "");
}
function sideDrives() {
  if (!WD.drives.length) return `<div class="wd-note">No drives yet. Import a log from your Flipper or this PC.</div>`;
  const opts = (sel) => `<option value="">Pick a drive</option>` + realDrives().map((d) => `<option value="${d.id}"${String(sel) === String(d.id) ? " selected" : ""}>${esc(d.name)}</option>`).join("");
  let cmp = "";
  if (realDrives().length > 1) {
    const { a, b } = WD.cmpPick;
    cmp = `<div class="wd-h">Compare two drives</div><div class="wd-cmp"><select id="wdCmpA">${opts(a)}</select><select id="wdCmpB">${opts(b)}</select></div>`;
    if (a && b && a !== b) {
      let oa = 0, ob = 0, both = 0;
      for (const n of WD.nets) { const x = n[I.dr].includes(+a), y = n[I.dr].includes(+b); if (x && y) both++; else if (x) oa++; else if (y) ob++; }
      const on = (m) => WD.f.cmp && WD.f.cmp.mode === m ? " on" : "";
      cmp += `<div class="wd-cmpres"><button class="wd-cmpb${on("a")}" data-cmp="a"><b>${fmtN(oa)}</b>only on the first</button>` +
        `<button class="wd-cmpb${on("both")}" data-cmp="both"><b>${fmtN(both)}</b>on both</button>` +
        `<button class="wd-cmpb${on("b")}" data-cmp="b"><b>${fmtN(ob)}</b>only on the second</button></div>` +
        (WD.f.cmp ? `<button class="mini" id="wdCmpOff">Stop comparing</button>` : `<div class="wd-note small">Click a number to show those networks on the map.</div>`);
    }
  }
  return chgBlock() + `<div class="wd-h">Drives</div><div class="wd-drives">` + [...WD.drives].reverse().map((d) => {
    const cap = d.fmt === "Packet capture";
    const when = d.t0 ? d.t0.slice(0, 16) + (d.t1 && d.t1.slice(0, 10) === d.t0.slice(0, 10) ? "–" + d.t1.slice(11, 16) : "") : cap ? "packet capture" : "no times in the log";
    return `<div class="wd-drive${String(WD.f.drive) === String(d.id) ? " on" : ""}"><div class="wd-dtop"><b>${esc(d.name)}</b>` +
      `<span>${esc(when)}</span></div><div class="wd-dstats">` +
      (cap ? `<span><b>${fmtN(d.sightings)}</b> handshakes</span><span><b>${fmtN(d.networks)}</b> networks</span>`
        : `<span><b>${fmtN(d.networks)}</b> networks</span><span><b>${fmtN(d.new)}</b> new</span><span><b>${d.km >= 10 ? Math.round(d.km) : (+d.km).toFixed(1)}</b> km</span>`) + `</div>` +
      `<div class="wd-dsrc">${esc([d.fmt, d.app, d.source].filter(Boolean).join(" · "))}</div><div class="wd-acts">` +
      (cap ? `<button class="mini" data-side-go="shakes">Show handshakes</button>` :
        `<button class="mini" data-dshow="${d.id}">${String(WD.f.drive) === String(d.id) ? "Show all" : "Show only"}</button>` +
        `<button class="mini" data-dplay="${d.id}"><i data-icon="play"></i>Replay</button>` +
        `<button class="mini" data-drep="${d.id}" title="A one-page summary with a map, to keep or share">Report</button>`) +
      `<button class="mini" data-dren="${d.id}"><i data-icon="edit"></i></button><button class="mini" data-ddel="${d.id}"><i data-icon="trash"></i></button></div></div>`;
  }).join("") + `</div>` + cmp +
    (realDrives().length > 1 ? `<div class="wd-acts wd-allrep"><button class="mini" data-drep="all">Report on all drives</button></div>` : "");
}
function chgPickId() { const r = realDrives(); return WD.chgPick && WD.dmap[WD.chgPick] ? String(WD.chgPick) : r.length ? String(r[r.length - 1].id) : ""; }
function chgBlock() {
  const drives = realDrives();
  if (drives.length < 2) return "";
  const pick = chgPickId();
  let h = `<div class="wd-h">What changed <small>a drive against every drive before it</small></div>` +
    `<select id="wdChgSel" class="wd-chgsel">` + [...drives].reverse().map((d) => `<option value="${d.id}"${String(d.id) === pick ? " selected" : ""}>${esc(d.name)}${d.t0 ? " · " + esc(d.t0.slice(0, 10)) : ""}</option>`).join("") + `</select>`;
  const c = WD.chgData[pick];
  if (!c) { loadChanges(pick); return h + `<div class="wd-note small"><span class="spin"></span>Comparing...</div>`; }
  if (c.error) return h + `<div class="wd-note small">${esc(c.error)}</div>`;
  if (c.first) return h + `<div class="wd-note small">This is the first drive, so there's nothing earlier to compare it with. Pick a later one.</div>`;
  const on = (k) => WD.f.chg && String(WD.f.chg.did) === pick && WD.f.chg.cat === k;
  h += `<div class="wd-chg">` + Object.entries(CHG).map(([k, v]) => `<button class="wd-chgrow${on(k) ? " on" : ""}" data-chg="${k}"${c[k].length ? "" : " disabled"}>` +
    `<b>${fmtN(c[k].length)}</b><span>${v.label}<small>${v.hint}</small></span></button>`).join("") + `</div>`;
  if (WD.f.chg && String(WD.f.chg.did) === pick) h += chgList(c, WD.f.chg.cat);
  else h += `<div class="wd-note small">Compared with ${c.vs} earlier drive${c.vs === 1 ? "" : "s"}. Click one to show those networks on the map.</div>`;
  return h;
}
function chgItems(c, cat) { return cat === "new" || cat === "gone" ? c[cat].map((id) => ({ id })) : c[cat]; }
function netName(n) { return n[I.ssid] || (n[I.kind] === "wifi" ? "(hidden network)" : (KIND[n[I.kind]] || {}).label || ""); }
function fmtM(m) { return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m"; }
function chgDetail(cat, x, n) {
  if (cat === "moved") return `moved ${fmtM(x.m)}`;
  if (cat === "renamed") return `was ${esc(x.from)}`;
  if (cat === "sec") return `${esc((SEC[x.from] || {}).label || x.from)} → ${esc((SEC[x.to] || {}).label || x.to)}`;
  return esc(n[I.mac]);
}
function chgList(c, cat) {
  const byId = new Map(WD.nets.map((n) => [n[I.id], n]));
  const items = chgItems(c, cat);
  const rows = items.slice(0, 60).map((x) => {
    const n = byId.get(x.id); if (!n) return "";
    return `<button class="wd-row" data-net="${x.id}"><i class="wd-dot" style="background:${colorOf(n)}"></i>` +
      `<span class="wd-rn"><b>${esc(netName(n))}</b><small>${chgDetail(cat, x, n)}</small></span><span class="wd-rs"></span></button>`;
  }).join("");
  return `<div class="wd-list">${rows}</div>` + (items.length > 60 ? `<div class="wd-note small">and ${fmtN(items.length - 60)} more on the map</div>` : "") +
    `<div class="wd-acts"><button class="mini" id="wdChgOff">Stop showing changes</button></div>`;
}
async function loadChanges(did) {
  if (WD.chgLoading === did) return;
  WD.chgLoading = did;
  const r = await WD.api.wd_changes(+did);
  WD.chgLoading = null; WD.chgData[did] = r || { error: "No answer" };
  if (WD.side === "drives") renderSide();
}
function fitIds(ids, moved) {
  const pts = WD.nets.filter((n) => ids.has(n[I.id])).map((n) => [n[I.lat], n[I.lon]]);
  if (moved) for (const m of moved) pts.push(m.from, m.to);
  if (pts.length) WD.map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
}
function sideMaps() {
  const dl = WD.dl;
  const maps = WD.maps.map((m) => `<div class="wd-map"><div><b>${esc(m.name)}</b><small>${fmtB(m.size)} · ${m.builtin ? "countries and big cities" : "streets up to zoom " + m.maxzoom}</small></div>` +
    `<div class="wd-acts">${m.builtin ? "" : `<button class="mini" data-mgo="${esc(m.id)}" title="Zoom to it"><i data-icon="search"></i></button><button class="mini" data-mdel="${esc(m.id)}" title="Delete"><i data-icon="trash"></i></button>`}</div></div>`).join("");
  const area = WD.prefs.area || (WD.bounds ? "logs" : "view");
  const prog = dl ? `<div class="wd-prog"><div class="wd-progtxt">${esc(dl.msg || "Starting")}${dl.total ? ` · ${fmtB(dl.done)} of ${fmtB(dl.total)}` : ""}</div>` +
    `<div class="wd-pbar"><span style="width:${dl.total ? dl.done / dl.total * 100 : 3}%"></span></div><button class="mini" id="wdDlCancel">Cancel</button></div>` : "";
  return `<div class="wd-maps">${maps}</div>` +
    `<div class="wd-h">Get street-level detail</div>` +
    `<div class="wd-note small">Downloads the OpenStreetMap streets, buildings and names for one area and keeps them on this computer, so the map works offline from then on. Only the map area is requested, never your logs.</div>` +
    (dl ? prog : `<div class="wd-form"><div class="seg sub wd-seg2" id="wdArea"><button data-area="logs"${WD.bounds ? "" : " disabled"} class="${area === "logs" ? "on" : ""}">Where my logs are</button>` +
      `<button data-area="view" class="${area === "view" ? "on" : ""}">What's on screen</button></div>` +
      `<label class="wd-lbl">Detail<select id="wdZoom"><option value="15">Streets and buildings</option><option value="13">Main roads</option><option value="11">Towns only</option></select></label>` +
      `<label class="wd-lbl">Name<input id="wdMapName" type="text" maxlength="40" placeholder="e.g. My town" spellcheck="false"></label>` +
      `<div class="wd-acts"><button class="mini primary" id="wdPlan">Check the size</button><button class="mini" id="wdMapImport"><i data-icon="folder"></i>Use a .pmtiles file</button></div>` +
      `<div id="wdPlanOut"></div></div>`);
}
function sidePrivacy() {
  const h = WD.home || { on: false, r: 300 };
  return `<div class="wd-h">Home zone</div>` +
    `<div class="wd-note small">Leaves out everything near a spot you choose (usually your home), so exports and screenshots don't show where you live.</div>` +
    `<label class="toggle"><input type="checkbox" id="wdHomeOn"${h.on ? " checked" : ""}><span class="switch"><span class="knob"></span></span><span class="toggle-text">Use a home zone<small>${h.lat != null ? "set" : "not set yet"}</small></span></label>` +
    `<div class="wd-acts"><button class="mini${WD.settingHome ? " primary" : ""}" id="wdHomeSet"><i data-icon="search"></i>${WD.settingHome ? "Click the map now" : h.lat != null ? "Move it" : "Set it on the map"}</button></div>` +
    `<label class="wd-lbl">Size <span id="wdHomeRv">${h.r || 300} m</span><input type="range" id="wdHomeR" min="100" max="3000" step="50" value="${h.r || 300}"></label>` +
    `<label class="toggle"><input type="checkbox" id="wdHomeHide"${h.hide ? " checked" : ""}><span class="switch"><span class="knob"></span></span><span class="toggle-text">Hide it on the map too<small>for screenshots and screen sharing</small></span></label>` +
    `<div class="wd-note small">Exports and reports always leave out the home zone while it's on.</div>` +
    `<div class="wd-h">My devices</div>` +
    (WD.watch.length ? `<div class="wd-list">` + WD.watch.map((w) => `<div class="wd-mine"><span class="wd-rn"><b>${esc(w.label)}</b><small class="mono">${esc(w.mac)}</small></span>` +
      `<button class="mini" data-unwatch="${esc(w.mac)}">Remove</button></div>`).join("") + `</div>`
      : `<div class="wd-note small">None yet. Open your own router, phone or gadget on the map and press <b>This is mine</b>.</div>`) +
    `<label class="toggle"><input type="checkbox" id="wdMineOut"${WD.prefs.mineOut ? " checked" : ""}><span class="switch"><span class="knob"></span></span><span class="toggle-text">Leave my devices out of exports and reports<small>they still show on your map</small></span></label>` +
    `<div class="wd-h">Your data</div><div class="wd-note small">Logs and maps are kept in a local database on this computer. Nothing is uploaded anywhere.</div>` +
    `<div class="wd-acts"><button class="mini" id="wdWipe"><i data-icon="trash"></i>Delete all wardrive data</button></div>`;
}

function bindSide(box) {
  $$("[data-sec]", box).forEach((b) => b.onclick = () => { toggleSet(WD.f.sec, b.dataset.sec); renderFilters(); draw(); });
  $$("[data-band]", box).forEach((b) => b.onclick = () => { toggleSet(WD.f.band, b.dataset.band); renderFilters(); draw(); });
  $$("[data-maker]", box).forEach((b) => b.onclick = () => { WD.f.maker = WD.f.maker === b.dataset.maker ? "" : b.dataset.maker; renderFilters(); draw(); });
  $$("[data-name]", box).forEach((b) => b.onclick = () => { WD.f.q = $("#wdSearch").value = b.dataset.name; renderFilters(); draw(); });
  $$("[data-drive]", box).forEach((b) => b.onclick = () => { WD.f.drive = b.dataset.drive; renderFilters(); draw(); });
  $$("[data-net]", box).forEach((b) => b.onclick = () => select(+b.dataset.net).then(zoomToSel));
  $$("[data-shnet]", box).forEach((b) => b.onclick = () => select(+b.dataset.shnet).then(zoomToSel));
  $$("[data-shexp]", box).forEach((b) => b.onclick = async (e) => {
    e.stopPropagation(); b.disabled = true;
    const r = await WD.api.wd_shake_export(+b.dataset.shexp); b.disabled = false;
    if (r && r.error) WD.fb.toast(r.error); else if (r && r.ok) WD.fb.toast("Saved " + r.path.split(/[\\/]/).pop());
  });
  const sort = $("#wdSort", box); if (sort) sort.onchange = () => { WD.list.sort = sort.value; WD.list.limit = 300; renderSide(); };
  const more = $("#wdMore", box); if (more) more.onclick = () => { WD.list.limit += 300; renderSide(); };
  const back = $("#wdBack", box); if (back) back.onclick = () => { WD.side = WD.lastSide || "overview"; WD.sel = null; drawSel(); renderSide(); };
  const z = $("#wdZoomSel", box); if (z) z.onclick = zoomToSel;
  const cm = $("#wdCopyMac", box); if (cm) cm.onclick = async () => { await WD.api.copy(WD.sel.mac); WD.fb.toast("MAC copied"); };
  // points of interest + my devices
  $$("[data-poi]", box).forEach((b) => b.onclick = () => { WD.f.poi = WD.f.poi === b.dataset.poi ? "" : b.dataset.poi; renderFilters(); draw(); });
  const mine = $("#wdMine", box);
  if (mine) mine.onclick = () => {
    const mac = WD.sel.mac;
    if (WD.watchSet.has(mac)) setWatch(WD.watch.filter((w) => w.mac !== mac));
    else { setWatch([...WD.watch, { mac, label: WD.sel.ssid || mac }]); WD.fb.toast("Marked as yours"); }
    draw();
  };
  $$("[data-unwatch]", box).forEach((b) => b.onclick = () => { setWatch(WD.watch.filter((w) => w.mac !== b.dataset.unwatch)); draw(); });
  const mo = $("#wdMineOut", box); if (mo) mo.onchange = () => { WD.prefs.mineOut = mo.checked; savePrefs(); };
  // what changed
  const cs = $("#wdChgSel", box); if (cs) cs.onchange = () => { WD.chgPick = cs.value; if (WD.f.chg && String(WD.f.chg.did) !== cs.value) { WD.f.chg = null; renderFilters(); draw(); } else renderSide(); };
  $$("[data-chg]", box).forEach((b) => b.onclick = () => {
    const pick = chgPickId(), c = WD.chgData[pick], cat = b.dataset.chg;
    if (!c) return;
    if (WD.f.chg && WD.f.chg.cat === cat && String(WD.f.chg.did) === pick) WD.f.chg = null;
    else { WD.f.chg = { did: +pick, cat, ids: new Set(chgItems(c, cat).map((x) => x.id)) }; WD.f.drive = "all"; WD.f.cmp = null; }
    renderFilters(); draw();
    if (WD.f.chg) fitIds(WD.f.chg.ids, cat === "moved" ? c.moved : null);
  });
  const chOff = $("#wdChgOff", box); if (chOff) chOff.onclick = () => { WD.f.chg = null; renderFilters(); draw(); };
  $$("[data-drep]", box).forEach((b) => b.onclick = () => makeReport(b.dataset.drep, b));
  $$("[data-side-go]", box).forEach((b) => b.onclick = () => { WD.side = b.dataset.sideGo; renderSide(true); });
  // drives
  $$("[data-dshow]", box).forEach((b) => b.onclick = () => { WD.f.drive = String(WD.f.drive) === b.dataset.dshow ? "all" : b.dataset.dshow; WD.f.cmp = null; renderFilters(); draw(); zoomDrive(WD.f.drive); });
  $$("[data-dplay]", box).forEach((b) => b.onclick = () => startReplay(+b.dataset.dplay));
  $$("[data-dren]", box).forEach((b) => b.onclick = () => renameDrive(+b.dataset.dren));
  $$("[data-ddel]", box).forEach((b) => b.onclick = () => deleteDrive(+b.dataset.ddel));
  const ca = $("#wdCmpA", box), cb = $("#wdCmpB", box);
  if (ca) ca.onchange = cb.onchange = () => { WD.cmpPick = { a: ca.value, b: cb.value }; WD.f.cmp = null; renderFilters(); draw(); };
  $$("[data-cmp]", box).forEach((b) => b.onclick = () => { WD.f.cmp = { ...WD.cmpPick, mode: b.dataset.cmp }; WD.f.drive = "all"; renderFilters(); draw(); });
  const co = $("#wdCmpOff", box); if (co) co.onclick = () => { WD.f.cmp = null; renderFilters(); draw(); };
  // maps
  $$("[data-area]", box).forEach((b) => b.onclick = () => { WD.prefs.area = b.dataset.area; savePrefs(); renderSide(); });
  const plan = $("#wdPlan", box); if (plan) plan.onclick = planMap;
  const mi = $("#wdMapImport", box); if (mi) mi.onclick = importMap;
  const dc = $("#wdDlCancel", box); if (dc) dc.onclick = () => WD.api.wd_map_cancel();
  $$("[data-mdel]", box).forEach((b) => b.onclick = () => deleteMap(b.dataset.mdel));
  $$("[data-mgo]", box).forEach((b) => b.onclick = () => { const m = WD.maps.find((x) => x.id === b.dataset.mgo); if (m) WD.map.fitBounds([[m.bounds[1], m.bounds[0]], [m.bounds[3], m.bounds[2]]]); });
  // privacy
  const ho = $("#wdHomeOn", box);
  if (ho) {
    ho.onchange = () => { if (ho.checked && (!WD.home || WD.home.lat == null)) { WD.settingHome = true; WD.fb.toast("Click the map where your home is"); renderSide(); setHomeHint(); return; } saveHome({ on: ho.checked }); };
    $("#wdHomeSet", box).onclick = () => { WD.settingHome = !WD.settingHome; setHomeHint(); renderSide(); };
    const r = $("#wdHomeR", box);
    r.oninput = () => { $("#wdHomeRv").textContent = r.value + " m"; if (WD.home) { WD.home.r = +r.value; drawHome(); } };
    r.onchange = () => saveHome({ r: +r.value });
    $("#wdHomeHide", box).onchange = (e) => saveHome({ hide: e.target.checked });
    $("#wdWipe", box).onclick = wipeAll;
  }
}
function toggleSet(s, k) { s.has(k) ? s.delete(k) : s.add(k); }
function zoomDrive(id) {
  const t = WD.tracks[id]; if (!t || !t.length) { fitAll(); return; }
  WD.map.fitBounds(t, { padding: [40, 40], maxZoom: 17 });
}

/* ===================================================================== filter bar + legend */
function renderFilters() {
  const f = WD.f, box = $("#wdFilters");
  const kinds = [["all", "All"], ["wifi", "WiFi"], ["ble", "Bluetooth LE"], ["bt", "Bluetooth"], ["cell", "Cell"]]
    .filter(([k]) => k === "all" || WD.nets.some((n) => n[I.kind] === k));
  let h = `<div class="wd-kinds">` + kinds.map(([k, l]) => `<button class="wd-fchip${f.kind === k ? " on" : ""}" data-fkind="${k}">${l}</button>`).join("") + `</div>`;
  h += `<select id="wdDriveSel"><option value="all">All drives</option>` + WD.drives.map((d) => `<option value="${d.id}"${String(f.drive) === String(d.id) ? " selected" : ""}>${esc(d.name)}</option>`).join("") + `</select>`;
  const act = [];
  for (const k of f.sec) act.push([`sec:${k}`, SEC[k].label]);
  for (const k of f.band) act.push([`band:${k}`, BAND[k]]);
  if (f.maker) act.push(["maker", f.maker]);
  if (f.cmp) act.push(["cmp", { a: "Only on the first drive", b: "Only on the second drive", both: "On both drives" }[f.cmp.mode]]);
  if (f.chg) act.push(["chg", `${CHG[f.chg.cat].label} on ${(WD.dmap[f.chg.did] || {}).name || "drive"}`]);
  if (f.poi) act.push(["poi", POI[f.poi].label]);
  h += act.map(([k, l]) => `<button class="wd-fchip on x" data-fx="${esc(k)}">${esc(l)}<i data-icon="cross"></i></button>`).join("");
  if (anyFilter()) h += `<button class="wd-clear" id="wdClear">Clear filters</button>`;
  h += `<span class="wd-shown" id="wdShown"></span>`;
  box.innerHTML = h;
  WD.fb.renderIcons(box);
  $$("[data-fkind]", box).forEach((b) => b.onclick = () => { f.kind = b.dataset.fkind; renderFilters(); draw(); });
  $("#wdDriveSel").onchange = (e) => { f.drive = e.target.value; f.cmp = null; renderFilters(); draw(); zoomDrive(f.drive); };
  $$("[data-fx]", box).forEach((b) => b.onclick = () => {
    const [t, k] = b.dataset.fx.split(":");
    if (t === "sec") f.sec.delete(k); else if (t === "band") f.band.delete(k); else if (t === "maker") f.maker = ""; else if (t === "cmp") f.cmp = null;
    else if (t === "chg") f.chg = null; else if (t === "poi") f.poi = "";
    renderFilters(); draw();
  });
  const c = $("#wdClear"); if (c) c.onclick = () => { Object.assign(f, { q: "", kind: "all", drive: "all", maker: "", cmp: null, chg: null, poi: "" }); f.sec.clear(); f.band.clear(); $("#wdSearch").value = ""; renderFilters(); draw(); };
}
function renderLegend() {
  const c = WD.prefs.color, box = $("#wdLegend");
  $$("#wdLayers [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === WD.prefs.mode));
  $$("#wdLayers [data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
  $("#wdRouteBtn").classList.toggle("on", WD.prefs.route);
  $("#wdLayers [data-color]").parentElement.classList.toggle("off", WD.prefs.mode === "heat");
  if (WD.prefs.mode === "heat") { box.innerHTML = `<span class="wd-heatkey"></span><span>fewer</span><span>more networks</span>`; return; }
  let items;
  if (c === "sig") items = [[-40, "strong"], [-65, ""], [-90, "weak"]].map(([r, l]) => [sigColor(r), l || r + " dBm"]);
  else if (c === "kind") items = Object.entries(KIND).filter(([k]) => WD.nets.some((n) => n[I.kind] === k)).map(([, v]) => [v.color, v.label]);
  else items = Object.entries(SEC).filter(([k]) => (WD.F || []).some((n) => n[I.sec] === k)).map(([, v]) => [v.color, v.label]);
  box.innerHTML = items.map(([col, l]) => `<span><i class="wd-dot" style="background:${col}"></i>${esc(l)}</span>`).join("");
}
function savePrefs() { WD.api.wd_set("prefs", { color: WD.prefs.color, mode: WD.prefs.mode, route: WD.prefs.route, area: WD.prefs.area, mineOut: !!WD.prefs.mineOut }); }

/* ===================================================================== importing */
async function importFromPc() {
  const r = await WD.api.wd_pick_import();
  if (r.cancelled) return;
  await afterImport(r);
}
async function importDropped(files) {
  for (const f of files) {
    if (f.size > 300 * 1024 * 1024) { WD.fb.toast(`${f.name} is over 300 MB`); continue; }
    const b64 = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(",")[1] || ""); rd.readAsDataURL(f); });
    await afterImport(await WD.api.wd_import_data(f.name, b64), true);
  }
}
WD.drop = importDropped;
async function afterImport(r, quiet) {
  if (r.error) { WD.fb.toast(r.error); return; }
  const res = r.results || [];
  const ok = res.filter((x) => x.ok), dup = res.filter((x) => x.duplicate), bad = res.filter((x) => x.error);
  await reload(ok.length > 0 && WD.drives.length === ok.length);
  if (ok.length) {
    const caps = ok.filter((x) => x.capture), logs = ok.filter((x) => !x.capture), parts = [];
    if (logs.length) { const nets = logs.reduce((a, x) => a + x.networks, 0), nw = logs.reduce((a, x) => a + x.new, 0); parts.push(`${fmtN(nets)} networks, ${fmtN(nw)} new`); }
    if (caps.length) { const hs = caps.reduce((a, x) => a + (x.handshakes || 0), 0), cp = caps.reduce((a, x) => a + (x.complete || 0), 0), pk = caps.reduce((a, x) => a + (x.pmkid || 0), 0); parts.push(`${fmtN(hs)} handshake${hs === 1 ? "" : "s"} (${fmtN(cp)} complete${pk ? `, ${fmtN(pk)} PMKID` : ""})`); }
    WD.fb.toast(`Imported ${ok.length} file${ok.length === 1 ? "" : "s"}: ${parts.join(" · ")}`);
    if (logs.length === 1 && !caps.length) { WD.f.drive = String(logs[0].id); renderFilters(); draw(); zoomDrive(logs[0].id); }
    else if (caps.length && !logs.length) WD.side = "shakes";
    renderSide(true);
  }
  if (bad.length || (dup.length && !ok.length)) {
    const lines = bad.map((x) => `<li><b>${esc(x.file)}</b>: ${esc(x.error)}</li>`).concat(dup.map((x) => `<li><b>${esc(x.file)}</b>: already imported as "${esc(x.name)}"</li>`));
    await WD.fb.confirmDialog(ok.length ? "Some files were skipped" : "Nothing imported", `<ul class="wd-ul">${lines.join("")}</ul>`, "OK");
  } else if (dup.length && !quiet) WD.fb.toast(`${dup.length} already imported, skipped`);
}
async function importFromFlipper() {
  if (!WD.fb.needDevice()) return;
  const btn = $("#wdFromFlipper"); btn.disabled = true; const old = btn.innerHTML;
  btn.innerHTML = `<span class="spin"></span>Looking...`;
  const r = await WD.api.wd_flipper_scan();
  btn.disabled = false; btn.innerHTML = old; WD.fb.renderIcons(btn);
  if (r.error) { WD.fb.toast(r.error); return; }
  const files = r.files || [];
  const m = $("#wdPick");
  $("#wdPickSub").textContent = files.length ? `${files.length} found in apps_data and wardrive/GPS folders. Copying them doesn't change anything on your Flipper.` : "";
  $("#wdPickList").innerHTML = files.length ? files.map((f, i) => `<button class="bk-item on" data-i="${i}"><span class="box"><i data-icon="check"></i></span>` +
    `<span class="wd-pf">${esc(f.path.replace(/^\/ext\//, ""))}</span><small>${fmtB(f.size)}</small></button>`).join("") :
    `<div class="wd-note">No wardrive logs found on the SD card. Apps like Marauder save them in <code>apps_data/marauder/logs</code> (files named <code>wardrive_...</code>). You can also copy logs to this PC and use <b>Open files</b>.</div>`;
  WD.fb.renderIcons($("#wdPickList"));
  $$("#wdPickList .bk-item").forEach((b) => b.onclick = () => { b.classList.toggle("on"); pickCount(); });
  const pickCount = () => { const n = $$("#wdPickList .bk-item.on").length; $("#wdPickGo").textContent = n ? `Import ${n}` : "Import"; $("#wdPickGo").disabled = !n; };
  pickCount();
  m.hidden = false;
  const done = () => { m.hidden = true; };
  $("#wdPickCancel").onclick = done;
  $("#wdPickGo").onclick = async () => {
    const sel = $$("#wdPickList .bk-item.on").map((b) => files[+b.dataset.i]);
    $("#wdPickGo").disabled = true; $("#wdPickGo").textContent = "Copying...";
    const res = await WD.api.wd_flipper_import(sel);
    done();
    await afterImport(res);
  };
}

/* ===================================================================== drives: rename / delete */
async function renameDrive(id) {
  const d = WD.dmap[id]; if (!d) return;
  const name = await WD.fb.promptDialog("Rename drive", d.name, "Rename");
  if (name == null || !name.trim()) return;
  await WD.api.wd_rename(id, name.trim());
  await reload();
}
async function deleteDrive(id) {
  const d = WD.dmap[id]; if (!d) return;
  if (!await WD.fb.confirmDialog("Delete this drive?", `<b>${esc(d.name)}</b> and its ${fmtN(d.sightings)} sightings will be removed from Workbench. Networks seen only on this drive go too. The original log file isn't touched.`, "Delete")) return;
  await WD.api.wd_delete(id);
  if (String(WD.f.drive) === String(id)) WD.f.drive = "all";
  await reload();
  WD.fb.toast("Drive deleted");
}
async function wipeAll() {
  if (!await WD.fb.confirmDialog("Delete all wardrive data?", "Every imported drive and network is removed from Workbench. Downloaded maps are kept. Your original log files aren't touched.", "Delete all")) return;
  await WD.api.wd_wipe();
  await reload();
}

/* ===================================================================== export */
async function exportAs(fmt) {
  $("#wdExportMenu").hidden = true;
  if (fmt === "report") { makeReport(WD.f.drive); return; }
  const rows = WD.F || [];
  const keep = WD.prefs.mineOut ? rows.filter((n) => !WD.watchSet.has(n[I.mac])) : rows;
  const ids = keep.map((n) => n[I.id]);
  if (!ids.length) { WD.fb.toast(rows.length ? "Nothing to export: everything shown is one of your devices." : "Nothing to export"); return; }
  const r = await WD.api.wd_export(fmt, ids);
  if (r.cancelled) return;
  if (r.error) { WD.fb.toast(r.error); return; }
  const out = [];
  if (r.hidden) out.push(`${fmtN(r.hidden)} in your home zone`);
  if (rows.length > keep.length) out.push(`${fmtN(rows.length - keep.length)} of your devices`);
  WD.fb.toast(`Saved ${fmtN(r.count)} networks${out.length ? ", " + out.join(" and ") + " left out" : ""}`);
}

/* ===================================================================== drive report (one self-contained HTML page) */
async function makeReport(did, btn) {
  did = did && did !== "all" ? String(did) : "all";
  const d = did === "all" ? null : WD.dmap[did];
  if (btn) btn.disabled = true;
  WD.fb.toast("Making the report...");
  try {
    let nets = WD.nets.filter((n) => !d || n[I.dr].includes(+did));
    const home = WD.home && WD.home.on && WD.home.lat != null;
    const inZone = home ? nets.filter((n) => inHome(n[I.lat], n[I.lon])).length : 0;
    if (home) nets = nets.filter((n) => !inHome(n[I.lat], n[I.lon]));
    const mineOut = WD.prefs.mineOut ? nets.filter((n) => WD.watchSet.has(n[I.mac])).length : 0;
    if (WD.prefs.mineOut) nets = nets.filter((n) => !WD.watchSet.has(n[I.mac]));
    let chg = null;
    if (d) chg = WD.chgData[did] || (WD.chgData[did] = await WD.api.wd_changes(+did));
    const img = await snapshotMap(did, nets);
    const html = reportHtml({ d, did, nets, chg, img, inZone, mineOut });
    const r = await WD.api.wd_report_save(html, d ? d.name : "All drives");
    if (r.error) WD.fb.toast(r.error); else if (r.ok) WD.fb.toast("Report saved and opened in your browser");
  } catch (e) {
    WD.fb.toast("Couldn't make the report: " + (e && e.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function snapshotMap(did, nets) {
  // draws the drive on a hidden copy of the map (your view isn't touched), then flattens its canvases into one PNG
  const L = window.L;
  if (!L || !window.protomapsL) return null;
  const W = 1100, H = 620, dpr = Math.min(2, window.devicePixelRatio || 1);
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:-${W + 4000}px;top:0;width:${W}px;height:${H}px;background:#0d0d0d`;
  document.body.appendChild(box);
  let m = null;
  try {
    m = L.map(box, { preferCanvas: true, zoomControl: false, attributionControl: false, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
    const layers = [];
    for (const mp of [...WD.maps].sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0))) {
      const opts = { url: mp.url, flavor: "dark", lang: "en", maxDataZoom: mp.maxzoom, maxZoom: 20 };
      if (!mp.builtin) { const [w, s, e, n] = mp.bounds; opts.bounds = L.latLngBounds([s, w], [n, e]); opts.minZoom = Math.max(0, mp.minzoom); }
      const l = window.protomapsL.leafletLayer(opts); l.addTo(m); layers.push(l);
    }
    const routes = did === "all" ? Object.values(WD.tracks) : [WD.tracks[did] || []];
    const home = WD.home && WD.home.on && WD.home.lat != null;
    const segs = [];
    for (const t of routes) for (const seg of splitGaps(home ? t.filter((p) => !inHome(p[0], p[1])) : t)) segs.push(seg);
    const pts = segs.flat().concat(nets.map((n) => [n[I.lat], n[I.lon]]));
    if (!pts.length) return null;
    m.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 17, animate: false });
    await Promise.race([Promise.all(layers.map((l) => new Promise((res) => l.once("load", res)))), new Promise((res) => setTimeout(res, 7000))]);
    await new Promise((res) => setTimeout(res, 400));
    const out = document.createElement("canvas"); out.width = W * dpr; out.height = H * dpr;
    const ctx = out.getContext("2d"); ctx.scale(dpr, dpr); ctx.fillStyle = "#0d0d0d"; ctx.fillRect(0, 0, W, H);
    const r0 = box.getBoundingClientRect();
    for (const c of box.querySelectorAll(".leaflet-tile-pane canvas")) {
      const r = c.getBoundingClientRect();
      if (r.width && r.height) ctx.drawImage(c, r.left - r0.left, r.top - r0.top, r.width, r.height);
    }
    // route and networks are drawn here directly (not through Leaflet's deferred renderer), so they're always in the picture
    const xy = (p) => m.latLngToContainerPoint(p);
    ctx.lineJoin = ctx.lineCap = "round"; ctx.strokeStyle = "rgba(255,160,64,.6)"; ctx.lineWidth = 2.5;
    for (const seg of segs) {
      ctx.beginPath();
      seg.forEach((p, i) => { const q = xy(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.strokeStyle = "#0b0b0b";
    for (const n of nets) {
      const q = xy([n[I.lat], n[I.lon]]);
      ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = colorOf(n); ctx.fill(); ctx.stroke();
    }
    return out.toDataURL("image/png");
  } catch (e) {
    return null;
  } finally {
    if (m) m.remove();
    box.remove();
  }
}
function reportHtml({ d, did, nets, chg, img, inZone, mineOut }) {
  const wifi = nets.filter((n) => n[I.kind] === "wifi"), bt = nets.filter((n) => n[I.kind] === "ble" || n[I.kind] === "bt");
  const open = wifi.filter((n) => n[I.sec] === "open").length;
  const drives = d ? [d] : realDrives();
  const km = drives.reduce((a, x) => a + (x.km || 0), 0);
  const t0 = drives.map((x) => x.t0).filter(Boolean).sort()[0] || "", t1 = drives.map((x) => x.t1).filter(Boolean).sort().pop() || "";
  const ids = new Set(nets.map((n) => n[I.id]));
  const shakes = (WD.shakes || []).filter((s) => ids.has(s.net));
  const fresh = d ? nets.filter((n) => n[I.fd] === +did).length : null;
  const bar = (rows, colorFn) => { const mx = Math.max(1, ...rows.map((r) => r[1])); return `<div class="bars">` + rows.map(([l, v, c]) =>
    `<div class="br"><span class="bl">${esc(l)}</span><span class="bt"><span style="width:${Math.max(2, v / mx * 100)}%;background:${c || colorFn || "#ff8200"}"></span></span><span class="bv">${fmtN(v)}</span></div>`).join("") + `</div>`; };
  const cnt = (arr, fn) => [...count(arr, fn)].sort((a, b) => b[1] - a[1]);
  const sec = ["open", "wep", "wpa", "wpa2", "wpa3", "ent"].map((k) => [SEC[k].label, wifi.filter((n) => n[I.sec] === k).length, SEC[k].color]).filter((r) => r[1]);
  const bands = ["2.4", "5", "6"].map((k) => [BAND[k], wifi.filter((n) => n[I.band] === k).length]).filter((r) => r[1]);
  const ch = count(wifi.filter((n) => n[I.band] === "2.4"), (n) => n[I.ch]);
  const chMax = Math.max(1, ...ch.values());
  const chans = ch.size ? `<div class="chans">` + Array.from({ length: 13 }, (_, i) => i + 1).map((c) => `<div class="ch${[1, 6, 11].includes(c) ? " main" : ""}"><div class="chb"><span style="height:${(ch.get(c) || 0) / chMax * 100}%"></span></div><em>${c}</em><small>${ch.get(c) || ""}</small></div>`).join("") + `</div>` : "";
  const makers = cnt(nets, (n) => n[I.maker] || null).slice(0, 8);
  const poi = {}; for (const n of nets) for (const k of poiOf(n)) if (k !== "mine") poi[k] = (poi[k] || 0) + 1;
  const poiRows = Object.keys(POI).filter((k) => poi[k]).map((k) => [POI[k].label, poi[k]]);
  const notable = nets.filter((n) => { const p = poiOf(n); return p.has("open") || p.has("weak") || p.has("default"); })
    .sort((a, b) => (b[I.rssi] ?? -999) - (a[I.rssi] ?? -999)).slice(0, 40);
  const tiles = [["Networks", fmtN(nets.length)], ["WiFi", fmtN(wifi.length)], ["Bluetooth", fmtN(bt.length)],
    ["Open WiFi", wifi.length ? Math.round(open / wifi.length * 100) + "%" : "-"], d ? ["New on this drive", fmtN(fresh)] : ["Drives", fmtN(drives.length)],
    ["Distance", km >= 10 ? Math.round(km) + " km" : km.toFixed(1) + " km"]];
  if (shakes.length) tiles.push(["Handshakes", fmtN(shakes.length)]);
  let chgHtml = "";
  if (chg && !chg.first && !chg.error) {
    // "gone" networks weren't on this drive, so filter against every network with the same privacy rules
    const byId = new Map(WD.nets.map((n) => [n[I.id], n]));
    const homeOn = WD.home && WD.home.on && WD.home.lat != null;
    const okNet = (n) => n && !(homeOn && inHome(n[I.lat], n[I.lon])) && !(WD.prefs.mineOut && WD.watchSet.has(n[I.mac]));
    const items = Object.fromEntries(Object.keys(CHG).map((k) => [k, chgItems(chg, k).filter((x) => okNet(byId.get(x.id)))]));
    chgHtml = `<h2>What changed <small>compared with ${chg.vs} earlier drive${chg.vs === 1 ? "" : "s"}</small></h2><div class="tiles">` +
      Object.entries(CHG).map(([k, v]) => `<div class="tile"><b>${fmtN(items[k].length)}</b><span>${v.label}</span></div>`).join("") + `</div>` +
      Object.keys(CHG).filter((k) => k !== "new" && items[k].length).map((k) => `<h3>${CHG[k].label}</h3><table><tr><th>Name</th><th>MAC</th><th>Change</th></tr>` +
        items[k].slice(0, 15).map((x) => { const n = byId.get(x.id); return `<tr><td>${esc(netName(n))}</td><td class="mono">${esc(n[I.mac])}</td><td>${
          k === "moved" ? "moved " + fmtM(x.m) : k === "renamed" ? `${esc(x.from)} → ${esc(x.to)}` : k === "sec" ? `${esc((SEC[x.from] || {}).label || x.from)} → ${esc((SEC[x.to] || {}).label || x.to)}` : "not heard this time"}</td></tr>`; }).join("") +
        (items[k].length > 15 ? `<tr><td colspan="3" class="muted">and ${fmtN(items[k].length - 15)} more</td></tr>` : "") + `</table>`).join("");
  }
  const left = [inZone ? `${fmtN(inZone)} in your home zone` : "", mineOut ? `${fmtN(mineOut)} of your own devices` : ""].filter(Boolean);
  const title = d ? d.name : "All drives";
  const when = t0 ? (t1 && t1.slice(0, 10) !== t0.slice(0, 10) ? `${t0.slice(0, 16)} to ${t1.slice(0, 16)}` : `${t0.slice(0, 16)}${t1 ? "–" + t1.slice(11, 16) : ""}`) : "";
  const css = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0d0d0d;color:#ece6df;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 18px 40px}h1{font-size:26px;margin:0 0 2px;color:#fff}h2{font-size:17px;margin:28px 0 10px;color:#ff8200}h2 small,h1 small{font-size:12px;color:#9a928a;font-weight:400;margin-left:6px}
h3{font-size:14px;margin:16px 0 6px;color:#ece6df}.sub{color:#9a928a;margin:0 0 18px}.map{width:100%;border-radius:12px;border:1px solid #2a2622;display:block}.attr{font-size:11px;color:#7a736c;margin:4px 0 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}.tile{background:#161412;border:1px solid #2a2622;border-radius:10px;padding:10px 12px}.tile b{display:block;font:700 20px ui-monospace,Consolas,monospace;color:#fff}.tile span{font-size:12px;color:#9a928a}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:4px 28px}.bars{display:flex;flex-direction:column;gap:5px}.br{display:grid;grid-template-columns:150px 1fr 56px;gap:8px;align-items:center;font-size:13px}
.bl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bt{height:9px;background:#1f1c19;border-radius:5px;overflow:hidden}.bt span{display:block;height:100%;border-radius:5px}.bv{text-align:right;font-family:ui-monospace,Consolas,monospace;color:#c9c1b8}
.chans{display:flex;gap:4px;align-items:flex-end}.ch{flex:1;text-align:center}.chb{height:70px;background:#1f1c19;border-radius:4px;display:flex;align-items:flex-end;overflow:hidden}.chb span{display:block;width:100%;background:#7a5a3a}.ch.main .chb span{background:#ff8200}.ch em{font-style:normal;font-size:11px;color:#9a928a;display:block}.ch small{font-size:10px;color:#7a736c;display:block;min-height:14px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#9a928a;font-weight:500;padding:6px 8px;border-bottom:1px solid #2a2622}td{padding:5px 8px;border-bottom:1px solid #1f1c19}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}.muted{color:#7a736c}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}footer{margin-top:34px;color:#7a736c;font-size:12px;border-top:1px solid #2a2622;padding-top:12px}
@media print{body{background:#fff;color:#111}.tile,.bt,.chb{background:#f2f2f2;border-color:#ddd}h1,.tile b{color:#000}td,th{border-color:#ddd}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · wardrive report</title><style>${css}</style></head><body><main>` +
    `<h1>${esc(title)}</h1><p class="sub">${esc([when, d ? [d.fmt, d.app].filter(Boolean).join(" · ") : `${drives.length} drives`].filter(Boolean).join(" · "))}</p>` +
    (img ? `<img class="map" src="${img}" alt="Map of the drive"><p class="attr">Map data © OpenStreetMap contributors · Protomaps</p>` : "") +
    `<h2>At a glance</h2><div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${v}</b><span>${k}</span></div>`).join("")}</div>` +
    `<div class="grid"><div><h2>WiFi security</h2>${sec.length ? bar(sec) : `<p class="muted">No WiFi</p>`}</div>` +
    (poiRows.length ? `<div><h2>Points of interest</h2>${bar(poiRows, "#ffd24a")}</div>` : "") +
    (bands.length ? `<div><h2>Bands</h2>${bar(bands)}</div>` : "") +
    (makers.length ? `<div><h2>Device makers</h2>${bar(makers, "#4fb3ff")}</div>` : "") + `</div>` +
    (chans ? `<h2>2.4 GHz channels <small>1, 6 and 11 don't overlap</small></h2>${chans}` : "") +
    chgHtml +
    (notable.length ? `<h2>Networks worth a look <small>open, weak security or a default name; strongest first</small></h2><table><tr><th>Name</th><th>MAC</th><th>Security</th><th>Ch</th><th>Maker</th><th>Best signal</th></tr>` +
      notable.map((n) => `<tr><td><i class="dot" style="background:${(SEC[n[I.sec]] || SEC.none).color}"></i>${esc(netName(n))}</td><td class="mono">${esc(n[I.mac])}</td><td>${esc((SEC[n[I.sec]] || {}).label || "")}</td><td>${n[I.ch] || ""}</td><td>${esc(n[I.maker] || "")}</td><td class="mono">${n[I.rssi] == null ? "" : n[I.rssi] + " dBm"}</td></tr>`).join("") + `</table>` : "") +
    `<footer>Made with Flipper Workbench on ${esc(new Date().toLocaleString())}. Everything stayed on this computer.${left.length ? " Left out: " + esc(left.join(" and ")) + "." : ""}</footer>` +
    `</main></body></html>`;
}

/* ===================================================================== home zone */
function setHomeHint() { $("#wdHomeHint").hidden = !WD.settingHome; $("#wdMap").classList.toggle("picking", WD.settingHome); }
async function setHome(ll) {
  WD.settingHome = false; setHomeHint();
  await saveHome({ lat: +ll.lat.toFixed(5), lon: +ll.lng.toFixed(5), on: true });
  WD.fb.toast("Home zone set");
}
async function saveHome(patch) {
  WD.home = Object.assign({ on: false, r: 300, hide: false }, WD.home || {}, patch);
  await WD.api.wd_set("home", WD.home);
  draw();
  if (WD.side === "privacy") renderSide();
}

/* ===================================================================== offline maps */
function areaBox() {
  if ((WD.prefs.area || (WD.bounds ? "logs" : "view")) === "logs" && WD.bounds) {
    const [w, s, e, n] = WD.bounds, pad = Math.max(0.01, (e - w) * 0.1, (n - s) * 0.1);
    return [w - pad, s - pad, e + pad, n + pad];
  }
  const b = WD.map.getBounds();
  return [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
}
async function planMap() {
  const out = $("#wdPlanOut"), z = +$("#wdZoom").value, bbox = areaBox();
  out.innerHTML = `<div class="wd-note small"><span class="spin"></span> Asking how big it is...</div>`;
  const r = await WD.api.wd_map_plan(bbox, z);
  if (r.error) { out.innerHTML = `<div class="wd-note small bad">${esc(r.error)}</div>`; return; }
  if (!r.tiles) { out.innerHTML = `<div class="wd-note small">No map data there.</div>`; return; }
  const big = r.bytes > r.limit;
  out.innerHTML = `<div class="wd-plan"><b>${fmtB(r.bytes)}</b> · ${fmtN(r.tiles)} map tiles</div>` +
    (big ? `<div class="wd-note small bad">That's too big for one download. Pick "What's on screen" and zoom in, or choose less detail.</div>` :
      `<button class="mini primary" id="wdDl"><i data-icon="download"></i>Download ${fmtB(r.bytes)}</button>`);
  WD.fb.renderIcons(out);
  const b = $("#wdDl");
  if (b) b.onclick = async () => {
    const name = $("#wdMapName").value.trim() || "My area";
    const res = await WD.api.wd_map_download(bbox, name, z);
    if (res.error) { WD.fb.toast(res.error); return; }
    WD.dl = { msg: "Starting", done: 0, total: 0 }; renderSide();
  };
}
async function importMap() {
  const r = await WD.api.wd_map_import();
  if (r.cancelled) return;
  if (r.error) { WD.fb.toast(r.error); return; }
  await refreshMaps(); WD.fb.toast("Map added");
}
async function deleteMap(id) {
  const m = WD.maps.find((x) => x.id === id); if (!m) return;
  if (!await WD.fb.confirmDialog("Delete this map?", `<b>${esc(m.name)}</b> (${fmtB(m.size)}) will be removed from this computer. You can download it again later.`, "Delete")) return;
  await WD.api.wd_map_delete(id);
  await refreshMaps();
}
async function refreshMaps() {
  WD.maps = await WD.api.wd_maps();
  addBaseMaps();
  if (WD.side === "maps") renderSide();
}

/* ===================================================================== replay */
async function startReplay(id) {
  const d = WD.dmap[id]; if (!d) return;
  const data = await WD.api.wd_drive(id);
  if (!data.track.length && !data.first.length) { WD.fb.toast("Nothing to replay"); return; }
  stopReplay();
  const tsec = (t) => t ? Date.parse(t.replace(" ", "T")) / 1000 : NaN;
  const track = data.track.map((p) => ({ t: tsec(p[0]), ll: [p[1], p[2]] }));
  const timed = track.length && track.every((p) => !isNaN(p.t));
  // without timestamps, step through the route in order
  track.forEach((p, i) => { if (!timed) p.t = i; });
  const byId = Object.fromEntries(WD.nets.map((n) => [n[I.id], n]));
  const first = data.first.map((f) => ({ t: timed ? tsec(f[1]) : 0, n: byId[f[0]], ll: [f[2], f[3]] })).filter((f) => f.n);
  if (!timed) { // place each network at the route point nearest its sighting
    first.forEach((f) => { let bi = 0, bd = 1e18; track.forEach((p, i) => { const dd = (p.ll[0] - f.ll[0]) ** 2 + (p.ll[1] - f.ll[1]) ** 2; if (dd < bd) { bd = dd; bi = i; } }); f.t = bi; });
    first.sort((a, b) => a.t - b.t);
  }
  const t0 = Math.min(track.length ? track[0].t : Infinity, first.length ? first[0].t : Infinity);
  const t1 = Math.max(track.length ? track[track.length - 1].t : -Infinity, first.length ? first[first.length - 1].t : -Infinity);
  WD.replay = { id, track, first, t0, t1, t: t0, playing: true, speed: 1, ti: 0, fi: 0, timed, last: 0 };
  clearLayers(["home"]);
  if (WD.L.sel) { WD.map.removeLayer(WD.L.sel); delete WD.L.sel; }
  const L = window.L;
  WD.R = { line: L.polyline([], { color: "#ffa040", weight: 3, opacity: .9, interactive: false }).addTo(WD.map),
    dots: L.layerGroup().addTo(WD.map),
    me: L.circleMarker(track[0] ? track[0].ll : first[0].ll, { radius: 7, color: "#fff", weight: 2, fillColor: "#ff8200", fillOpacity: 1, interactive: false }).addTo(WD.map) };
  zoomDrive(id);
  $("#wdReplay").hidden = false;
  $("#wdRpName").textContent = d.name;
  $("#wdRpSlider").value = 0;
  setPlayIcon();
  WD.replay.raf = requestAnimationFrame(tick);
}
function setPlayIcon() { const r = WD.replay; $("#wdRpPlay").innerHTML = r && r.playing ? "&#10074;&#10074;" : "&#9654;"; }
function tick(now) {
  const r = WD.replay; if (!r) return;
  const span = Math.max(1, r.t1 - r.t0);
  if (r.playing) {
    const dt = r.last ? (now - r.last) / 1000 : 0;
    r.t = Math.min(r.t1, r.t + dt * span / 30 * r.speed);   // the whole drive plays in about 30 s at 1x
    if (r.t >= r.t1) { r.playing = false; setPlayIcon(); }
  }
  r.last = now;
  renderReplay();
  r.raf = requestAnimationFrame(tick);
}
function renderReplay(rebuild) {
  const r = WD.replay, L = window.L, hide = WD.home && WD.home.on && WD.home.hide;
  if (rebuild) { r.ti = 0; r.fi = 0; WD.R.line.setLatLngs([]); WD.R.dots.clearLayers(); }
  while (r.ti < r.track.length && r.track[r.ti].t <= r.t) {
    const p = r.track[r.ti++];
    if (!(hide && inHome(p.ll[0], p.ll[1]))) { WD.R.line.addLatLng(p.ll); WD.R.me.setLatLng(p.ll); }
  }
  while (r.fi < r.first.length && r.first[r.fi].t <= r.t) {
    const f = r.first[r.fi++], n = f.n;
    if (hide && inHome(n[I.lat], n[I.lon])) continue;
    L.circleMarker([n[I.lat], n[I.lon]], { radius: 4, weight: 1, color: "#0b0b0b", fillColor: colorOf(n), fillOpacity: .95, className: "wd-pop" })
      .bindTooltip(() => tip(n), { className: "wd-tip" }).on("click", () => select(n[I.id])).addTo(WD.R.dots);
  }
  $("#wdRpSlider").value = Math.round((r.t - r.t0) / Math.max(1, r.t1 - r.t0) * 1000);
  $("#wdRpCount").textContent = `${fmtN(r.fi)} networks`;
  $("#wdRpTime").textContent = r.timed ? new Date(r.t * 1000).toTimeString().slice(0, 8) : "";   // parsed as local time, shown as local time
}
function stopReplay() {
  const r = WD.replay; if (!r) return;
  cancelAnimationFrame(r.raf);
  for (const k of ["line", "dots", "me"]) if (WD.R && WD.R[k]) WD.map.removeLayer(WD.R[k]);
  WD.replay = null; WD.R = null;
  $("#wdReplay").hidden = true;
  draw();
}

/* ===================================================================== events from Python */
WD.onEvent = function (e) {
  if (e.ev === "map") {
    WD.dl = { msg: e.msg, done: e.done, total: e.total };
    if (WD.side === "maps") {
      const t = $("#wdSide .wd-progtxt"), bar = $("#wdSide .wd-pbar span");
      if (t && bar) { t.textContent = `${e.msg}${e.total ? ` · ${fmtB(e.done)} of ${fmtB(e.total)}` : ""}`; bar.style.width = (e.total ? e.done / e.total * 100 : 3) + "%"; }
      else renderSide();
    }
  } else if (e.ev === "map_done") {
    WD.dl = null;
    if (e.error) WD.fb.toast("Map download failed: " + e.error);
    else if (e.cancelled) WD.fb.toast("Map download cancelled");
    else WD.fb.toast(`Map saved (${fmtB(e.bytes)}). It works offline now.`);
    refreshMaps();
  } else if (e.ev === "read") {
    const g = $("#wdPickGo"); if (g) g.textContent = `Copying ${e.done} of ${e.total}...`;
  }
};

/* ===================================================================== wiring */
function bind() {
  $("#wdFromFlipper").onclick = importFromFlipper;
  $("#wdFromPc").onclick = importFromPc;
  $("#wdEmptyFlipper").onclick = importFromFlipper;
  $("#wdEmptyPc").onclick = importFromPc;
  let qt;
  $("#wdSearch").oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { WD.f.q = e.target.value; renderFilters(); draw(); }, 180); };
  $$("#wdSeg button").forEach((b) => b.onclick = () => {
    WD.side = b.dataset.side; WD.lastSide = WD.side;
    if (WD.sel) { WD.sel = null; drawSel(); }
    renderSide(true);
  });
  $$("#wdLayers [data-mode]").forEach((b) => b.onclick = () => { WD.prefs.mode = b.dataset.mode; savePrefs(); draw(); });
  $$("#wdLayers [data-color]").forEach((b) => b.onclick = () => { WD.prefs.color = b.dataset.color; savePrefs(); draw(); });
  $("#wdRouteBtn").onclick = () => { WD.prefs.route = !WD.prefs.route; savePrefs(); draw(); };
  $("#wdFitBtn").onclick = fitAll;
  $("#wdExportBtn").onclick = (e) => { e.stopPropagation(); const m = $("#wdExportMenu"); m.hidden = !m.hidden;
    $("#wdExportNote").textContent = `${fmtN((WD.F || []).length)} networks (what the map shows now)` + (WD.home && WD.home.on ? ". Home zone left out." : ""); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#wdExportMenu")) $("#wdExportMenu").hidden = true; });
  $$("#wdExportMenu [data-exp]").forEach((b) => b.onclick = () => exportAs(b.dataset.exp));
  $("#wdRpPlay").onclick = () => { const r = WD.replay; if (!r) return; if (!r.playing && r.t >= r.t1) { r.t = r.t0; renderReplay(true); } r.playing = !r.playing; setPlayIcon(); };
  $("#wdRpSlider").oninput = (e) => { const r = WD.replay; if (!r) return; const t = r.t0 + (r.t1 - r.t0) * e.target.value / 1000; const back = t < r.t; r.t = t; renderReplay(back); };
  $$("#wdReplay [data-speed]").forEach((b) => b.onclick = () => { if (!WD.replay) return; WD.replay.speed = +b.dataset.speed; $$("#wdReplay [data-speed]").forEach((x) => x.classList.toggle("on", x === b)); });
  $("#wdRpClose").onclick = stopReplay;
  $("#wdHomeHintCancel").onclick = () => { WD.settingHome = false; setHomeHint(); if (WD.side === "privacy") renderSide(); };
}
})();
