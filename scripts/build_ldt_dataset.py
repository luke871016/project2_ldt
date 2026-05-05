#!/usr/bin/env python3
"""
將 data-manifest.json 所列之 PsychoPy LDT CSV 合併為單一 JSON，供 report 一次 fetch。

輸出格式與 ldt-report.js 的「合併資料集」讀取邏輯一致；僅保留統計所需欄位以縮小體積。

用法（在專案目錄 project2 下）：
  python3 scripts/build_ldt_dataset.py
  python3 scripts/build_ldt_dataset.py --pretty
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

# 與 report/ldt-report.js 中 processOneFile / rowToTrialObject 所用欄位對齊
KEEP_COLS: frozenset[str] = frozenset(
    {
        "thanksroutine.started",
        "participant",
        "性別",
        "年齡",
        "台語檢定成績",
        "trialloop.ran",
        "trialroutine.started",
        "trialroutine.stopped",
        "trialkeyboard.keys",
        "trialkeyboard.rt",
        "trialkeyboard.corr",
        "trialloop.thisN",
        "trialloop.thisIndex",
        "漢字",
        "臺羅",
        "台羅",
        "分組",
        "isword",
        "台語詞頻分組",
        "華語詞頻分組",
        "ifile",
    }
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "report" / "data-manifest.json"
DEFAULT_OUTPUT = ROOT / "report" / "ldt-dataset.json"
BUNDLE_FORMAT = "ldt-report-bundle"
BUNDLE_VERSION = 1


def _row_effectively_empty(row: dict[str, str]) -> bool:
    return not any((v or "").strip() for v in row.values())


def _prune_row(row: dict[str, str | None], active_cols: frozenset[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k in active_cols:
        if k not in row:
            continue
        v = row[k]
        out[k] = "" if v is None else str(v)
    return out


def _read_csv_rows(path: Path, project_root: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise FileNotFoundError(path)

    rows: list[dict[str, str]] = []
    rel_disp = path.resolve().relative_to(project_root.resolve())

    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            return rows
        header = frozenset(reader.fieldnames)
        active = KEEP_COLS & header
        if not active:
            raise ValueError(f"{rel_disp}：CSV 標頭與預期欄位無交集")

        for raw in reader:
            pr = _prune_row(raw, active)
            if not _row_effectively_empty(pr):
                rows.append(pr)

    return rows


def _resolve_csv_path(rel: str, report_dir: Path, project_root: Path) -> Path:
    """manifest 中路徑係相對於 report/（與瀏覽器 fetch 一致）。"""
    p = (report_dir / rel).resolve()
    root = project_root.resolve()
    try:
        p.relative_to(root)
    except ValueError as e:
        raise ValueError(f"路徑必須落在專案根目錄內：{rel!r}") from e
    return p


def main() -> int:
    ap = argparse.ArgumentParser(description="合併 LDT CSV 為 ldt-dataset.json")
    ap.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help=f"清單 JSON（預設：{DEFAULT_MANIFEST.relative_to(ROOT)})",
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"輸出路徑（預設：{DEFAULT_OUTPUT.relative_to(ROOT)})",
    )
    ap.add_argument(
        "--pretty",
        action="store_true",
        help="輸出縮排 JSON（較大，便於檢視）",
    )
    args = ap.parse_args()

    manifest_path: Path = args.manifest.resolve()
    output_path: Path = args.output.resolve()
    report_dir = manifest_path.parent

    if not manifest_path.is_file():
        print(f"找不到 manifest：{manifest_path}", file=sys.stderr)
        return 1

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"無法解析 manifest：{e}", file=sys.stderr)
        return 1

    rel_paths = manifest.get("files")
    if not isinstance(rel_paths, list):
        print("manifest 缺少 files 陣列", file=sys.stderr)
        return 1

    bundle_files: list[dict[str, object]] = []
    for i, rel in enumerate(rel_paths):
        if not isinstance(rel, str):
            print(f"files[{i}] 必須為字串路徑", file=sys.stderr)
            return 1
        csv_path = _resolve_csv_path(rel, report_dir, ROOT)
        try:
            rows = _read_csv_rows(csv_path, ROOT)
        except (OSError, ValueError) as e:
            print(f"{rel}: {e}", file=sys.stderr)
            return 1
        bundle_files.append({"sourcePath": rel, "rows": rows})

    payload = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "generatedFrom": manifest_path.name,
        "files": bundle_files,
    }

    if args.pretty:
        text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    else:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(text, encoding="utf-8")

    print(
        f"已寫入 {len(bundle_files)} 個受試者資料 → {output_path} "
        f"（約 {output_path.stat().st_size // 1024} KiB）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
