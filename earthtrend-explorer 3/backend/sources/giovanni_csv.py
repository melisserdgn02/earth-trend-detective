"""Giovanni 'Time Series, Area-Averaged' CSVs -> monthly series attached to regions.

Drop the CSVs into data/giovanni/ (or upload them in the app). The parser reads the
metadata header Giovanni writes above the data (Title, Bounding Box, Fill Value) and the
'time,<column>' table. Each file:
  * becomes its own variable (id 'G:<column>'), shown in the region whose area matches;
  * registers its bounding box as a region "Giovanni box W,S,E,N", so the exact box the
    team used in Giovanni can be searched and analysed.
Daily or hourly files are averaged to monthly means.
"""
from __future__ import annotations
import re
from pathlib import Path

import numpy as np
import pandas as pd

from .. import regions as R

GDIR = Path(__file__).resolve().parents[2] / "data" / "giovanni"
_cache: dict = {}


def _nums(s):
    return [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", s)]


def _bbox_from_name(name):
    m = re.search(r"(\d+(?:p\d+)?)([EW])_(\d+(?:p\d+)?)([NS])_(\d+(?:p\d+)?)([EW])_(\d+(?:p\d+)?)([NS])", name)
    if not m:
        return None
    g = m.groups()

    def v(num, hemi):
        x = float(num.replace("p", "."))
        return -x if hemi in "WS" else x
    return (v(g[0], g[1]), v(g[2], g[3]), v(g[4], g[5]), v(g[6], g[7]))


def parse(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    head, start = {}, None
    for i, l in enumerate(lines):
        low = l.lower()
        if re.match(r"^\s*time\s*,", low):
            start = i
            break
        if ":" in l:
            k, _, v = l.partition(":")
            head[k.strip().lower()] = v.strip().strip(",").strip('"')
    if start is None:
        raise ValueError(f"{path.name}: no 'time,...' table found — is this a Giovanni area-averaged CSV?")
    col = lines[start].split(",")[1].strip()
    fill = None
    for k, v in head.items():
        if k.startswith("fill value"):
            n = _nums(v)
            fill = n[0] if n else None
    rows = []
    for l in lines[start + 1:]:
        parts = l.split(",")
        if len(parts) < 2 or not parts[0].strip():
            continue
        try:
            val = float(parts[1])
        except ValueError:
            continue
        rows.append((parts[0].strip()[:19], val))
    if not rows:
        raise ValueError(f"{path.name}: table is empty")
    s = pd.Series([v for _, v in rows], index=pd.to_datetime([t for t, _ in rows], utc=False, format="mixed"))
    if fill is not None:
        s = s.where(np.abs(s) < abs(fill) * 0.999)
    s = s.where(np.abs(s) < 1e14)
    s.index = s.index.tz_localize(None) if getattr(s.index, "tz", None) else s.index
    s = s.groupby(s.index.to_period("M")).mean()
    s.index = s.index.to_timestamp()
    bbox = None
    for key in ("user bounding box", "bounding box", "data bounding box"):
        values = _nums(head.get(key, ""))
        if len(values) >= 4:
            bbox = tuple(values[:4])
            break
    bbox = bbox or _bbox_from_name(path.name)
    title = head.get("title", "")
    label = col
    m = re.search(r"Area-Averaged of (.+?)(?: (?:monthly|daily|hourly|3-hourly)\b|\s\[|$)", title)
    if m:
        label = m.group(1).strip()
    unit = ""
    mu = re.search(r"\]\s*([^\[\]]+?)\s+over\s", title)
    if mu:
        unit = mu.group(1).strip()
    # Some Giovanni titles omit units. The original product and field identify
    # the four MERRA-2 series bundled with the application.
    merra_fields = {
        "mean_M2TMNXSLV_5_12_4_T2M": ("Air temperature at 2 m", "K", 1),
        "mean_M2TMNXAER_5_12_4_DUSMASS": ("Surface dust", "µg/m³", 1e9),
        "mean_M2TMNXAER_5_12_4_TOTEXTTAU": ("Aerosol optical depth", "1", 1),
        "mean_M2TMNXRAD_5_12_4_SWGDNCLR": ("Clear-sky sunlight", "W/m²", 1),
    }
    if not unit and col in merra_fields:
        label, unit, scale = merra_fields[col]
        s = s * scale
    prod = re.search(r"\[([^\]]+)\]", title)
    return dict(id="G:" + col, column=col, label=label + " (Giovanni)", unit=unit, bbox=bbox, file=path.name,
                product=prod.group(1) if prod else "", series=s.astype(float))


def load_all() -> list[dict]:
    out = []
    if not GDIR.exists():
        return out
    for p in sorted(GDIR.glob("*.csv")):
        key = (p.name, p.stat().st_mtime)
        if key not in _cache:
            try:
                _cache[key] = parse(p)
            except Exception as e:  # keep going, report in the UI
                _cache[key] = dict(error=str(e), file=p.name)
        g = _cache[key]
        out.append(g)
        if "bbox" in g and g["bbox"]:
            w, s, e, n = g["bbox"]
            try:
                # use the study-area name when the box is one of our presets
                named = next((k for k, b in R.PRESETS.items() if all(abs(x - y) < 1e-6 for x, y in zip(b, g["bbox"]))), None)
                R.register(R.box_region(g["bbox"], name=named or f"Giovanni box {w:g},{s:g},{e:g},{n:g}",
                                        rid=f"g-{w:g}_{s:g}_{e:g}_{n:g}"))
            except ValueError:
                pass
    return out


def _overlap(a, b):
    w, s = max(a[0], b[0]), max(a[1], b[1])
    e, n = min(a[2], b[2]), min(a[3], b[3])
    if e <= w or n <= s:
        return 0.0
    inter = (e - w) * (n - s)
    return inter / min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))


def _iou(a, b):
    w, s = max(a[0], b[0]), max(a[1], b[1])
    e, n = min(a[2], b[2]), min(a[3], b[3])
    if e <= w or n <= s:
        return 0.0
    inter = (e - w) * (n - s)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union


def for_region(region: dict) -> list[dict]:
    """Giovanni files whose box matches the region: same box, or box centre inside the region
    and boxes overlapping by at least half of the smaller one."""
    hits = []
    for g in load_all():
        if not g.get("bbox"):
            continue
        b = g["bbox"]
        same = all(abs(x - y) < 0.3 for x, y in zip(b, region["bbox"]))
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if same:
            hits.append(g)
        elif region.get("kind") == "country":
            # a country shows Giovanni boxes that lie mostly inside it
            if bool(R.inside(region, [cx], [cy])[0]) and _overlap(b, region["bbox"]) >= 0.5:
                hits.append(g)
        elif _iou(b, region["bbox"]) >= 0.5:
            # boxes must cover nearly the same area, so a small study box never
            # inherits the series of a much larger box around it (or vice versa)
            hits.append(g)
    return hits
