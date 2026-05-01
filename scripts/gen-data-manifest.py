#!/usr/bin/env python3
"""Scan project2/data for PsychoPy LDT CSVs and write report/data-manifest.json."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = ROOT / "report" / "data-manifest.json"
PATTERN = re.compile(r"^.+\.csv$", re.I)


def main() -> None:
    files = sorted(p.name for p in DATA.iterdir() if p.is_file() and PATTERN.match(p.name))
    rel = ["../data/" + name for name in files]
    OUT.write_text(json.dumps({"files": rel}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(rel)} paths to {OUT}")


if __name__ == "__main__":
    main()
