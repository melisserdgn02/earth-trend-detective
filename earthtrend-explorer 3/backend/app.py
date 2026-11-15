"""Trend Globe — FastAPI backend.  Run from the project folder:

    uvicorn backend.app:app --port 8000          (real NASA POWER data, needs internet)
    TREND_GLOBE_DEMO=1 uvicorn backend.app:app   (synthetic data, offline UI testing)

then open http://localhost:8000
"""
from __future__ import annotations
import functools
import inspect
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import catalog, data, narrative as N, regions as R
from .sources import giovanni_csv, power
from .stats import relations as REL, trend as TR

ROOT = Path(__file__).resolve().parents[1]
FRONT = ROOT / "frontend"
app = FastAPI(title="Trend Globe")
app.add_middleware(GZipMiddleware, minimum_size=1000)  # the 750 kB country map shrinks to ~200 kB
PUBLIC_SITE = os.environ.get("EARTH_TREND_PUBLIC", "0") == "1"

# ---------------------------------------------------------------- result cache
# The statistics are deterministic for a given region + period, so every result is kept in memory.
# Identical requests that arrive while one is still computing wait for it instead of starting a
# second computation: on a small server (Render free plan) parallel copies made everything hang.
_cache: "OrderedDict[tuple, tuple[int, bytes]]" = OrderedDict()
_inflight: dict = {}
_cache_lock = threading.Lock()
CACHE_MAX = int(os.environ.get("RESULT_CACHE_MAX", "300"))


def _key_part(v):
    return v.model_dump_json() if isinstance(v, BaseModel) else v


def cached(fn):
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        bound = sig.bind(*args, **kwargs)
        bound.apply_defaults()
        key = (fn.__name__,) + tuple((k, _key_part(v)) for k, v in bound.arguments.items())
        while True:
            with _cache_lock:
                hit = _cache.get(key)
                if hit is not None:
                    _cache.move_to_end(key)
                    return Response(content=hit[1], status_code=hit[0], media_type="application/json")
                ev = _inflight.get(key)
                if ev is None:
                    ev = _inflight[key] = threading.Event()
                    break
            ev.wait(timeout=300)  # someone else is computing this exact result
            with _cache_lock:
                if key not in _cache and key not in _inflight:
                    pass  # the other computation failed: loop and compute it ourselves
        try:
            resp = fn(*args, **kwargs)
            with _cache_lock:
                _cache[key] = (resp.status_code, bytes(resp.body))
                while len(_cache) > CACHE_MAX:
                    _cache.popitem(last=False)
            return resp
        finally:
            with _cache_lock:
                _inflight.pop(key, None)
            ev.set()
    return wrapper


def clear_results():
    with _cache_lock:
        _cache.clear()


def clean(o):
    """JSON-safe: NaN/inf -> None, numpy -> python."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if np.isfinite(f) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if hasattr(o, "tolist") and not isinstance(o, str):
        return clean(o.tolist())
    return o


def J(o):
    return JSONResponse(clean(o))


def _parse_exclude(ex: str | None):
    if not ex:
        return None
    out = []
    for part in ex.split(","):
        m = re.fullmatch(r"\s*(\d{4})(?:\s*-\s*(\d{4}))?\s*", part)
        if m:
            out.append((int(m.group(1)), int(m.group(2) or m.group(1))))
    return out or None


def _load(rid):
    giovanni_csv.load_all()  # registers Giovanni boxes as regions
    try:
        return data.region_data(rid)
    except KeyError:
        raise HTTPException(404, f"unknown region {rid}")
    except power.PowerError as e:
        raise HTTPException(502, f"{e}. Is this computer online? For offline testing start with TREND_GLOBE_DEMO=1.")
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")


def _window(df, start, end, exclude):
    d = df
    if start:
        d = d[d.index.year >= int(start)]
    if end:
        d = d[d.index.year <= int(end)]
    for y0, y1 in exclude or []:
        d = d[~((d.index.year >= y0) & (d.index.year <= y1))]
    return d


# ---------------------------------------------------------------- meta & search
@app.get("/api/meta")
def meta():
    gfiles = giovanni_csv.load_all()
    return J(dict(public_site=PUBLIC_SITE, variables=catalog.VARIABLES, categories=catalog.CATEGORY_ORDER, source_note=catalog.SOURCE_NOTE,
                  demo=data.DEMO, presets=[R.public(r) for r in R.presets().values()],
                  giovanni=[{k: g.get(k) for k in ("file", "label", "bbox", "error", "product")} for g in gfiles],
                  power=power.status(), exact_statistics=not TR.MK_FALLBACK))


@app.get("/api/search")
def search(q: str):
    giovanni_csv.load_all()  # registers Giovanni boxes
    return J(R.search(q))


@app.get("/api/region/{rid}")
def region(rid: str):
    try:
        r = R.get(rid)
    except KeyError:
        raise HTTPException(404, rid)
    return J(dict(**R.public(r), points=R.sample_points(r, data.POINT_CAP if r["kind"] == "country" else data.BOX_CAP)))


# ---------------------------------------------------------------- per-variable trends
@app.get("/api/region/{rid}/summary")
@cached
def summary(rid: str, start: int | None = None, end: int | None = None, exclude: str | None = None):
    df, labels, units, pct_ok, info = _load(rid)
    ex = _parse_exclude(exclude)
    res = {}
    for c in df.columns:
        try:
            res[c] = TR.analyse(df[c], start, end, ex, pct_ok.get(c, True))
        except Exception as e:
            res[c] = dict(ok=False, reason=f"{type(e).__name__}: {e}")
    # FDR across the variables of this region, on the stricter of the two main p-values
    keys = [k for k, r in res.items() if r.get("ok")]
    q = TR.bh_fdr([max(res[k]["seasonal_kendall"]["p"], res[k]["hamed_rao"]["p"]) for k in keys])
    for k, qq in zip(keys, q):
        r = res[k]
        r["q"] = float(qq)
        r["verdict"] = TR.verdict(r["seasonal_kendall"]["p"], r["hamed_rao"]["p"], r["ols"]["p_hac"], r["agree"], q=qq)
        if r["verdict"] == "PROVEN":
            r.pop("more_years_needed", None)
        r["sentence"] = N.trend_sentence(labels[k], r, N.unit(units.get(k)), pct_ok.get(k, True))
    for k, r in res.items():
        if not r.get("ok"):
            r["sentence"] = N.trend_sentence(labels.get(k, k), r, "", True)
    span = [r for r in res.values() if r.get("ok")]
    period = f"{min(r['start'][:4] for r in span)}–{max(r['end'][:4] for r in span)}" if span else "–"
    notes = N.case_notes(info["region"], period, res, labels, units, pct_ok, info)
    variables = [dict(id=c, label=labels[c], unit=N.unit(units.get(c)), category=info["categories"].get(c, "Other"),
                      definition=catalog.VARIABLES.get(c, {}).get("definition", "Area-averaged series from your Giovanni file."),
                      giovanni=catalog.VARIABLES.get(c, {}).get("giovanni", ""), stats=res[c]) for c in df.columns]
    return J(dict(region=info["region"], info={k: v for k, v in info.items() if k != "categories"},
                  period=period, variables=variables, notes=notes))


@app.get("/api/region/{rid}/variable/{vid}")
@cached
def variable(rid: str, vid: str, start: int | None = None, end: int | None = None, exclude: str | None = None):
    df, labels, units, pct_ok, info = _load(rid)
    if vid not in df.columns:
        raise HTTPException(404, vid)
    r = TR.analyse(df[vid], start, end, _parse_exclude(exclude), pct_ok.get(vid, True), detail=True)
    if r.get("ok"):
        r["sentence"] = N.trend_sentence(labels[vid], r, N.unit(units.get(vid)), pct_ok.get(vid, True))
    return J(dict(id=vid, label=labels[vid], unit=N.unit(units.get(vid)), stats=r,
                  definition=catalog.VARIABLES.get(vid, {}).get("definition", ""),
                  giovanni=catalog.VARIABLES.get(vid, {}).get("giovanni", "")))


# ---------------------------------------------------------------- relationships
class RelReq(BaseModel):
    vars: list[str]
    method: str = "kendall"
    mode: str = "anomalies"
    lags: bool = False
    start: int | None = None
    end: int | None = None
    exclude: str | None = None


def _label_fn(labels):
    return lambda v: labels.get(v, v)


@app.post("/api/region/{rid}/relations")
@cached
def relations(rid: str, req: RelReq):
    df, labels, units, pct_ok, info = _load(rid)
    if req.method not in REL.METHODS or req.mode not in ("anomalies", "detrended"):
        raise HTTPException(400, "method must be pearson|spearman|kendall, mode anomalies|detrended")
    cols = [v for v in req.vars if v in df.columns]
    if len(cols) < 2:
        raise HTTPException(400, "pick at least two variables")
    d = _window(df, req.start, req.end, _parse_exclude(req.exclude))
    m = REL.matrix(d, cols, req.method, req.mode, with_lags=req.lags)
    lab = _label_fn(labels)
    sentences = []
    for p in sorted(m["pairs"], key=lambda p: -abs(p[req.method]["r"])):
        h = p[req.method]
        sym = {"pearson": "r", "spearman": "ρ", "kendall": "τ"}[req.method]
        sig = h["q"] < TR.ALPHA
        if sig:
            txt = (f"{lab(p['x'])} and {lab(p['y'])} move {'together' if h['r'] > 0 else 'in opposite directions'}: "
                   f"{N.strength(h['r']) if req.method == 'kendall' else ''} {sym} = {h['r']:+.2f}, "
                   f"q {N.fp(h['q'])} (N = {p['n']}, effective N ≈ {p['n_eff']:.0f}).").replace("  ", " ")
        else:
            txt = f"{lab(p['x'])} vs {lab(p['y'])}: no significant link ({sym} = {h['r']:+.2f}, q {N.fp(h['q'])})."
        if req.lags and p.get("lag") and p["lag"]["lag"] != 0 and p["lag"]["p_bonf"] < TR.ALPHA and abs(p["lag"]["r"]) > abs(p["pearson"]["r"]) + 0.03:
            L = p["lag"]["lag"]
            lead, follow = (lab(p["x"]), lab(p["y"])) if L > 0 else (lab(p["y"]), lab(p["x"]))
            txt += f" Strongest when {lead} leads {follow} by {abs(L)} month(s) (r = {p['lag']['r']:+.2f})."
        sentences.append(dict(text=txt, significant=sig, x=p["x"], y=p["y"]))
    return J(dict(**m, labels={c: lab(c) for c in cols}, sentences=sentences))


class RegReq(BaseModel):
    y: str
    xs: list[str]
    mode: str = "anomalies"
    trend: bool = False
    start: int | None = None
    end: int | None = None
    exclude: str | None = None


@app.post("/api/region/{rid}/regression")
@cached
def regression(rid: str, req: RegReq):
    df, labels, *_ = _load(rid)
    xs = [x for x in req.xs if x in df.columns and x != req.y]
    if req.y not in df.columns or not xs:
        raise HTTPException(400, "pick one target and at least one other variable")
    d = _window(df, req.start, req.end, _parse_exclude(req.exclude))
    r = REL.regression(d, req.y, xs, req.mode, req.trend)
    lab = _label_fn(labels)
    if r.get("ok"):
        sig = [c for c in r["coefs"] if c["p"] < TR.ALPHA]
        parts = [f"{lab(c['name'])} ({'+' if c['beta'] > 0 else '−'}{abs(c['beta']):.2f} "
                 f"{'SD per decade' if c['name'] == 'time trend' else 'SD per SD'}, p {N.fp(c['p'])})" for c in sig]
        r["sentence"] = (f"Together the chosen variables explain {100 * r['r2']:.0f} % of the month-to-month variation in "
                         f"{lab(req.y).lower()} (F-test p {N.fp(r['p_F'])}). "
                         + (("Significant on their own, holding the others fixed: " + "; ".join(parts) + ".") if parts
                            else "None is significant on its own once the others are held fixed."))
        hi = [lab(c["name"]) for c in r["coefs"] if c.get("vif") and c["vif"] > 5]
        if hi:
            r["sentence"] += f" Warning: {', '.join(hi)} overlap strongly (VIF > 5), so their separate effects are uncertain."
        r["labels"] = {c: lab(c) for c in [req.y] + xs + ["time trend"]}
    return J(r)


@app.get("/api/region/{rid}/scatter")
@cached
def scatter(rid: str, x: str, y: str, mode: str = "anomalies", start: int | None = None, end: int | None = None):
    df, labels, units, *_ = _load(rid)
    if x not in df.columns or y not in df.columns:
        raise HTTPException(404, "variable")
    d = _window(df, start, end, None)
    return J(dict(**REL.scatter(d, x, y, mode), xl=labels[x], yl=labels[y], xu=N.unit(units.get(x)), yu=N.unit(units.get(y))))


@app.get("/api/region/{rid}/discover")
@cached
def discover(rid: str, start: int | None = None, end: int | None = None, exclude: str | None = None):
    df, labels, *_ = _load(rid)
    d = _window(df, start, end, _parse_exclude(exclude))
    out = REL.discover(d, list(d.columns), catalog.family_of)
    lab = _label_fn(labels)
    for f in out["found"]:
        f["text"] = N.relation_sentence(lab(f["x"]), lab(f["y"]), f)
    out["labels"] = {c: lab(c) for c in d.columns}
    out["summary"] = (f"Tested {out['tests']} variable pairs (all pairs, with and without long-term trends, "
                      f"same-family pairs like max vs mean temperature skipped). {out['total_found']} relationships survive "
                      f"the false-discovery-rate correction.")
    return J(out)


# ---------------------------------------------------------------- region vs region (mirror trends)
class CmpReq(BaseModel):
    a: str
    b: str
    var: str
    start: int | None = None
    end: int | None = None


@app.post("/api/compare")
@cached
def compare(req: CmpReq):
    da, la, ua, pa, ia = _load(req.a)
    db, *_rest, ib = _load(req.b)
    if req.var not in da.columns or req.var not in db.columns:
        raise HTTPException(404, "variable not available in both regions")
    ra = TR.analyse(da[req.var], req.start, req.end, None, pa.get(req.var, True))
    rb = TR.analyse(db[req.var], req.start, req.end, None, pa.get(req.var, True))
    sa, sb = TR.monthly(da[req.var]), TR.monthly(db[req.var])
    diff = (TR.deseasonalise(sa) - TR.deseasonalise(sb)).dropna()
    if req.start:
        diff = diff[diff.index.year >= req.start]
    if req.end:
        diff = diff[diff.index.year <= req.end]
    p_d, _ = TR._hamed_rao(diff.values)
    if len(diff) < 12:
        raise HTTPException(400, "Not enough overlapping months to compare these regions")
    from scipy.stats import theilslopes
    slope_d = float(theilslopes(diff.values, TR.decimal_years(diff.index))[0]) * 10
    u = N.unit(ua.get(req.var))
    u = (" " + u) if u else ""
    opposite = ra.get("ok") and rb.get("ok") and ra["verdict"] == "PROVEN" and rb["verdict"] == "PROVEN" and np.sign(ra["sen_dec"]) != np.sign(rb["sen_dec"])
    txt = (f"{la[req.var]}: {ia['region']['name']} {N.fsigned(ra.get('sen_dec'))}{u}/decade ({ra.get('verdict')}), "
           f"{ib['region']['name']} {N.fsigned(rb.get('sen_dec'))}{u}/decade ({rb.get('verdict')}). "
           f"Difference in trend {N.fsigned(slope_d)}{u}/decade, p {N.fp(p_d)}"
           + (" — the regions trend differently." if p_d < TR.ALPHA else " — no significant difference between the regions."))
    if opposite:
        txt += " MIRROR TREND: the same variable is rising in one region and falling in the other."
    return J(dict(a=ra, b=rb, diff_slope_dec=slope_d, p_diff=p_d, mirror=bool(opposite), text=txt,
                  chart=dict(t=[d.strftime("%Y-%m") for d in diff.index],
                             a=TR._clean(TR.deseasonalise(sa).reindex(diff.index).rolling(12, center=True, min_periods=9).mean().values),
                             b=TR._clean(TR.deseasonalise(sb).reindex(diff.index).rolling(12, center=True, min_periods=9).mean().values)),
                  names=[ia["region"]["name"], ib["region"]["name"]]))


# ---------------------------------------------------------------- globe scan (one variable, every country)
_scan = dict(running=False, var=None, done=0, total=0, results={}, started=None, error=None)


def _scan_job(var, start, end):
    cs = list(R.countries().values())
    _scan.update(running=True, var=var, done=0, total=len(cs), results={}, started=time.time(), error=None)
    raw = {}
    for c in cs:
        if not _scan["running"]:
            break
        try:
            df, labels, units, pct_ok, info = data.region_data(c["id"])
            if var in df.columns:
                r = TR.analyse(df[var], start, end, None, pct_ok.get(var, True))
                if r.get("ok"):
                    raw[c["id"]] = r
                    _scan["results"][c["id"]] = dict(name=c["name"], sen_dec=r["sen_dec"], verdict=r["verdict"],
                                                     p=max(r["seasonal_kendall"]["p"], r["hamed_rao"]["p"]))
        except Exception as e:
            _scan["error"] = f"{c['name']}: {e}"
        _scan["done"] += 1
    keys = list(raw)
    q = TR.bh_fdr([_scan["results"][k]["p"] for k in keys])
    for k, qq in zip(keys, q):
        r = raw[k]
        _scan["results"][k]["q"] = float(qq)
        _scan["results"][k]["verdict"] = TR.verdict(r["seasonal_kendall"]["p"], r["hamed_rao"]["p"], r["ols"]["p_hac"], r["agree"], q=qq)
    _scan["running"] = False


class ScanReq(BaseModel):
    var: str = "T2M"
    start: int | None = None
    end: int | None = None


@app.post("/api/scan")
def scan(req: ScanReq):
    if PUBLIC_SITE:
        raise HTTPException(403, "Globe-wide scans are available in the local app.")
    if _scan["running"]:
        return J(dict(started=False, message="a scan is already running"))
    _scan.update(running=True, var=req.var, done=0, total=len(R.countries()), results={}, error=None)  # visible at once
    threading.Thread(target=_scan_job, args=(req.var, req.start, req.end), daemon=True).start()
    return J(dict(started=True))


@app.post("/api/scan/stop")
def scan_stop():
    if PUBLIC_SITE:
        raise HTTPException(403, "Globe-wide scans are available in the local app.")
    _scan["running"] = False
    return J(dict(stopped=True))


@app.get("/api/scan/status")
def scan_status():
    return J({k: v for k, v in _scan.items()})


# ---------------------------------------------------------------- Giovanni upload
@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if PUBLIC_SITE:
        raise HTTPException(403, "CSV uploads are available in the local app.")
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(file.filename or "giovanni.csv").name)
    if not name.lower().endswith(".csv"):
        raise HTTPException(400, "upload a Giovanni .csv file")
    dest = giovanni_csv.GDIR / name
    giovanni_csv.GDIR.mkdir(parents=True, exist_ok=True)
    content = await file.read(12 * 1024 * 1024 + 1)
    if len(content) > 12 * 1024 * 1024:
        raise HTTPException(413, "CSV is too large (12 MB maximum)")
    dest.write_bytes(content)
    try:
        g = giovanni_csv.parse(dest)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, str(e))
    data.clear()
    clear_results()
    w, s, e, n = g["bbox"] if g["bbox"] else (None,) * 4
    rid = f"g-{w:g}_{s:g}_{e:g}_{n:g}" if g["bbox"] else None
    giovanni_csv.load_all()
    return J(dict(file=name, label=g["label"], bbox=g["bbox"], months=int(g["series"].notna().sum()), region_id=rid))


# ---------------------------------------------------------------- frontend
app.mount("/static", StaticFiles(directory=FRONT), name="static")


@app.get("/geo/countries-50m.json")
def geo_detailed():
    return FileResponse(R.DATA / "countries-50m.json")


@app.get("/geo/countries-110m.json")
def geo():
    return FileResponse(ROOT / "data" / "countries-110m.json", media_type="application/json")


@app.get("/health")
def health():
    return {"status": "ok", "warm": _warm["done"], "cached_results": len(_cache)}


# ---------------------------------------------------------------- globe highlights
HIGHLIGHT_VARS = ("RootMoist",)  # the study's headline variable: root-zone soil moisture


@app.get("/api/highlights")
@cached
def highlights():
    """Soil-moisture trend for every bundled Giovanni study box, for the markers on the globe."""
    import json
    out, seen = [], set()
    for g in giovanni_csv.load_all():
        b = g.get("bbox")
        if not b or g.get("series") is None or not any(v in g.get("id", "") for v in HIGHLIGHT_VARS):
            continue
        rid = f"g-{b[0]:g}_{b[1]:g}_{b[2]:g}_{b[3]:g}"
        if rid in seen:
            continue
        seen.add(rid)
        try:
            sm = json.loads(summary(rid=rid).body)
        except Exception:
            continue
        v = next((x for x in sm["variables"] if any(h in x["id"] for h in HIGHLIGHT_VARS)), None)
        if not v or not v["stats"].get("ok"):
            continue
        st = v["stats"]
        out.append(dict(id=rid, name=sm["region"]["name"], bbox=b, lat=(b[1] + b[3]) / 2, lng=(b[0] + b[2]) / 2,
                        variable=v["label"], pct=st.get("pct"), sen_dec=st["sen_dec"], unit=v["unit"],
                        verdict=st["verdict"], period=f"{st['start'][:4]}–{st['end'][:4]}"))
    return J(dict(variable="Root-zone soil moisture", source="NASA GLDAS Noah v2.1 via Giovanni", items=out))


# ---------------------------------------------------------------- warm-up
# Precompute the bundled study areas right after start-up, so the demo buttons answer at once
# even on a slow free server that has just woken up.
_warm = {"done": False}


def _warm_up():
    try:
        seen = set()
        for g in giovanni_csv.load_all():
            b = g.get("bbox")
            if not b or g.get("series") is None:
                continue
            rid = f"g-{b[0]:g}_{b[1]:g}_{b[2]:g}_{b[3]:g}"
            if rid in seen:
                continue
            seen.add(rid)
            try:
                summary(rid=rid)
                df = data.region_data(rid)[0]
                for vid in df.columns:
                    variable(rid=rid, vid=vid)
            except Exception as e:  # never let warm-up break the site
                print(f"warm-up {rid}: {type(e).__name__}: {e}")
        highlights()
    finally:
        _warm["done"] = True


@app.on_event("startup")
def _start_warm_up():
    if os.environ.get("WARM_UP", "1") == "1":
        threading.Thread(target=_warm_up, daemon=True).start()


@app.get("/")
def index():
    return FileResponse(FRONT / "index.html")
