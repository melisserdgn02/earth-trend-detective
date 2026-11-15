/* Trend Globe — frontend. Plain JS, no build step. Talks to the FastAPI backend under /api. */
"use strict";

const S = {
  profiles: {}, regionRequest: 0, summaryRequest: 0, detailRequest: 0,
  meta: null, region: null, summary: null, period: { start: "", end: "", exclude: "" },
  filter: "all", relVars: new Set(), relResult: null, discover: null, features: [], boxFeature: null,
  scan: null, scanTimer: null, cmpRegion: null, points: [], overviewVar: null, latestChart: null,
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const VCOL = { PROVEN: "#4de0bb", SUSPICIOUS: "#f5bb78", "NO TREND": "#889bb5" };
const FRIENDLY = { PROVEN: "Significant trend", SUSPICIOUS: "Possible trend", "NO TREND": "No significant trend" };
const VORDER = { PROVEN: 0, SUSPICIOUS: 1, "NO TREND": 2 };
const friendly = (v) => FRIENDLY[v] || v;

// ---------------------------------------------------------------- utils
const API_TIMEOUT_MS = 120000;
async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.json) { o.method = o.method || "POST"; o.headers = { "Content-Type": "application/json" }; o.body = JSON.stringify(o.json); delete o.json; }
  // Every request gets a timeout; region requests also stop when the user picks another place.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort("timeout"), o.timeout || API_TIMEOUT_MS);
  const outer = o.signal; delete o.timeout;
  if (outer) { if (outer.aborted) ctl.abort("cancelled"); else outer.addEventListener("abort", () => ctl.abort("cancelled"), { once: true }); }
  o.signal = ctl.signal;
  let r;
  try { r = await fetch(path, o); }
  catch (e) {
    if (ctl.signal.reason === "cancelled") { const c = new Error("cancelled"); c.cancelled = true; throw c; }
    if (ctl.signal.reason === "timeout") throw new Error("The server took too long to answer. It may be waking up — please try again.");
    throw new Error("Could not reach the server. Check your connection and try again.");
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) throw new Error((j && j.detail) || `HTTP ${r.status}`);
  return j;
}

let plotlyRequest;
function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (!plotlyRequest) {
    plotlyRequest = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/static/vendor/plotly.min.js";
      script.onload = () => {
        if (window.Plotly) resolve(window.Plotly);
        else reject(new Error("Could not load the chart. Try again."));
      };
      script.onerror = () => reject(new Error("Could not load the chart. Try again."));
      document.head.append(script);
    }).catch((error) => {
      plotlyRequest = null;
      throw error;
    });
  }
  return plotlyRequest;
}
function loadingHTML(text) {
  return `<div class="loading" role="status"><span class="spin"></span><span>${esc(text)} <span class="elapsed" data-t0="${Date.now()}"></span></span></div>
    <p class="muted slow-hint hidden">The free server may be waking up. The first request after a pause can take up to a minute; after that it is fast.</p>`;
}
setInterval(() => {
  for (const el of document.querySelectorAll(".elapsed[data-t0]")) {
    const sec = Math.round((Date.now() - +el.dataset.t0) / 1000);
    if (sec >= 3) el.textContent = `(${sec} s)`;
    const hint = el.closest(".loading")?.nextElementSibling;
    if (hint && hint.classList.contains("slow-hint")) hint.classList.toggle("hidden", sec < 12);
  }
}, 1000);
function errorHTML(msg) {
  return `<div class="error-card"><b>Something went wrong</b><p>${esc(msg)}</p><button class="retry" type="button">Try again</button></div>`;
}
function toast(msg, err = false, ms = 4200) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function fmt(x, sig = 3) {
  if (x === null || x === undefined || !isFinite(x)) return "–";
  if (x === 0) return "0";
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const dec = Math.min(6, Math.max(0, sig - 1 - mag));
  return x.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
const fsig = (x, sig = 3) => (x > 0 ? "+" : "") + fmt(x, sig);
function fp(p) { if (p === null || p === undefined || !isFinite(p)) return "–"; if (p < 0.001) return "<0.001"; return p < 0.1 ? p.toFixed(3) : p.toFixed(2); }
function stars(q) { return q < 0.001 ? "***" : q < 0.01 ? "**" : q < 0.05 ? "*" : ""; }
function periodQuery() {
  const p = new URLSearchParams();
  if (S.period.start) p.set("start", S.period.start);
  if (S.period.end) p.set("end", S.period.end);
  if (S.period.exclude) p.set("exclude", S.period.exclude);
  const s = p.toString(); return s ? "?" + s : "";
}
function periodBody() {
  return { start: S.period.start ? +S.period.start : null, end: S.period.end ? +S.period.end : null, exclude: S.period.exclude || null };
}
function stampHTML(v, big = false) {
  const cls = v === "NO TREND" ? "NO" : v;
  return `<span class="stamp ${cls}${big ? " big" : ""}">${esc(friendly(v))}</span>`;
}
function lerpColor(a, b, t) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16)), pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function diverging(v, lim) {
  const t = Math.max(-1, Math.min(1, v / (lim || 1)));
  return t >= 0 ? lerpColor("2b3a57", "ff6a3d", t) : lerpColor("2b3a57", "3d9bff", -t);
}
const PLOT = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#dfe7f3", family: "system-ui, sans-serif", size: 12 },
  xaxis: { gridcolor: "#1e2c47", zerolinecolor: "#2a3b5c" }, yaxis: { gridcolor: "#1e2c47", zerolinecolor: "#2a3b5c" },
  margin: { l: 60, r: 16, t: 30, b: 40 }, legend: { orientation: "h", y: 1.14 },
};
const PCFG = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] };
function layout(extra) { return Object.assign(JSON.parse(JSON.stringify(PLOT)), extra || {}); }

// ---------------------------------------------------------------- globe
let globe;
function initGlobe(topo, profiles) {
  S.profiles = profiles;
  S.features = topojson.feature(topo, topo.objects.countries).features.filter((f) => f.properties.name !== "Antarctica");
  const el = $("#globe");
  const pickCountry = feature => {
    if (feature.properties.isBox) return;
    selectRegion({ id: "c-" + slug(feature.properties.name), name: feature.properties.name, kind: "country" });
  };
  try {
    // NASA Blue Marble imagery with country outlines on top; study areas pulse with their trend.
    globe = Globe({ animateIn: false })(el)
      .backgroundColor("rgba(0,0,0,0)")
      .globeImageUrl("/static/textures/earth-blue-marble.jpg")
      .bumpImageUrl("/static/textures/earth-topology.jpg")
      .showAtmosphere(true).atmosphereColor("#7cc4ff").atmosphereAltitude(0.17)
      .polygonsData(S.features)
      .polygonCapColor(capColor)
      .polygonSideColor(() => "rgba(0,0,0,0)")
      .polygonStrokeColor((f) => (isSelected(f) ? "#ffffff" : "rgba(235,245,255,0.30)"))
      .polygonAltitude((f) => (isSelected(f) ? 0.02 : 0.004))
      .polygonsTransitionDuration(300)
      .onPolygonHover(onHover)
      .onPolygonClick(pickCountry)
      .pointsData([]).pointLat("lat").pointLng("lng").pointColor(() => "#ffd27a").pointAltitude(0.012).pointRadius(0.16)
      .pointLabel((p) => `POWER grid point ${p.lat}°, ${p.lng}°`)
      .ringsData([]).ringLat("lat").ringLng("lng").ringAltitude(0.006)
      .ringColor((h) => (t) => trendRGBA(h, 1 - t)).ringMaxRadius((h) => (h.verdict === "PROVEN" ? 6 : 3))
      .ringPropagationSpeed(2).ringRepeatPeriod((h) => (h.verdict === "PROVEN" ? 1300 : 2600))
      .htmlElementsData([]).htmlLat("lat").htmlLng("lng").htmlAltitude(0.03).htmlElement(markerEl)
      .arcsData([]).arcColor("colors").arcStroke(0.6).arcAltitudeAutoScale(0.35)
      .arcDashLength(0.35).arcDashGap(0.15).arcDashAnimateTime(2600);
  } catch {
    globe = canvasGlobe(el, { color: (f) => { const c = capColor(f); return c === "rgba(0,0,0,0)" || c.startsWith("rgba(255,255,255") ? "#244f7c" : c; },
                              selected: isSelected, hover: onHover, select: pickCountry });
    globe.polygonsData(S.features);
  }
  globe.pointOfView({ lat: 30, lng: 10, altitude: 1.37 });
  const ro = new ResizeObserver(() => globe.width(el.clientWidth).height(el.clientHeight));
  ro.observe(el);
  setupRotation(el);
}
// The globe turns slowly by itself. It pauses while you drag or zoom, and starts again after
// a few seconds, unless a region is open in the side panel or you pressed "Pause".
function setupRotation(el) {
  const btn = $("#rotate-btn");
  const ctl = globe.controls();
  ctl.autoRotateSpeed = 0.4;
  S.rotateOn = true;
  let idle;
  const apply = () => {
    const focused = S.region && !$("#overview-panel").classList.contains("hidden");
    ctl.autoRotate = S.rotateOn && !S.userBusy && !focused;
    btn.textContent = S.rotateOn ? "❚❚ Pause" : "⟳ Rotate";
    btn.setAttribute("aria-pressed", String(!S.rotateOn));
  };
  const busy = () => { S.userBusy = true; apply(); clearTimeout(idle); idle = setTimeout(() => { S.userBusy = false; apply(); }, 6000); };
  el.addEventListener("pointerdown", busy);
  el.addEventListener("wheel", busy, { passive: true });
  btn.onclick = () => { S.rotateOn = !S.rotateOn; if (S.rotateOn) S.userBusy = false; apply(); };
  S.applyRotation = apply;
  apply();
}

// ---------------------------------------------------------------- study-area markers (trend layer)
function trendRGBA(h, a) {
  if (h.verdict !== "PROVEN" && h.verdict !== "SUSPICIOUS") return `rgba(200,210,225,${0.55 * a})`;
  return h.sen_dec < 0 ? `rgba(255,140,66,${a})` : `rgba(77,200,255,${a})`;
}
function shortName(n) { return n.replace(/\s*\(.*\)\s*/, "").replace(" study box", ""); }
function markerEl(h) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `trend-marker side-${h.side || "right"} ${h.sen_dec < 0 ? "dry" : "wet"}${h.verdict === "PROVEN" ? " sig" : h.verdict === "SUSPICIOUS" ? " maybe" : ""}`;
  const pct = h.pct !== null && isFinite(h.pct) ? `${fsig(h.pct, 2)} %` : `${fsig(h.sen_dec)}/dec`;
  el.innerHTML = `<i></i><b>${esc(pct)}</b><span>${esc(shortName(h.name))}</span>`;
  el.title = `${h.name}: root-zone soil moisture ${pct} (${h.period}) · ${friendly(h.verdict)}. Click to open.`;
  el.onclick = (e) => { e.stopPropagation(); selectRegion({ id: h.id, name: h.name, label: h.name, kind: "box", bbox: h.bbox }); };
  // globe.gl positions the outer element with its own CSS transform; the label moves inside it.
  const anchor = document.createElement("div");
  anchor.className = "trend-anchor";
  anchor.append(el);
  return anchor;
}
async function loadHighlights() {
  try {
    const d = await api("/api/highlights", { timeout: 180000 });
    S.highlights = d.items || [];
    // Labels of nearby study areas would overlap: put the more western one's label on the left.
    for (const h of S.highlights) {
      h.side = S.highlights.some((o) => o !== h && Math.abs(o.lat - h.lat) < 8 && Math.abs(o.lng - h.lng) < 25 && o.lng > h.lng) ? "left" : "right";
    }
    if (!S.highlights.length || typeof globe.ringsData !== "function") return;
    globe.ringsData(S.highlights).htmlElementsData(S.highlights);
    // The mirror trend: one region drying, another getting wetter, both significant.
    const dry = S.highlights.filter((h) => h.verdict === "PROVEN" && h.sen_dec < 0).sort((a, b) => a.pct - b.pct)[0];
    const wet = S.highlights.filter((h) => h.verdict === "PROVEN" && h.sen_dec > 0).sort((a, b) => b.pct - a.pct)[0];
    if (dry && wet) globe.arcsData([{ startLat: dry.lat, startLng: dry.lng, endLat: wet.lat, endLng: wet.lng,
                                      colors: ["rgba(255,140,66,0.95)", "rgba(77,200,255,0.95)"] }]);
    $("#trend-legend").classList.remove("hidden");
    $("#trend-legend .legend-src").textContent = `${d.variable} · ${d.source}`;
  } catch { /* markers are optional */ }
}
function isSelected(f) {
  if (!S.region) return false;
  if (f.properties.isBox) return true;
  return S.region.kind === "country" && "c-" + slug(f.properties.name) === S.region.id;
}
function capColor(f) {
  if (f.properties.isBox) return "rgba(255,236,140,0.45)";
  if (isSelected(f)) return "rgba(255,231,106,0.42)";
  const id = "c-" + slug(f.properties.name);
  if (S.scan && S.scan.results && S.scan.results[id]) {
    const r = S.scan.results[id];
    let c = diverging(r.sen_dec, S.scan.lim);
    if (r.verdict === "NO TREND") c = lerpColor(c.slice(1), "1b2b47", 0.65);
    else if (r.verdict === "SUSPICIOUS") c = lerpColor(c.slice(1), "1b2b47", 0.3);
    return c + "d0";
  }
  if (f === S.hoverFeature) return "rgba(255,255,255,0.16)";
  return "rgba(0,0,0,0)";
}
function onHover(f) {
  if (S.hoverFeature !== f) { S.hoverFeature = f; if (globe && globe.polygonCapColor) globe.polygonCapColor(capColor); }
  const tip = $("#hover-tip");
  if (!f) { tip.classList.add("hidden"); return; }
  const id = "c-" + slug(f.properties.name || "");
  let html = `<b>${esc(f.properties.name || "")}</b>`;
  if (S.scan && S.scan.results && S.scan.results[id]) {
    const r = S.scan.results[id];
    html += `<br>${esc(S.scan.label)}: <span style="font-family:var(--mono)">${fsig(r.sen_dec)} ${esc(S.scan.unit)}/decade</span> ${stampHTML(r.verdict).replace("stamp", "stamp inline")}`;
  }
  tip.innerHTML = html; tip.classList.remove("hidden");
}
function refreshGlobe() { globe.polygonsData([...S.features, ...(S.boxFeature ? [S.boxFeature] : [])]); }
function boxFeature(b, name) {
  const [w, s, e, n] = b, ring = [];
  for (let la = s; la < n; la += Math.max(0.5, (n - s) / 30)) ring.push([w, la]);
  for (let lo = w; lo < e; lo += Math.max(0.5, (e - w) / 30)) ring.push([lo, n]);
  for (let la = n; la > s; la -= Math.max(0.5, (n - s) / 30)) ring.push([e, la]);
  for (let lo = e; lo > w; lo -= Math.max(0.5, (e - w) / 30)) ring.push([lo, s]);
  ring.push([w, s]);
  return { type: "Feature", properties: { name, isBox: true }, geometry: { type: "Polygon", coordinates: [ring] } };
}
function flyTo(b) {
  const [w, s, e, n] = b;
  let lng = (w + e) / 2; const lat = (s + n) / 2;
  const span = Math.max(e - w, n - s);
  if (e - w > 300) lng = 0; // antimeridian-spanning countries (Russia, Fiji, USA)
  if (S.applyRotation) S.applyRotation();
  globe.pointOfView({ lat, lng, altitude: Math.min(1.7, Math.max(1.25, span / 16)) }, 1200);
}

// ---------------------------------------------------------------- search
function setupSearch(input, dropdown, onPick) {
  let items = [], sel = -1, timer;
  const render = () => {
    if (!items.length) { dropdown.classList.add("hidden"); return; }
    dropdown.innerHTML = items.map((r, i) => `<div class="item${i === sel ? " sel" : ""}" data-i="${i}"><span>${esc(r.name)}</span><span class="kind">${esc(r.kind)}</span></div>`).join("");
    dropdown.classList.remove("hidden");
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { items = []; render(); return; }
      try { items = await api("/api/search?q=" + encodeURIComponent(q)); sel = items.length ? 0 : -1; render(); }
      catch (e) { toast(e.message, true); }
    }, 140);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter") {
      if (items[sel]) pick(items[sel]);
      else if (input.value.trim()) {  // typed fast and hit Enter before suggestions arrived
        clearTimeout(timer);
        api("/api/search?q=" + encodeURIComponent(input.value.trim()))
          .then((r) => (r[0] ? pick(r[0]) : toast("No region found for “" + input.value.trim() + "”", true)))
          .catch((err) => toast(err.message, true));
      }
    }
    else if (e.key === "Escape") { items = []; render(); }
  });
  dropdown.addEventListener("mousedown", (e) => { const it = e.target.closest(".item"); if (it) pick(items[+it.dataset.i]); });
  input.addEventListener("blur", () => setTimeout(() => dropdown.classList.add("hidden"), 150));
  function pick(r) { input.value = r.name; items = []; render(); onPick(r); }
}

// ---------------------------------------------------------------- select region
function setSidebar(side, open) {
  const left = side === "notes";
  const panel = $(left ? "#notebook" : "#overview-panel");
  const trigger = $(left ? "#toggle-notes" : "#toggle-overview");
  panel.classList.toggle("hidden", !open);
  trigger.setAttribute("aria-expanded", open);
  trigger.classList.toggle("invisible", open);
  if (S.applyRotation) S.applyRotation();
  resizePlots();
}

function renderCountryProfile(region) {
  const card = $("#country-profile");
  const feature = S.features.find(f => region.id === "c-" + slug(f.properties.name));
  const profile = feature ? S.profiles[feature.id || feature.properties.name] : null;
  const name = region.name === "Turkey" ? "Türkiye" : region.name;
  const flag = profile?.flagPosition;
  const format = new Intl.NumberFormat("en");
  const metric = (entry, unit = "") => entry ? `${format.format(entry[0])}${unit} <small>· ${esc(entry[1])}</small>` : "Unavailable";
  card.classList.remove("hidden");
  card.innerHTML = `<div class="country-heading">${flag ? `<span class="country-flag" aria-hidden="true" style="--flag-x:${flag[0]}%;--flag-y:${flag[1]}%"></span>` : ""}
    <div><span class="eyebrow">${feature ? "Country" : "Study area"}</span><h3>${esc(name)}</h3></div></div>
    ${feature ? `<details open><summary>Country profile</summary><dl>
      <div><dt>Capital</dt><dd>${esc(profile?.capital?.join(", ") || "Unavailable")}</dd></div>
      <div><dt>Population</dt><dd>${metric(profile?.population)}</dd></div>
      <div><dt>Surface area</dt><dd>${metric(profile?.area, " km²")}</dd>${profile?.area ? `<dd class="muted">${format.format(Math.round(profile.area[0] * 1e6))} m²</dd>` : ""}</div>
    </dl><p class="profile-sources"><a href="https://data.worldbank.org/" target="_blank" rel="noopener">World Bank</a> · <a href="https://github.com/mledoze/countries" target="_blank" rel="noopener">Capital data</a></p></details>` : ""}`;
}

async function selectRegion(r) {
  if (S.regionCtl) S.regionCtl.abort();
  S.regionCtl = new AbortController();
  const request = ++S.regionRequest;
  ++S.summaryRequest;
  ++S.detailRequest;
  S.region = r; S.summary = null; S.overviewVar = null; S.discover = null; S.relResult = null;
  renderCountryProfile(r);
  setSidebar("overview", true);
  switchTab("overview");
  $("#welcome").classList.add("hidden");
  $("#tab-overview").innerHTML = loadingHTML("Opening " + r.name + "…");
  $("#search").value = r.name;
  S.boxFeature = r.kind !== "country" && r.bbox ? boxFeature(r.bbox, r.name) : null;
  refreshGlobe();
  try {
    const info = await api("/api/region/" + encodeURIComponent(r.id), { signal: S.regionCtl.signal });
    if (request !== S.regionRequest) return;
    S.region = { ...r, ...info };
    if (r.label) S.region.name = r.label;
    if (!r.bbox) S.boxFeature = info.kind !== "country" ? boxFeature(info.bbox, info.name) : null;
    refreshGlobe(); flyTo(info.bbox);
    globe.pointsData(r.id.startsWith("g-") ? [] : info.points.map(([lat, lng]) => ({ lat, lng })));
  } catch (e) {
    if (e.cancelled || request !== S.regionRequest) return;
    $("#tab-overview").innerHTML = errorHTML(e.message);
    $("#tab-overview .retry").onclick = () => selectRegion(r);
    return;
  }
  await loadSummary();
}
async function loadSummary() {
  if (!S.region) return;
  const rid = S.region.id;
  const request = ++S.summaryRequest;
  ++S.detailRequest;
  $("#notes").innerHTML = `<div class="region-name">${esc(S.region.name)}</div>${loadingHTML("Fetching NASA data and running the tests…")}`;
  $("#tab-overview").innerHTML = `<div class="overview-intro"><span class="mini-tag">GETTING REAL NASA DATA</span><h2>${esc(S.region.name)}</h2>${loadingHTML("Loading measurements and testing every variable for a trend…")}</div>`;
  $("#tab-vars").innerHTML = `<div class="placeholder"><div class="loading" style="justify-content:center"><div class="spin"></div>Investigating ${esc(S.region.name)}…</div></div>`;
  $("#tab-rel").innerHTML = $("#tab-cmp").innerHTML = `<div class="placeholder">Loading ${esc(S.region.name)}…</div>`;
  try {
    const sm = await api(`/api/region/${encodeURIComponent(rid)}/summary${periodQuery()}`, { signal: S.regionCtl?.signal });
    if (request !== S.summaryRequest || S.region?.id !== rid) return;
    sm.variables.forEach((v) => { v.unit = prettyUnit(v.unit); });
    S.summary = sm;
    if (S.region.name !== sm.region.name) sm.region.name = S.region.name;
    if (!S.relVars.size || [...S.relVars].some((v) => !sm.variables.find((x) => x.id === v))) {
      S.relVars = new Set(defaultRelVars(sm));
    }
    renderNotes(); renderOverview(); renderVars(); renderRel(); renderCmp();
    $("#demo-banner").classList.toggle("hidden", !(sm.info && sm.info.synthetic));
  } catch (e) {
    if (e.cancelled || request !== S.summaryRequest) return;
    $("#notes").innerHTML = `<div class="region-name">${esc(S.region.name)}</div><p class="caveat">${esc(e.message)}</p>`;
    $("#tab-vars").innerHTML = `<div class="placeholder">${esc(e.message)}</div>`;
    $("#tab-overview").innerHTML = `<div class="overview-intro"><h2>Data could not be loaded</h2>${errorHTML(e.message)}<p class="muted">You can also try another place.</p></div>`;
    $("#tab-overview .retry").onclick = () => loadSummary();
  }
}
function defaultRelVars(sm) {
  const pref = ["T2M", "PRECTOTCORR", "GWETROOT", "AOD_55", "CLRSKY_SFC_SW_DWN", "CLOUD_AMT"];
  const have = new Set(sm.variables.map((v) => v.id));
  const g = sm.variables.filter((v) => v.id.startsWith("G:")).map((v) => v.id);
  return [...g, ...pref.filter((p) => have.has(p))].slice(0, 6);
}

// ---------------------------------------------------------------- friendly overview
function preferredOverviewVars(sm) {
  const ids = sm.variables.map(v => v.id);
  const g = ids.find(x => x.startsWith("G:"));
  const picks = [g, "T2M", "PRECTOTCORR", "GWETROOT", "CLOUD_AMT", "AOD_55", ...ids].filter(Boolean);
  return [...new Set(picks)].filter(k => ids.includes(k)).slice(0, 6);
}
function sourceOf(v) { return v.id.startsWith("G:") ? "NASA Giovanni CSV" : "NASA POWER"; }
function trendMeaning(s, v) {
  if (!s.ok) return "We need more observations before we can check for a long-term trend.";
  if (s.verdict === "PROVEN") return `Our tests find a clear ${s.sen_dec >= 0 ? "upward" : "downward"} trend. The average change is about ${fmt(Math.abs(s.sen_dec))} ${v.unit} per decade.`;
  if (s.verdict === "SUSPICIOUS") return `The numbers suggest a ${s.sen_dec >= 0 ? "rise" : "fall"}, but there is not enough evidence to be confident yet.`;
  return "The numbers go up and down, but we cannot confidently say there is a steady rise or fall. This does not prove there was no change.";
}
function badgeHTML(st) {
  const v = st && st.ok ? st.verdict : null;
  if (!v) return `<span class="badge NA">Too little data</span>`;
  return `<span class="badge ${v === "NO TREND" ? "NO" : v}">${esc(friendly(v))}</span>`;
}
function prettyUnit(u) {
  if (!u) return u;
  return String(u).replace(/\bkg m-2 s-1\b/g, "kg/m²/s").replace(/\bkg m-2\b/g, "kg/m²").replace(/\bW m-2\b/g, "W/m²")
    .replace(/\bm-2\b/g, "m⁻²").replace(/\bs-1\b/g, "s⁻¹").replace(/\bm2\b/g, "m²").replace(/\bm3\b/g, "m³");
}
function unitSuffix(u) { return u ? " " + u : ""; }
function rowNumbers(v) {
  const st = v.stats;
  if (!st || !st.ok) return `<span class="ov-nums"><b>–</b></span>`;
  const dir = st.sen_dec > 0 ? "up" : st.sen_dec < 0 ? "down" : "";
  const pct = isFinite(st.pct) && st.pct !== null ? `<small>${fsig(st.pct, 2)} % since ${esc(st.start.slice(0, 4))}</small>` : `<small>${fsig(st.total)}${esc(unitSuffix(v.unit))} since ${esc(st.start.slice(0, 4))}</small>`;
  return `<span class="ov-nums"><b class="${dir}">${fsig(st.sen_dec)}${esc(unitSuffix(v.unit))}<i>/decade</i></b>${pct}</span>`;
}
function sortedVariables(sm) {
  const rank = (v) => (v.stats && v.stats.ok ? VORDER[v.stats.verdict] ?? 3 : 4);
  return [...sm.variables].sort((a, b) => rank(a) - rank(b) || Math.abs(b.stats?.snr || 0) - Math.abs(a.stats?.snr || 0));
}
function choiceHTML(v, attr = "data-id") {
  return `<button class="ov-choice" ${attr}="${esc(v.id)}" type="button" aria-expanded="false" aria-controls="overview-detail">
    <span class="ov-name">${esc(v.label)}<small>${esc(v.category || "Measurement")}</small></span>
    ${rowNumbers(v)}${badgeHTML(v.stats)}</button>`;
}
function summaryStrip(sm) {
  const n = { PROVEN: 0, SUSPICIOUS: 0, "NO TREND": 0 };
  sm.variables.forEach((v) => { if (v.stats?.ok && v.stats.verdict in n) n[v.stats.verdict]++; });
  return `<div class="ov-summary">
    <div class="PROVEN"><b>${n.PROVEN}</b><span>significant trend${n.PROVEN === 1 ? "" : "s"}</span></div>
    <div class="SUSPICIOUS"><b>${n.SUSPICIOUS}</b><span>possible</span></div>
    <div class="NO"><b>${n["NO TREND"]}</b><span>no significant trend</span></div></div>
    <p class="ov-meta">${esc(sm.period)} · ${esc(sm.info?.source_type || "NASA")} · ${sm.variables.length} variables tested · significance after correcting for autocorrelation and for testing many variables (FDR)</p>`;
}
async function chooseOverviewVar(vid) {
  if (!S.summary || !S.region) return;
  const v = S.summary.variables.find(x => x.id === vid);
  if (!v) return;
  const request = ++S.detailRequest;
  const expanded = S.overviewVar !== vid;
  S.overviewVar = expanded ? vid : null;
  $$(".ov-choice").forEach(button => {
    const selected = expanded && button.dataset.id === vid;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-expanded", selected);
  });
  const box = $("#overview-detail");
  box.classList.toggle("hidden", !expanded);
  if (!expanded) return;
  box.innerHTML = loadingHTML("Loading the graph and all tests…");
  try {
    const [data] = await Promise.all([
      api(`/api/region/${encodeURIComponent(S.region.id)}/variable/${encodeURIComponent(vid)}${periodQuery()}`, { signal: S.regionCtl?.signal }),
      loadPlotly(),
    ]);
    if (request !== S.detailRequest) return;
    const st = v.stats;
    const analysis = data.stats;
    const dir = st.sen_dec >= 0 ? "rising" : "falling";
    const ci = analysis.ok && analysis.annual && Array.isArray(analysis.annual.sen_ci_dec) ? analysis.annual.sen_ci_dec : null;
    const pctLine = st.ok && st.pct !== null && isFinite(st.pct) ? `${fsig(st.pct, 2)} %` : "";
    box.innerHTML = `<div class="ov-result-head"><div><div class="eyebrow">${esc(v.category || "EARTH SCIENCE")}</div>
      <h3>${esc(v.label)}</h3><p>${esc(v.definition)}</p></div>${badgeHTML(st)}</div>
      <div class="ov-metrics">
        <div><small>Trend per decade</small><strong>${st.ok ? fsig(st.sen_dec) : "–"} <span>${esc(v.unit)}</span></strong>
          <em>${ci ? `95 % range ${fsig(ci[0])} to ${fsig(ci[1])}` : "Sen's slope"}</em></div>
        <div><small>Total change since ${st.ok ? esc(st.start.slice(0, 4)) : "–"}</small><strong>${st.ok ? fsig(st.total) : "–"} <span>${esc(v.unit)}</span></strong>
          <em>${pctLine ? pctLine + " of the long-term mean" : `change ÷ year-to-year noise: ${st.ok ? fmt(st.snr, 2) : "–"}`}</em></div>
        <div class="sig ${st.ok ? (st.verdict === "NO TREND" ? "NO" : st.verdict) : ""}"><small>Is it significant?</small><strong>${st.ok ? esc(friendly(st.verdict)) : "–"}</strong>
          <em>${st.ok ? `Seasonal Kendall p ${fp(st.seasonal_kendall.p)} · Mann-Kendall p ${fp(st.hamed_rao.p)} · after FDR q ${fp(st.q)}` : ""}</em></div>
        <div><small>Data period</small><strong>${st.ok ? esc(st.start.slice(0,4)) + "–" + esc(st.end.slice(0,4)) : "–"}</strong>
          <em>${st.ok ? `${st.n} months` : ""}</em></div></div>
      <div id="overview-chart" class="ov-chart" role="img" aria-label="Time series chart for ${esc(v.label)}"></div>
      <div class="ov-explanation"><span class="mini-tag">SO, WHAT DOES THIS MEAN?</span><p>${esc(trendMeaning(st,v))}</p></div>
      <div class="ov-source"><span>Data: <b>${esc(sourceOf(v))}</b> · ${esc(v.unit || "unitless")}</span><button id="export-csv" class="ghost">Download data (CSV)</button></div>
      <p class="ov-footnote">A trend describes a pattern, not its cause. The graph removes the usual seasonal cycle so long-term changes are easier to see. The trend is an estimate, not a forecast.</p>`;
    if (analysis.ok && analysis.chart) {
      S.latestChart = { data: analysis, variable: v };
      const t = analysis.chart.t;
      const y = analysis.chart.anomaly_12m;
      const fit = analysis.chart.sen_line;
      await Plotly.newPlot("overview-chart", [
        {x:t, y, type:"scatter", mode:"lines", name:"12-month average change from usual", line:{color:"#51d5c8",width:3}, connectgaps:false},
        {x:t, y:fit, type:"scatter", mode:"lines", name:"Long-term trend", line:{color:"#ffbf86",width:2,dash:"dash"}}
      ], layout({height:320, margin:{l:56,r:14,t:34,b:40}, xaxis:{gridcolor:"#203651", tickfont:{size:11}}, yaxis:{title:{text:`Change from usual${v.unit ? ` (${v.unit})` : ""}`,font:{size:11}}, gridcolor:"#203651"}, legend:{orientation:"h",y:1.19}}), PCFG);
      $("#export-csv").onclick = () => {
        const raw = analysis.chart;
        const rows = [["month","measured_value","change_from_usual","12_month_average_change","trend_line_change"],
          ...raw.t.map((x,i)=>[x,raw.value[i],raw.anomaly[i],raw.anomaly_12m[i],raw.sen_line[i]])];
        const csv = rows.map(r => r.map(x=> x===null || x===undefined ? "" : String(x)).join(",")).join("\n");
        const url = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
        const link=document.createElement("a");link.href=url;link.download=`earthtrend-${slug(v.label)}.csv`;link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      };
    } else {
      $("#overview-chart").innerHTML = `<div class="placeholder">There are not enough months of data for a reliable graph.</div>`;
      $("#export-csv").disabled = true;
    }
  } catch(e) {
    if (e.cancelled || request !== S.detailRequest) return;
    box.innerHTML = errorHTML(e.message);
    $(".retry", box).onclick = () => { S.overviewVar = null; chooseOverviewVar(vid); };
  }
}
function renderOverview() {
  const sm = S.summary;
  $("#tab-overview").innerHTML = `${summaryStrip(sm)}
    <div class="ov-toolbar"><p class="overview-label">Click a measurement to see its graph and all tests.</p>
    <input id="overview-search" type="search" aria-label="Find a variable" placeholder="Find a variable…"></div>
    <div class="ov-picks">${sortedVariables(sm).map(v => choiceHTML(v)).join("") || '<p class="muted">No measurements available.</p>'}</div>
    <p id="overview-empty" class="muted hidden" role="status">No matching variables.</p>
    <div id="overview-detail" class="overview-detail hidden"></div>`;
  S.overviewVar = null;
  $$(".ov-choice").forEach(button => {
    button.onclick = async () => {
      if (S.overviewVar === button.dataset.id) {
        await chooseOverviewVar(button.dataset.id);
        return;
      }
      // Place the detail directly after the measurement that opened it.
      button.after($("#overview-detail"));
      await chooseOverviewVar(button.dataset.id);
    };
  });
  $("#overview-search").oninput = event => {
    const query = event.target.value.trim().toLowerCase();
    for (const button of $$(".ov-choice")) {
      const v = sm.variables.find(item => item.id === button.dataset.id);
      const visible = `${v.label} ${v.category} ${v.id}`.toLowerCase().includes(query);
      button.classList.toggle("hidden", !visible);
      if (!visible && S.overviewVar === button.dataset.id) chooseOverviewVar(button.dataset.id);
    }
    $("#overview-empty").classList.toggle("hidden", Boolean($(".ov-choice:not(.hidden)")));
  };
}

function renderNotes() {
  const sm = S.summary;
  const n = sm.notes;
  const rel = S.discover ? S.discover.found.slice(0, 5).map(f => f.text) : n.relations;
  const sections = [
    ["Clear trends", n.what],
    ["Possible trends", n.ongoing],
    ["No clear trend", n.stable],
    ["Where is this measured?", [n.where, ...(sm.info.giovanni_files || [])]],
    ["How sure are we?", [n.significance]],
    ["What changes together?", rel?.length ? rel : ["Open Relationships to test how measurements vary together."]],
    ["Important to know", [...n.caveats, sm.info.power_warning]],
  ];
  const list = items => `<ul>${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
  $("#notes").innerHTML = `
    <div class="region-name">${esc(sm.region.name)}</div>
    <p class="tag">${esc(sm.period)} · ${esc(sm.info.source_type || "NASA")}</p>
    <label class="filter-label">Search findings<input id="notes-search" type="search" placeholder="e.g. warming, dust, rainfall"></label>
    <p id="notes-no-match" class="muted hidden" role="status">No matching findings.</p>
    <div class="notes-chapters">${sections.map(([title, entries]) => {
      const items = entries.filter(Boolean);
      return `<details class="chapter"><summary>${esc(title)} <span>${items.length}</span></summary>
        ${items.length ? list(items) : '<p class="muted">No findings in this category.</p>'}</details>`;
    }).join("")}</div>`;
  $("#notes-search").oninput = event => {
    const query = event.target.value.trim().toLowerCase();
    let matches = 0;
    for (const chapter of $$(".chapter", $("#notes"))) {
      const titleMatches = chapter.querySelector("summary").textContent.toLowerCase().includes(query);
      const entries = $$("li", chapter);
      for (const item of entries) item.classList.toggle("hidden", !titleMatches && !item.textContent.toLowerCase().includes(query));
      const visible = titleMatches || entries.some(item => !item.classList.contains("hidden"));
      chapter.classList.toggle("hidden", !visible);
      chapter.open = Boolean(query && visible);
      if (visible) matches++;
    }
    $("#notes-no-match").classList.toggle("hidden", matches > 0);
  };
}

// ---------------------------------------------------------------- variables tab
function renderVars() {
  const variables = S.summary.variables;
  $("#tab-vars").innerHTML = `
    <label class="filter-label">Find a variable<input id="vars-search" type="search" placeholder="Search name, category or code"></label>
    <label class="filter-label">Trend filter<select id="vars-filter">
      <option value="all">All trends</option><option value="PROVEN">Clear trends</option>
      <option value="SUSPICIOUS">Possible trends</option><option value="NO TREND">No clear trend</option>
    </select></label>
    <p id="vars-count" class="muted" role="status"></p><div class="ov-picks" id="variable-list"></div>
    <details class="catalog-lookup"><summary>Giovanni variable catalog</summary>
      <label class="filter-label">Search Giovanni variables<input id="giovanni-search" type="search" placeholder="e.g. soil moisture"></label>
      <p id="giovanni-count" class="muted" role="status"></p><ul id="giovanni-list"></ul>
      <button id="giovanni-more" class="ghost hidden" type="button">Show more</button>
    </details>`;
  function filterVariables() {
    const query = $("#vars-search").value.trim().toLowerCase();
    const verdict = $("#vars-filter").value;
    const filtered = variables.filter(v =>
      `${v.label} ${v.category} ${v.id}`.toLowerCase().includes(query) &&
      (verdict === "all" || (v.stats.ok && v.stats.verdict === verdict)));
    $("#vars-count").textContent = `${filtered.length} of ${variables.length} variables`;
    $("#variable-list").innerHTML = sortedVariables({ variables: filtered }).map(v => choiceHTML(v, "data-v")).join("");
    $$("#variable-list button").forEach(button => button.onclick = () => openDetail(button.dataset.v));
  }
  $("#vars-search").oninput = filterVariables;
  $("#vars-filter").onchange = filterVariables;
  filterVariables();
  let entries = [];
  let visibleCount = 20;
  const catalogPanel = $(".catalog-lookup");
  const search = $("#giovanni-search", catalogPanel);
  const status = $("#giovanni-count", catalogPanel);
  const results = $("#giovanni-list", catalogPanel);
  const more = $("#giovanni-more", catalogPanel);
  function showCatalog() {
    const words = search.value.toLowerCase().trim().split(/\s+/);
    const matches = entries.filter(([id, name]) => words.every(word => `${id} ${name}`.toLowerCase().includes(word)));
    status.textContent = `${matches.length.toLocaleString()} of ${entries.length.toLocaleString()} variables. Open a dataset in Giovanni to export its data.`;
    results.innerHTML = matches.slice(0, visibleCount).map(([id, name]) => `<li><a
      href="https://giovanni.gsfc.nasa.gov/giovanni/#service=ArAvTs&data=${encodeURIComponent(id)}"
      target="_blank" rel="noopener">${esc(name)} ↗</a></li>`).join("");
    more.classList.toggle("hidden", matches.length <= visibleCount);
  }
  catalogPanel.addEventListener("toggle", async () => {
    if (!catalogPanel.open || entries.length) return;
    status.textContent = "Loading Giovanni catalog…";
    try { entries = await api("/static/giovanni-variables.json"); showCatalog(); }
    catch (error) { status.textContent = error.message; }
  });
  search.oninput = () => { visibleCount = 20; if (entries.length) showCatalog(); };
  more.onclick = () => { visibleCount += 20; showCatalog(); };
}

// ---------------------------------------------------------------- variable detail
async function openDetail(vid) {
  const rid = S.region.id;
  $("#modal-body").innerHTML = `<div class="loading"><div class="spin"></div>Loading…</div>`;
  $("#modal").classList.remove("hidden");
  let d;
  try {
    [d] = await Promise.all([
      api(`/api/region/${encodeURIComponent(rid)}/variable/${encodeURIComponent(vid)}${periodQuery()}`),
      loadPlotly(),
    ]);
  }
  catch (e) { $("#modal-body").innerHTML = `<p class="caveat">${esc(e.message)}</p>`; return; }
  const s = d.stats, u = d.unit;
  const fromSummary = (S.summary.variables.find((v) => v.id === vid) || {}).stats;
  if (s.ok && fromSummary && fromSummary.ok) { s.q = fromSummary.q; s.verdict = fromSummary.verdict; s.sentence = fromSummary.sentence; if (s.verdict === "PROVEN") delete s.more_years_needed; }
  if (!s.ok) { $("#modal-body").innerHTML = `<h2>${esc(d.label)}</h2><p>${esc(s.reason)}</p>`; return; }
  const row = (name, val, p, note = "") => `<tr class="${p !== null && p < 0.05 ? "sig" : ""}"><td>${name}</td><td class="num">${val}</td><td class="num">${p === null ? "" : fp(p)}</td><td class="muted">${note}</td></tr>`;
  const ytd = s.years_to_detect, yrs = s.years;
  const meter = ytd ? `<div class="meter"><i style="width:${Math.min(100, (yrs / Math.max(ytd, yrs)) * 100)}%"></i><b style="left:${Math.min(99.5, (ytd / Math.max(ytd, yrs)) * 100)}%"></b></div>
      <div class="note">${yrs.toFixed(0)} years of data so far · ${fmt(ytd, 2)} years needed to detect a trend this size (Weatherhead et al. 1998: 5 % level, 90 % probability, with this noise and autocorrelation).
      ${s.verdict === "PROVEN" ? "" : s.more_years_needed > 0 ? `<b>About ${fmt(s.more_years_needed, 2)} more years</b> at the current pace.` : "Enough data — if it is still not significant, the trend may simply not be there."}</div>` : "";
  const split = Object.entries(s.seasonal_split || {}).map(([k, v]) => row(`Trend in ${k} means (OLS / MK)`, `${fsig(v.slope_dec)} ${u}/dec`, Math.max(v.p_ols, v.p_mk), `OLS p ${fp(v.p_ols)}, MK p ${fp(v.p_mk)}`)).join("");
  $("#modal-body").innerHTML = `
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:300px"><h2>${esc(d.label)} <span class="muted" style="font-size:14px">· ${esc(S.region.name)}</span></h2>
      <div class="muted">${esc(d.definition)}</div>
      ${d.giovanni ? `<div class="note">Cross-check in Giovanni: <b>${esc(d.giovanni)}</b>, same box ${S.region.bbox.map((x) => fmt(x, 3)).join(", ")}</div>` : ""}</div>
      ${stampHTML(s.verdict, true)}
    </div>
    <p style="font-size:15px;margin:14px 0">${esc(s.sentence)}</p>
    <div id="pl-raw" class="plot" style="height:250px"></div>
    <div id="pl-anom" class="plot" style="height:290px"></div>
    <div class="grid2" style="margin-top:8px">
      <div class="box"><h4>All tests</h4><table class="stats"><tr><th>Test</th><th>Result</th><th>p</th><th></th></tr>
        ${row("Seasonal Kendall, Hirsch-Slack", `τ ${fmt(s.seasonal_kendall.tau, 2)}`, s.seasonal_kendall.p, "main test 1: seasonality-proof, corrected for correlated months")}
        ${row("Mann-Kendall, Hamed-Rao, yearly anomalies", `z ${fmt(s.hamed_rao.z, 3)}`, s.hamed_rao.p, "main test 2: corrected for autocorrelation")}
        ${row("Seasonal Kendall (plain)", "", s.seasonal_kendall_plain.p, "info only: too optimistic when months are correlated")}
        ${row("Mann-Kendall (original), monthly", `τ ${fmt(s.mk.tau, 2)}`, s.mk.p, "info only: assumes independent months")}
        ${row("Sen's slope (seasonal)", `${fsig(s.sen_dec)} ${u}/dec`, null, s.annual ? `95 % CI ${fsig(s.annual.sen_ci_dec[0])} … ${fsig(s.annual.sen_ci_dec[1])}` : "")}
        ${row("OLS slope, t-test", `${fsig(s.ols.slope_dec)} ${u}/dec`, s.ols.p, `t = ${fmt(s.ols.t, 3)}, R² = ${fmt(s.ols.r2, 2)}`)}
        ${row("OLS, ANOVA F-test", `F = ${fmt(s.ols.F, 3)}`, s.ols.p_F, "as in the SeaWiFS paper")}
        ${row("OLS, Newey-West (HAC) errors", `95 % CI ${fsig(s.ols.ci_hac_dec[0])} … ${fsig(s.ols.ci_hac_dec[1])}`, s.ols.p_hac, "autocorrelation-robust")}
        ${s.annual ? row("Yearly anomalies, OLS", `${fsig(s.annual.slope_dec)} ${u}/dec`, s.annual.p, `${s.annual.n} years, R² = ${fmt(s.annual.r2, 2)}`) : ""}
        ${row("Robust linear (Huber)", `${fsig(s.robust.slope_dec)} ${u}/dec`, s.robust.p, "limits outlier influence")}
        ${split}
        ${row("Augmented Dickey-Fuller", s.unit_root_warning ? "unit root not ruled out" : "stationary around trend", s.adf_p, s.unit_root_warning ? "⚠ trend p-values may be optimistic" : "")}
        ${row("Pettitt change point", s.pettitt.year ? `break around ${s.pettitt.year}` : "no clear break", s.pettitt.p, s.pettitt.year ? (s.pettitt.step_better ? "⚠ a sudden step fits better than a smooth trend" : "a smooth trend fits better than a step") : "")}
        ${row("FDR q (all variables of this region)", "", s.q ?? null, "Benjamini-Hochberg")}
      </table></div>
      <div class="box"><h4>How much</h4><table class="stats">
        <tr><td>Long-term mean</td><td class="num">${fmt(s.mean)} ${esc(u)}</td></tr>
        <tr><td>First → latest full year</td><td class="num">${s.first_year ? `${fmt(s.first_year.value)} (${s.first_year.year}) → ${fmt(s.latest_year.value)} (${s.latest_year.year})` : "–"}</td></tr>
        <tr><td>Change over the period (Sen)</td><td class="num">${fsig(s.total)} ${esc(u)}${s.pct !== null && s.pct !== undefined ? ` (${fsig(s.pct, 2)} %)` : ""}</td></tr>
        <tr><td>Change ÷ typical monthly wobble</td><td class="num">${fmt(s.snr, 2)}×</td></tr>
        <tr><td>Months of data</td><td class="num">${s.n} (${esc(s.start.slice(0, 7))} … ${esc(s.end.slice(0, 7))})</td></tr>
        <tr><td>Lag-1 autocorrelation of residuals</td><td class="num">${fmt(s.lag1, 2)}</td></tr>
      </table>
      <h4 style="margin-top:14px">Investigation meter</h4>${meter || '<div class="note">–</div>'}
      </div>
    </div>`;
  const c = s.chart;
  Plotly.newPlot("pl-raw", [
    { x: c.t, y: c.value, mode: "lines", line: { width: 1, color: "#8fb6e8" }, name: `monthly value (${u})` },
  ], layout({ title: { text: "Monthly values (with the seasonal cycle)", font: { size: 13 } }, showlegend: false, yaxis: { gridcolor: "#1e2c47", title: u } }), PCFG);
  const tr = [
    { x: c.t, y: c.anomaly, mode: "lines", line: { width: 0.7, color: "#4b5d7d" }, name: "monthly anomaly" },
    { x: c.t, y: c.anomaly_12m, mode: "lines", line: { width: 2.2, color: "#dfe7f3" }, name: "12-month mean" },
    { x: c.t, y: c.sen_line, mode: "lines", line: { width: 3, color: VCOL[s.verdict], dash: "dash" }, name: `Sen ${fsig(s.sen_dec)}/dec` },
    { x: c.t, y: c.ols_line, mode: "lines", line: { width: 1.5, color: "#ffb35c", dash: "dot" }, name: `OLS ${fsig(s.ols.slope_dec)}/dec` },
  ];
  const shapes = s.pettitt.year && s.pettitt.step_better ? [{ type: "line", x0: `${s.pettitt.year}-01`, x1: `${s.pettitt.year}-01`, yref: "paper", y0: 0, y1: 1, line: { color: "#ff6b6b", dash: "dot" } }] : [];
  Plotly.newPlot("pl-anom", tr, layout({ title: { text: "Anomalies (seasonal cycle removed) and trend lines", font: { size: 13 } }, shapes, yaxis: { gridcolor: "#1e2c47", title: `anomaly ${u}`, zerolinecolor: "#3a4d70" } }), PCFG);
}

// ---------------------------------------------------------------- relationships tab
function relVarChips() {
  return S.summary.variables.filter((v) => v.stats.ok).map((v) => `<span class="chip${S.relVars.has(v.id) ? " on" : ""}" data-v="${esc(v.id)}">${esc(v.label)}</span>`).join("");
}
function renderRel() {
  const sm = S.summary;
  const opts = sm.variables.filter((v) => v.stats.ok).map((v) => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join("");
  $("#tab-rel").innerHTML = `
    <div class="box">
      <h4>🔎 Auto-detective</h4>
      <div class="row"><button id="btn-discover">Find every significant relationship in ${esc(sm.region.name)}</button></div>
      <div class="note">Tests all pairs of variables with Kendall τ, with and without the long-term trends, corrects for autocorrelation and for testing many pairs at once (FDR).</div>
      <div id="discover-out"></div>
    </div>
    <div class="box">
      <h4>Test your own selection</h4>
      <div class="varpick" id="relpick">${relVarChips()}</div>
      <div class="row" style="margin-top:10px">
        <label>Test <select id="rel-method">
          <option value="kendall">Kendall τ (rank, robust)</option><option value="spearman">Spearman ρ (rank)</option><option value="pearson">Pearson r (linear)</option></select></label>
        <label>Data <select id="rel-mode">
          <option value="anomalies">anomalies (season removed)</option><option value="detrended">anomalies, trends removed</option></select></label>
        <label><input type="checkbox" id="rel-lags"> lags ±6 months</label>
        <button id="btn-rel">Run tests</button>
      </div>
      <div id="rel-out"></div>
    </div>
    <div class="box">
      <h4>Multiple regression (OLS)</h4>
      <div class="row"><label>Explain <select id="reg-y">${opts}</select></label>
        <span class="muted">with the variables selected above</span>
        <label><input type="checkbox" id="reg-trend"> add time trend</label>
        <button id="btn-reg" class="ghost">Run OLS</button></div>
      <div class="note">Standardised coefficients (SD change in the target per SD change in each variable), Newey-West errors, VIF for overlap.</div>
      <div id="reg-out"></div>
    </div>`;
  $$("#relpick .chip").forEach((c) => (c.onclick = () => {
    const v = c.dataset.v; S.relVars.has(v) ? S.relVars.delete(v) : S.relVars.add(v); c.classList.toggle("on");
  }));
  const yDefault = S.relVars.has("GWETROOT") ? "GWETROOT" : [...S.relVars][0];
  if (yDefault) $("#reg-y").value = yDefault;
  $("#btn-rel").onclick = runRel;
  $("#btn-discover").onclick = runDiscover;
  $("#btn-reg").onclick = runReg;
  if (S.discover) renderDiscover();
}
async function runDiscover() {
  const out = $("#discover-out");
  if (!out) return;
  out.innerHTML = `<div class="loading" style="margin-top:8px"><div class="spin"></div>Interrogating every pair…</div>`;
  try {
    S.discover = await api(`/api/region/${encodeURIComponent(S.region.id)}/discover${periodQuery()}`);
    renderDiscover(); renderNotes();
  } catch (e) { out.innerHTML = `<p class="caveat">${esc(e.message)}</p>`; }
}
function renderDiscover() {
  const d = S.discover, out = $("#discover-out");
  if (!out) return;
  out.innerHTML = `<p class="note">${esc(d.summary)}</p>` + (d.found.length ? d.found.map((f) => `
    <div class="finding ${f.kind === "linked" ? "sig" : "trendonly"}" data-x="${esc(f.x)}" data-y="${esc(f.y)}">
      <div class="k">${f.kind === "linked" ? "linked year to year" : "shared trend only"} · N ${f.n} (effective ≈ ${Math.round(f.n_eff)})</div>${esc(f.text)}</div>`).join("")
    : `<p>No relationship survives the corrections.</p>`) + `<div id="disc-scatter" class="plot" style="height:300px"></div>`;
  $$("#discover-out .finding").forEach((el) => (el.onclick = () => drawScatter("disc-scatter", el.dataset.x, el.dataset.y, el.classList.contains("sig") ? "detrended" : "anomalies")));
  if (d.found[0]) drawScatter("disc-scatter", d.found[0].x, d.found[0].y, d.found[0].kind === "linked" ? "detrended" : "anomalies");
}
async function runRel() {
  const vars = [...S.relVars], out = $("#rel-out");
  if (vars.length < 2) { toast("Pick at least two variables", true); return; }
  const method = $("#rel-method").value, mode = $("#rel-mode").value, lags = $("#rel-lags").checked;
  out.innerHTML = `<div class="loading" style="margin-top:8px"><div class="spin"></div>Running ${vars.length * (vars.length - 1) / 2} tests…</div>`;
  try {
    const [r] = await Promise.all([
      api(`/api/region/${encodeURIComponent(S.region.id)}/relations`, { json: { vars, method, mode, lags, ...periodBody() } }),
      loadPlotly(),
    ]);
    S.relResult = r;
    const sym = { pearson: "r", spearman: "ρ", kendall: "τ" }[method];
    const L = r.labels, cols = r.cols;
    const z = cols.map(() => cols.map(() => null)), txt = cols.map(() => cols.map(() => ""));
    cols.forEach((c, i) => { z[i][i] = 1; txt[i][i] = "—"; });
    r.pairs.forEach((p) => {
      const i = cols.indexOf(p.x), j = cols.indexOf(p.y), h = p[method];
      z[i][j] = z[j][i] = h.r; txt[i][j] = txt[j][i] = `${h.r.toFixed(2)}${stars(h.q)}`;
    });
    out.innerHTML = `
      <div style="margin-top:10px">${r.sentences.map((s) => `<div class="finding ${s.significant ? "sig" : ""}" data-x="${esc(s.x)}" data-y="${esc(s.y)}">${esc(s.text)}</div>`).join("")}</div>
      <div id="rel-heat" class="plot" style="height:${Math.max(300, 70 + cols.length * 46)}px"></div>
      <div id="rel-scatter" class="plot" style="height:300px"></div>
      <table class="stats" style="margin-top:8px"><tr><th>Pair</th><th>N (eff.)</th><th>Pearson r</th><th>Spearman ρ</th><th>Kendall τ</th><th>p adj.</th><th>FDR q</th><th>Bonferroni</th></tr>
      ${r.pairs.map((p) => `<tr class="${p[method].q < 0.05 ? "sig" : ""}"><td>${esc(L[p.x])} × ${esc(L[p.y])}</td><td class="num">${p.n} (${Math.round(p.n_eff)})</td>
        <td class="num">${p.pearson.r.toFixed(2)}</td><td class="num">${p.spearman.r.toFixed(2)}</td><td class="num">${p.kendall.r.toFixed(2)}</td>
        <td class="num">${fp(p[method].p)}</td><td class="num">${fp(p[method].q)}</td><td class="num">${fp(p[method].p_bonf)}</td></tr>`).join("")}</table>
      <div class="note">${r.tests} tests. Stars on the heatmap: FDR q &lt; 0.05 *, &lt; 0.01 **, &lt; 0.001 ***. p-values use the effective sample size (autocorrelation-corrected). Click a sentence or a cell for the scatter plot.</div>`;
    Plotly.newPlot("rel-heat", [{
      type: "heatmap", z, x: cols.map((c) => L[c]), y: cols.map((c) => L[c]), text: txt, texttemplate: "%{text}", zmin: -1, zmax: 1,
      colorscale: [[0, "#3d9bff"], [0.5, "#1b2b47"], [1, "#ff6a3d"]], colorbar: { title: sym, thickness: 12 }, hovertemplate: "%{y} × %{x}<br>" + sym + " = %{z:.2f}<extra></extra>",
    }], layout({ margin: { l: 170, r: 10, t: 10, b: 130 }, xaxis: { tickangle: 35 }, yaxis: { autorange: "reversed" } }), PCFG);
    $("#rel-heat").on("plotly_click", (ev) => {
      const pt = ev.points[0]; const i = pt.pointIndex[0], j = pt.pointIndex[1];
      if (i !== j) drawScatter("rel-scatter", cols[j], cols[i], mode);
    });
    $$("#rel-out .finding").forEach((el) => (el.onclick = () => drawScatter("rel-scatter", el.dataset.x, el.dataset.y, mode)));
    const best = r.pairs.slice().sort((a, b) => Math.abs(b[method].r) - Math.abs(a[method].r))[0];
    if (best) drawScatter("rel-scatter", best.x, best.y, mode);
  } catch (e) { out.innerHTML = `<p class="caveat">${esc(e.message)}</p>`; }
}
async function drawScatter(el, x, y, mode) {
  try {
    const d = await api(`/api/region/${encodeURIComponent(S.region.id)}/scatter?x=${encodeURIComponent(x)}&y=${encodeURIComponent(y)}&mode=${mode}${periodQuery().replace("?", "&")}`);
    const yrs = d.t.map((t) => +t.slice(0, 4));
    Plotly.newPlot(el, [{
      x: d.x, y: d.y, mode: "markers", type: "scattergl", text: d.t, marker: { size: 5, color: yrs, colorscale: "Viridis", opacity: 0.75, colorbar: { title: "year", thickness: 10 } },
      hovertemplate: "%{text}<br>x %{x:.3g}<br>y %{y:.3g}<extra></extra>",
    }], layout({
      title: { text: `${d.xl} vs ${d.yl} · ${mode === "detrended" ? "anomalies, trends removed" : "monthly anomalies"}`, font: { size: 12 } },
      xaxis: { title: `${d.xl} ${d.xu}`, gridcolor: "#1e2c47" }, yaxis: { title: `${d.yl} ${d.yu}`, gridcolor: "#1e2c47" }, margin: { l: 60, r: 10, t: 34, b: 46 },
    }), PCFG);
  } catch (e) { toast(e.message, true); }
}
async function runReg() {
  const y = $("#reg-y").value, xs = [...S.relVars].filter((v) => v !== y), out = $("#reg-out");
  if (!xs.length) { toast("Select at least one other variable above", true); return; }
  out.innerHTML = `<div class="loading"><div class="spin"></div>Fitting…</div>`;
  try {
    const r = await api(`/api/region/${encodeURIComponent(S.region.id)}/regression`, { json: { y, xs, mode: $("#rel-mode").value, trend: $("#reg-trend").checked, ...periodBody() } });
    if (!r.ok) { out.innerHTML = `<p>${esc(r.reason)}</p>`; return; }
    out.innerHTML = `<p style="margin-top:10px">${esc(r.sentence)}</p>
      <table class="stats"><tr><th>Variable</th><th>β (std.)</th><th>95 % CI</th><th>p (HAC)</th><th>VIF</th></tr>
      ${r.coefs.map((c) => `<tr class="${c.p < 0.05 ? "sig" : ""}"><td>${esc(r.labels[c.name] || c.name)}</td><td class="num">${fsig(c.beta, 2)}</td><td class="num">${fsig(c.ci[0], 2)} … ${fsig(c.ci[1], 2)}</td><td class="num">${fp(c.p)}</td><td class="num">${c.vif ? fmt(c.vif, 2) : "–"}</td></tr>`).join("")}</table>
      <div class="note">N = ${r.n} months · R² = ${fmt(r.r2, 2)} (adjusted ${fmt(r.r2_adj, 2)}) · F-test p ${fp(r.p_F)} · residual lag-1 autocorrelation ${fmt(r.resid_lag1, 2)}</div>`;
  } catch (e) { out.innerHTML = `<p class="caveat">${esc(e.message)}</p>`; }
}

// ---------------------------------------------------------------- compare tab (mirror trends)
function renderCmp() {
  const opts = S.summary.variables.filter((v) => v.stats.ok && !v.id.startsWith("G:")).map((v) => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join("");
  $("#tab-cmp").innerHTML = `
    <div class="box"><h4>Mirror-trend check</h4>
      <p class="note" style="margin-top:0">The same process can push a variable up in one region and down in another. Compare ${esc(S.region.name)} with a second region.</p>
      <div class="row" style="position:relative"><input id="cmp-search" type="text" placeholder="second region…" style="flex:1;min-width:200px;background:var(--bg2);border:1px solid var(--line2);border-radius:8px;height:30px;padding:0 8px">
        <div id="cmp-results" class="dropdown hidden" style="top:34px"></div></div>
      <div class="row"><label>Variable <select id="cmp-var">${opts}</select></label><button id="btn-cmp">Compare</button></div>
      <div id="cmp-out"></div></div>`;
  setupSearch($("#cmp-search"), $("#cmp-results"), (r) => (S.cmpRegion = r));
  if (S.cmpRegion) $("#cmp-search").value = S.cmpRegion.name;
  $("#btn-cmp").onclick = runCmp;
}
async function runCmp() {
  if (!S.cmpRegion) { toast("Pick a second region", true); return; }
  const out = $("#cmp-out"), v = $("#cmp-var").value;
  out.innerHTML = `<div class="loading"><div class="spin"></div>Fetching ${esc(S.cmpRegion.name)}…</div>`;
  try {
    const [r] = await Promise.all([
      api("/api/compare", { json: { a: S.region.id, b: S.cmpRegion.id, var: v, start: periodBody().start, end: periodBody().end } }),
      loadPlotly(),
    ]);
    out.innerHTML = `<p style="margin-top:10px">${r.mirror ? "<b style='color:var(--accent2)'>MIRROR TREND · </b>" : ""}${esc(r.text)}</p><div id="cmp-plot" class="plot" style="height:300px"></div>
      <div class="note">Difference tested with the Hamed-Rao Mann-Kendall test on (anomaly A − anomaly B), so shared weather and shared data artefacts cancel out.</div>`;
    Plotly.newPlot("cmp-plot", [
      { x: r.chart.t, y: r.chart.a, mode: "lines", name: r.names[0], line: { color: "#ff7a59", width: 2 } },
      { x: r.chart.t, y: r.chart.b, mode: "lines", name: r.names[1], line: { color: "#4aa8ff", width: 2 } },
    ], layout({ yaxis: { title: "anomaly, 12-month mean", gridcolor: "#1e2c47" } }), PCFG);
  } catch (e) { out.innerHTML = `<p class="caveat">${esc(e.message)}</p>`; }
}

// ---------------------------------------------------------------- globe scan
async function startScan() {
  const v = $("#scan-var").value;
  try {
    const r = await api("/api/scan", { json: { var: v, ...periodBody() } });
    if (!r.started) toast(r.message);
    pollScan();
  } catch (e) { toast(e.message, true); }
}
async function pollScan() {
  clearTimeout(S.scanTimer);
  try {
    const st = await api("/api/scan/status");
    const meta = S.meta.variables[st.var] || {};
    const vals = Object.values(st.results || {}).map((r) => Math.abs(r.sen_dec)).sort((a, b) => a - b);
    const lim = vals.length ? vals[Math.floor(vals.length * 0.9)] || vals[vals.length - 1] : 1;
    const unitGuess = S.summary ? (S.summary.variables.find((x) => x.id === st.var) || {}).unit || "" : "";
    S.scan = { ...st, lim, label: meta.label || st.var, unit: unitGuess };
    const pr = $("#scan-progress");
    pr.classList.toggle("hidden", !st.total);
    $("#scan-progress i").style.width = st.total ? (100 * st.done / st.total) + "%" : "0";
    $("#scan-progress span").textContent = st.running ? `${st.done}/${st.total} countries` : `${Object.keys(st.results).length} countries done`;
    $("#scan-btn").textContent = st.running ? "Stop scan" : "Scan the globe";
    refreshGlobe(); renderLegend();
    if (st.running) S.scanTimer = setTimeout(pollScan, 2000);
  } catch (e) { toast(e.message, true); }
}
function renderLegend() {
  const L = $("#legend");
  if (!S.scan || !Object.keys(S.scan.results || {}).length) { L.classList.add("hidden"); return; }
  const n = Object.values(S.scan.results), np = n.filter((r) => r.verdict === "PROVEN").length;
  L.innerHTML = `<b>${esc(S.scan.label)}</b> · trend per decade
    <div class="ramp" style="background:linear-gradient(90deg,#3d9bff,#2b3a57,#ff6a3d)"></div>
    <div class="ticks"><span>${fsig(-S.scan.lim, 2)}</span><span>0</span><span>${fsig(S.scan.lim, 2)}</span></div>
    <div class="note">Bright colours mean a clear trend after our statistical checks (${np}/${n.length}); faint colours mean weaker evidence.</div>`;
  L.classList.remove("hidden");
}

// ---------------------------------------------------------------- method tab
function renderMethod() {
  $("#tab-method").innerHTML = `<div class="method">
  <h3>The challenge (verbatim)</h3>
  <p><i>“Change is always occurring in the Earth’s interconnected environmental system, and when it runs in a consistent direction – rising or falling, increasing or decreasing, thickening or thinning – measured variables reflect it. But a measured Earth science data variable can trend one way in one region and the opposite way in another, even when the same process drives both. The multitude of Earth science data variables makes it difficult to select variables that could indicate change, and to then perform an analysis on the selected variables. Your challenge is to create a tool that can select variables measured by Earth science missions or produced by Earth science models, visualize how they change over time, and determine what is changing, where it is changing, how much it is changing, and if these changes are what scientists call “significant.””</i></p>
  <p>How EarthTrend Explorer answers it: <b>select variables</b> (16 NASA variables per region, plus your Giovanni files) · <b>visualize change over time</b> (cards, time series, anomalies) · <b>what</b> (verdict per variable) · <b>where</b> (any country, study box or point on the globe, and the globe scan) · <b>how much</b> (Sen's slope per decade, total change, % change) · <b>significant</b> (several tests, autocorrelation- and multiple-testing-corrected) · <b>one way here, the opposite there</b> (Compare regions → mirror trend).</p>
  <h3>Data</h3><p>${esc(S.meta.source_note)}</p>
  <h3>Trend tests (per variable)</h3><ul>
    <li><b>Seasonal Kendall test</b>, period 12 — compares each month only with the same month in other years, so seasons can't fake a trend. <span class="muted">(Medium: “Statistical test methods to detect trends in time series data”)</span> We use the <b>Hirsch-Slack</b> version, which also allows for correlation between neighbouring months.</li>
    <li><b>Mann-Kendall test</b>, and the <b>Hamed-Rao modified</b> version on yearly anomalies, which corrects for autocorrelation (a dry year is often followed by another).</li>
    <li><b>Calibration check</b> (tests/test_stats.py): on 300 simulated trendless, autocorrelated series our verdict says PROVEN in about 5 % of cases, as it should; a naive OLS t-test says “significant” in 17–30 %.</li>
    <li><b>OLS regression with slope t-test</b> (Medium article) and <b>ANOVA F-test with R²</b> <span class="muted">(SeaWiFS chlorophyll paper, NASA NTRS 20090042747)</span>, plus Newey-West (HAC) errors.</li>
    <li><b>Yearly anomalies regressed on time</b>: subtract each month's long-term mean, average within each year, regress <span class="muted">(SeaWiFS paper / Gregg et al. 2005)</span>.</li>
    <li><b>Robust linear regression</b> (Huber) to limit outliers <span class="muted">(SeaWiFS paper)</span>. <b>Seasonal split</b> May–Oct vs Nov–Apr <span class="muted">(SeaWiFS paper's winter/summer split)</span>. <b>Exclude years</b> box in the header <span class="muted">(SeaWiFS paper drops the 2000 Po flood)</span>.</li>
    <li><b>Sen's slope</b> = size of the trend, robust to outliers, with 95 % CI. <b>Augmented Dickey-Fuller</b> unit-root check <span class="muted">(Medium article)</span>. <b>Pettitt</b> change point. <b>Weatherhead et al. (1998)</b> years needed to detect the trend.</li>
    <li><b>Verdict</b>: PROVEN = Seasonal Kendall (Hirsch-Slack) and Hamed-Rao (yearly) both p &lt; 0.05 after the <b>Benjamini-Hochberg FDR</b> correction across the region's variables, and OLS and Sen agree on the direction. SUSPICIOUS = some test p &lt; 0.10. NO TREND = otherwise. α = 0.05, 95 % intervals <span class="muted">(Statsig: “A Comprehensive Guide to Statistical Significance”)</span>.</li></ul>
  <h3>Relationship tests (between variables)</h3><ul>
    <li><b>Pearson r</b>, <b>Spearman ρ</b>, <b>Kendall τ</b> on monthly anomalies — or with each variable's trend removed, to separate “share a long-term trend” from “move together year to year”.</li>
    <li>p-values with the <b>effective sample size</b> N<sub>eff</sub> = N(1 − r₁r₂)/(1 + r₁r₂) (Bretherton et al. 1999), because monthly data are autocorrelated.</li>
    <li><b>Multiple comparisons</b>: FDR q-values and <b>Bonferroni</b> <span class="muted">(Statsig guide)</span>. Lagged correlation ±6 months, Bonferroni over lags.</li>
    <li><b>Multiple OLS</b> with standardised coefficients, Newey-West errors and VIF (overlap between predictors).</li>
    <li>Correlation is not causation. The app says “move together”, never “causes”.</li></ul>
  <h3>Challenge resources</h3><ul>
    <li><b>Giovanni</b> — upload area-averaged CSVs (＋ Giovanni data); every variable card names the matching Giovanni variable to cross-check.</li>
    <li><b>Hydrology Time Series</b>, <b>AppEEARS</b> — export to CSV with a <code>time,value</code> table and upload the same way (see README).</li>
    <li><b>Climate Data Online (NOAA)</b>, <b>KNMI Climate Explorer</b> — independent cross-checks of our trends.</li>
    <li><b>SeaWiFS time-series paper</b>, <b>Medium trend-test article</b>, <b>Statsig significance guide</b> — the methods above.</li></ul>
  </div>`;
}

// ---------------------------------------------------------------- tabs, header, boot
function resizePlots() {
  if (!window.Plotly) return;
  requestAnimationFrame(() => $$(".js-plotly-plot").forEach((p) => { if (p.offsetParent) Plotly.Plots.resize(p); }));
}
function switchTab(t) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $$(".tab").forEach((el) => el.classList.toggle("hidden", el.id !== "tab-" + t));
  resizePlots();
}
function setupPanelResize() {
  const panel = $("#overview-panel"), grip = $("#panel-resizer"), wide = $("#panel-wide");
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };
  const saved = +store.get("panelWidth");
  if (saved >= 360) panel.style.setProperty("--panel-w", saved + "px");
  let startX = 0, startW = 0;
  const move = (e) => {
    const w = Math.max(360, Math.min(window.innerWidth * 0.75, startW + (startX - e.clientX)));
    panel.style.setProperty("--panel-w", w + "px");
  };
  const up = () => {
    grip.classList.remove("drag"); document.body.classList.remove("resizing");
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    store.set("panelWidth", Math.round(panel.getBoundingClientRect().width)); resizePlots();
  };
  grip.addEventListener("pointerdown", (e) => {
    panel.classList.remove("wide"); wide.setAttribute("aria-pressed", "false");
    startX = e.clientX; startW = panel.getBoundingClientRect().width;
    grip.classList.add("drag"); document.body.classList.add("resizing");
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  });
  grip.addEventListener("dblclick", () => { panel.style.removeProperty("--panel-w"); store.set("panelWidth", ""); resizePlots(); });
  wide.onclick = () => {
    const on = !panel.classList.contains("wide");
    panel.classList.toggle("wide", on); wide.setAttribute("aria-pressed", on);
    wide.textContent = on ? "⇥ Narrow" : "⇤ Wider"; resizePlots();
  };
  window.addEventListener("resize", () => { clearTimeout(setupPanelResize._t); setupPanelResize._t = setTimeout(resizePlots, 150); });
}
async function boot() {
  setupPanelResize();
  for (const side of ["notes", "overview"]) {
    const trigger = $("#toggle-" + side);
    trigger.onclick = () => setSidebar(side, trigger.getAttribute("aria-expanded") !== "true");
    $("#close-" + side).onclick = () => { setSidebar(side, false); trigger.focus(); };
  }
  const [meta, topo, profiles] = await Promise.all([
    api("/api/meta"),
    api("/geo/countries-50m.json"),
    api("/static/country-profiles.json").catch(() => ({})),
  ]);
  S.meta = meta;
  $("#demo-banner").classList.toggle("hidden", !S.meta.demo);
  if (S.meta.public_site) {
    $(".upload").classList.add("hidden");
    $(".scan").classList.add("hidden");
  }
  if (!S.meta.exact_statistics) toast("For full published Mann–Kendall tests, install pymannkendall as in requirements.txt", true, 9500);
  $("#scan-var").innerHTML = Object.entries(S.meta.variables).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  renderMethod();
  initGlobe(topo, profiles);
  loadHighlights();
  setupSearch($("#search"), $("#search-results"), selectRegion);
  $$(".example").forEach((b) => b.addEventListener("click", async () => {
    try {
      // Bundled Giovanni boxes open their exact Giovanni series (fast and offline); otherwise search the name.
      const box = b.dataset.demo;
      const bundled = box && S.meta.giovanni.some(file => file.bbox?.join(",") === box);
      const bb = box ? box.split(",").map(Number) : null;
      const selected = bundled
        ? { id: "g-" + bb.join("_"), name: b.dataset.label, label: b.dataset.label, kind: "box", bbox: bb }
        : (await api("/api/search?q=" + encodeURIComponent(b.dataset.region)))[0];
      if (selected) selectRegion(selected); }
    catch(e) { toast(e.message, true); }
  }));
  $("#help-btn").onclick = () => {
    $("#modal-body").innerHTML = `<h2>How to explore Earth</h2>
      <p>Think of this as a magnifying glass for our planet. NASA measures the Earth over many years. We look for patterns in that data.</p>
      <div class="how-steps"><div><b>01 · Choose a place</b><p>Click a country on the spinning globe, or search above.</p></div>
      <div><b>02 · Choose what to study</b><p>Look at temperature, rain, clouds and more.</p></div>
      <div><b>03 · Read the result</b><p>Our chart shows the measurements. The trend line shows the longer-term direction.</p></div></div>
      <h3>Where do the numbers come from?</h3>
      <p>Automatic data comes from <a href="https://power.larc.nasa.gov/" target="_blank" rel="noopener">NASA POWER</a>. To study a particular dataset from <a href="https://giovanni.gsfc.nasa.gov/giovanni/" target="_blank" rel="noopener">NASA Giovanni</a>, choose <b>Time Series, Area-Averaged</b>, download the <b>CSV</b> and click <b>+ Giovanni data</b> above.</p>
      <p><b>Important:</b> The site never claims that a trend proves what caused it. "No clear trend" means we cannot be confident about the direction, not that nothing changed.</p>`;
    $("#modal").classList.remove("hidden");
  };
  $$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $("#modal-close").onclick = () => $("#modal").classList.add("hidden");
  $("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").classList.add("hidden"); });
  $("#apply").onclick = () => {
    S.period = { start: $("#start").value.trim(), end: $("#end").value.trim(), exclude: $("#exclude").value.trim() };
    S.discover = null; loadSummary();
  };
  $("#scan-btn").onclick = async () => {
    if (S.scan && S.scan.running) { await api("/api/scan/stop", { method: "POST" }); pollScan(); } else startScan();
  };
  $("#upload").onchange = async (e) => {
    for (const f of e.target.files) {
      const fd = new FormData(); fd.append("file", f);
      try {
        const r = await api("/api/upload", { method: "POST", body: fd });
        toast(`Giovanni data added: ${r.label} (${r.months} months)`);
        if (r.region_id) selectRegion({ id: r.region_id, name: `Giovanni box ${r.bbox.join(",")}`, kind: "box", bbox: r.bbox });
      } catch (err) { toast(`${f.name}: ${err.message}`, true, 7000); }
    }
    e.target.value = "";
  };
  if (!S.meta.public_site) pollScan();
  const h = decodeURIComponent(location.hash.slice(1));
  if (h) { const r = await api("/api/search?q=" + encodeURIComponent(h)); if (r[0]) selectRegion(r[0]); }
}
boot().catch((e) => toast("Startup failed: " + e.message, true, 10000));
