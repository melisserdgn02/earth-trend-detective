"""API smoke test on SYNTHETIC data (no internet needed).   python tests/test_api.py"""
import os
import sys
import shutil
import time
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest.mock import patch

os.environ["TREND_GLOBE_DEMO"] = "1"
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient  # noqa: E402
from backend.app import TR, app  # noqa: E402
from backend.sources import giovanni_csv  # noqa: E402

test_uploads = TemporaryDirectory()
giovanni_csv.GDIR = Path(test_uploads.name)
c = TestClient(app)
fails = 0


def check(name, cond, detail=""):
    global fails
    print(f"{'PASS' if cond else 'FAIL'}  {name} {detail}")
    fails += 0 if cond else 1


r = c.get("/api/meta"); check("meta", r.status_code == 200 and r.json()["demo"] is True)
r = c.get("/api/search?q=spa"); check("search country", r.json()[0]["id"] == "c-spain")
r = c.get("/api/search?q=40.4, -3.7"); check("search point", r.json()[0]["kind"] == "point")
r = c.get("/api/search?q=-9,36,3,43"); check("search box", r.json()[0]["id"] == "x--9_36_3_43")
r = c.get("/api/search?q=usa"); check("search alias", r.json()[0]["name"] == "United States of America")
r = c.get("/api/region/c-hungary"); check("region points", r.status_code == 200 and 1 <= len(r.json()["points"]) <= 8, str(r.json()["points"]))

t = time.time(); r = c.get("/api/region/c-hungary/summary"); j = r.json()
check("summary", r.status_code == 200 and len(j["variables"]) == 16, f"{len(j['variables'])} variables in {time.time() - t:.1f}s")
check("summary verdicts", all(v["stats"]["verdict"] in ("PROVEN", "SUSPICIOUS", "NO TREND") for v in j["variables"]))
check("synthetic flagged", j["info"]["synthetic"] is True and any("SYNTHETIC" in x for x in j["notes"]["caveats"]))
with patch.object(TR, "analyse", wraps=TR.analyse) as analyse:
    repeat = c.get("/api/region/c-hungary/summary")
    check("repeat summary reuses trend calculations", repeat.status_code == 200 and repeat.json() == j and not analyse.called)
r = c.get("/api/region/c-hungary/summary?start=1995&end=2020&exclude=2003,2010-2011")
check("period + exclude", r.status_code == 200 and r.json()["period"] == "1995–2020")
r = c.get("/api/region/c-hungary/summary?start=2022")
check("too-short period handled", r.status_code == 200 and all(not v["stats"]["ok"] for v in r.json()["variables"]))
r = c.get("/api/region/c-hungary/variable/T2M"); check("detail", r.status_code == 200 and len(r.json()["stats"]["chart"]["t"]) > 500)
with patch.object(TR, "analyse", wraps=TR.analyse) as analyse:
    repeat = c.get("/api/region/c-hungary/variable/T2M")
    check("repeat detail reuses chart calculations", repeat.status_code == 200 and repeat.json() == r.json() and not analyse.called)
r = c.post("/api/region/c-hungary/relations", json=dict(vars=["T2M", "GWETROOT", "PRECTOTCORR"], method="spearman", mode="detrended", lags=True))
check("relations", r.status_code == 200 and r.json()["tests"] == 3)
r = c.post("/api/region/c-hungary/relations", json=dict(vars=["T2M"])); check("relations needs 2 vars", r.status_code == 400)
r = c.post("/api/region/c-hungary/regression", json=dict(y="GWETROOT", xs=["T2M", "PRECTOTCORR"], trend=True))
check("regression", r.status_code == 200 and r.json()["ok"] and len(r.json()["coefs"]) == 3)
r = c.get("/api/region/c-hungary/discover"); check("discover", r.status_code == 200 and r.json()["tests"] > 100, r.json()["summary"][:90])
r = c.post("/api/compare", json=dict(a="c-hungary", b="c-nigeria", var="AOD_55")); check("compare / mirror", r.status_code == 200 and r.json()["mirror"], r.json()["text"][:120])
r = c.get("/api/region/c-nowhere/summary"); check("unknown region 404", r.status_code == 404)

# Giovanni upload -> new region + extra variable
fx = ROOT / "tests" / "fixtures" / "g4.areaAvgTimeSeries.M2TMNXSLV_5_12_4_T2M.19800101-19891231.16E_45N_23E_48N.csv"
preset_url = "/api/region/b-carpathian-basin-hungary-box/summary"
before_upload = c.get(preset_url).json()
r = c.post("/api/upload", files={"file": (fx.name, fx.read_bytes(), "text/csv")})
ok = r.status_code == 200
check("upload Giovanni CSV", ok, str(r.json()))
if ok:
    rid = r.json()["region_id"]
    j = c.get(f"/api/region/{rid}/summary").json()
    g = [v for v in j["variables"] if v["id"].startswith("G:")]
    check("Giovanni variable in its box", len(g) == 1 and g[0]["unit"] == "°C", f"{rid}: {g[0]['label'] if g else None} [{g[0]['unit'] if g else ''}]")
    j = c.get(preset_url).json()
    check("Giovanni variable also in matching preset", any(v["id"].startswith("G:") for v in j["variables"]))
    check("upload refreshes cached preset", fx.name not in before_upload["info"]["giovanni_files"] and fx.name in j["info"]["giovanni_files"])
    (giovanni_csv.GDIR / fx.name).unlink()
r = c.post("/api/upload", files={"file": ("x.csv", b"hello,world\n1,2\n", "text/csv")}); check("bad CSV rejected", r.status_code == 400)

print("\nALL PASS" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
