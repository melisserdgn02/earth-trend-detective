"""Regions: 242 countries (Natural Earth via world-atlas), named study boxes, and custom input.

A region is a dict: id, name, kind (country|box|point), bbox (W,S,E,N), polys (list of
rings, each an (n,2) array of lon/lat; empty for boxes).
"""
from __future__ import annotations
import json
import re
from functools import lru_cache
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parents[1] / "data"

# Named study boxes (W, S, E, N), Giovanni order. Team cases first.
PRESETS = {
    "Carpathian Basin (Hungary box)": (16.0, 45.0, 23.0, 48.5),
    "Homokhátság (Great Hungarian Plain)": (19.0, 46.0, 20.5, 47.3),
    "Iberian Peninsula box": (-9.0, 36.0, 3.0, 43.0),
    "Upper Danube basin": (8.0, 46.0, 17.0, 50.0),
    "Po Valley": (7.0, 44.5, 13.0, 46.0),
    "Sahel": (-17.0, 12.0, 35.0, 18.0),
    "Indo-Gangetic Plain": (75.0, 24.0, 88.0, 31.0),
    "North China Plain": (113.0, 34.0, 120.0, 40.0),
    "Amazon basin core": (-75.0, -15.0, -45.0, 5.0),
    "California Central Valley": (-122.5, 35.0, -119.0, 40.0),
    "Lake Urmia basin": (44.0, 36.5, 47.0, 38.5),
    "Aral Sea basin": (58.0, 43.0, 62.0, 47.0),
    "Sahara (central)": (-5.0, 20.0, 25.0, 30.0),
    "Greenland west coast": (-55.0, 64.0, -48.0, 72.0),
}

ALIASES = {
    "homokhatsag": "Homokhátság (Great Hungarian Plain)", "great hungarian plain": "Homokhátság (Great Hungarian Plain)",
    "hungary's hidden desert": "Homokhátság (Great Hungarian Plain)",
    "usa": "United States of America", "us": "United States of America", "united states": "United States of America",
    "america": "United States of America", "uk": "United Kingdom", "great britain": "United Kingdom",
    "england": "United Kingdom", "czech republic": "Czechia", "russia": "Russia", "korea": "South Korea",
    "south korea": "South Korea", "republic of korea": "South Korea", "north korea": "North Korea",
    "drc": "Dem. Rep. Congo", "congo": "Congo", "ivory coast": "Côte d'Ivoire", "holland": "Netherlands",
    "uae": "United Arab Emirates", "bosnia": "Bosnia and Herz.", "turkiye": "Turkey", "türkiye": "Turkey",
    "deutschland": "Germany", "espana": "Spain", "españa": "Spain", "magyarorszag": "Hungary",
}


def _decode_topojson(topo: dict, obj: str):
    """Minimal TopoJSON -> list of (name, id, [rings]) with lon/lat rings."""
    tf = topo.get("transform")
    arcs = []
    for arc in topo["arcs"]:
        a = np.array(arc, float)
        if tf:
            a = np.cumsum(a, axis=0) * tf["scale"] + tf["translate"]
        arcs.append(a)

    def arc_pts(i):
        return arcs[i] if i >= 0 else arcs[~i][::-1]

    def ring(idx):
        parts = [arc_pts(i) if k == 0 else arc_pts(i)[1:] for k, i in enumerate(idx)]
        return np.vstack(parts)

    out = []
    for g in topo["objects"][obj]["geometries"]:
        rings = []
        if g.get("type") == "Polygon":
            rings = [ring(r) for r in g["arcs"]]
        elif g.get("type") == "MultiPolygon":
            rings = [ring(r) for poly in g["arcs"] for r in poly]
        if rings:
            out.append((g.get("properties", {}).get("name", "?"), str(g.get("id", "")), rings))
    return out


def _bbox(rings):
    allp = np.vstack(rings)
    return (float(allp[:, 0].min()), float(allp[:, 1].min()), float(allp[:, 0].max()), float(allp[:, 1].max()))


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


@lru_cache(maxsize=1)
def countries() -> dict:
    topo = json.loads((DATA / "countries-50m.json").read_text(encoding="utf-8"))
    out = {}
    for name, iso, rings in _decode_topojson(topo, "countries"):
        rid = "c-" + slug(name)
        if rid in out:  # merge duplicate names
            out[rid]["polys"] += rings
            out[rid]["bbox"] = _bbox(out[rid]["polys"])
            continue
        out[rid] = dict(id=rid, name=name, kind="country", iso=iso, bbox=_bbox(rings), polys=rings)
    return out


def presets() -> dict:
    return {"b-" + slug(n): box_region(b, n, rid="b-" + slug(n)) for n, b in PRESETS.items()}


def box_region(b, name=None, rid=None, kind="box"):
    w, s, e, n = map(float, b)
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise ValueError("box must be W,S,E,N with W<E and S<N, inside -180..180 / -90..90")
    name = name or f"Box {w:g},{s:g},{e:g},{n:g}"
    return dict(id=rid or f"x-{w:g}_{s:g}_{e:g}_{n:g}", name=name, kind=kind, bbox=(w, s, e, n), polys=[])


_extra: dict = {}  # regions created at runtime (Giovanni boxes, custom input)


def register(region: dict):
    _extra[region["id"]] = region


def all_regions() -> dict:
    return {**countries(), **presets(), **_extra}


def get(rid: str) -> dict:
    regs = all_regions()
    if rid in regs:
        return regs[rid]
    m = re.fullmatch(r"x-(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)", rid)
    if m:
        r = box_region([float(v) for v in m.groups()])
        register(r)
        return r
    raise KeyError(rid)


def parse_custom(q: str):
    """'40.4, -3.7' -> 2°x2° box around a point;  '-9,36,3,43' -> W,S,E,N box."""
    nums = re.findall(r"-?\d+(?:\.\d+)?", q)
    if not re.fullmatch(r"[\s\d.,;:\-a-zA-Z°]*", q) or len(nums) not in (2, 4):
        return None
    v = [float(x) for x in nums]
    try:
        if len(v) == 2:
            lat, lon = v
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                return None
            b = (max(-180, lon - 1), max(-90, lat - 1), min(180, lon + 1), min(90, lat + 1))
            r = box_region(b, name=f"Around {lat:g}°, {lon:g}°")
            r["kind"] = "point"
            return r
        return box_region(v)
    except ValueError:
        return None


def search(q: str, limit=12):
    q0 = q.strip()
    ql = q0.lower()
    if not ql:
        return []
    custom = parse_custom(q0)
    hits = []
    if custom:
        register(custom)
        hits.append((0, custom))
    target = ALIASES.get(ql)
    for r in all_regions().values():
        if custom and r["id"] == custom["id"]:
            continue
        n = r["name"].lower()
        if target and r["name"] == target:
            score = 0
        elif n == ql:
            score = 0
        elif n.startswith(ql):
            score = 1
        elif any(w.startswith(ql) for w in re.split(r"[\s(),.-]+", n)):
            score = 2
        elif ql in n:
            score = 3
        else:
            continue
        hits.append((score + (0.5 if r["kind"] != "country" else 0), r))
    hits.sort(key=lambda t: (t[0], t[1]["name"]))
    return [public(r) for _, r in hits[:limit]]


def public(r: dict) -> dict:
    return {k: r[k] for k in ("id", "name", "kind", "bbox")}


# ---------------------------------------------------------------- geometry
def _inside(lon, lat, ring):
    x, y = ring[:, 0], ring[:, 1]
    x2, y2 = np.roll(x, -1), np.roll(y, -1)
    result = np.zeros(len(lon), dtype=bool)
    # A regular grid uses the same latitude for many longitudes. Calculate the
    # crossings once per latitude to avoid a dense points-by-edges matrix.
    order = np.argsort(lat)
    sorted_lat = lat[order]
    latitudes, starts = np.unique(sorted_lat, return_index=True)
    stops = np.r_[starts[1:], len(order)]
    for latitude, start, stop in zip(latitudes, starts, stops):
        edges = (y > latitude) != (y2 > latitude)
        if edges.any():
            crossings = x[edges] + (x2[edges] - x[edges]) * (latitude - y[edges]) / (y2[edges] - y[edges])
            indices = order[start:stop]
            left = np.searchsorted(np.sort(crossings), lon[indices], side="right")
            result[indices] = (len(crossings) - left) % 2 == 1
    return result


def inside(region, lon, lat):
    lon, lat = np.atleast_1d(lon).astype(float), np.atleast_1d(lat).astype(float)
    if not region["polys"]:
        w, s, e, n = region["bbox"]
        return (lon >= w) & (lon <= e) & (lat >= s) & (lat <= n)
    res = np.zeros(len(lon), bool)
    for ring in region["polys"]:  # even-odd over all rings handles holes
        res ^= _inside(lon, lat, ring)
    return res


SPACINGS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25]


def sample_points(region, cap=8):
    """Regular grid points (snapped to 0.5°) inside the region, as many as possible up to cap.
    Tiny regions get their single most central point. Returns list of (lat, lon)."""
    w, s, e, n = region["bbox"]
    best = None
    for d in SPACINGS:
        lons = np.arange(np.ceil(w / d) * d, e + 1e-9, d)
        lats = np.arange(np.ceil(s / d) * d, n + 1e-9, d)
        if len(lons) * len(lats) > 200_000:
            continue
        LO, LA = np.meshgrid(lons, lats)
        LO, LA = LO.ravel(), LA.ravel()
        m = inside(region, LO, LA)
        pts = [(float(a), float(b)) for a, b in zip(np.round(LA[m] * 2) / 2, np.round(LO[m] * 2) / 2)]
        pts = sorted(set(pts))
        if 0 < len(pts) <= cap:
            best = pts
            break
        if len(pts) == 0:
            break
    if not best:
        # centre of the largest ring's points that fall inside, else bbox centre
        ring = max(region["polys"], key=len) if region["polys"] else None
        if ring is not None:
            c = ring.mean(axis=0)
            best = [(float(round(c[1] * 2) / 2), float(round(c[0] * 2) / 2))]
        else:
            best = [(float(round((s + n) / 2 * 2) / 2), float(round((w + e) / 2 * 2) / 2))]
    return best


def geojson_countries(simplified=True) -> dict:
    """Low-res outlines for the globe (frontend renders from the 110m TopoJSON itself)."""
    return json.loads((DATA / ("countries-110m.json" if simplified else "countries-50m.json")).read_text(encoding="utf-8"))
