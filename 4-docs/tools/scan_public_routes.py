"""
Public routes 扫描脚本（非破坏性）

用途：
- 基于 `4-docs/BACKEND_PUBLIC_ROUTES.csv` 枚举 public routes
- 在本地/compose 环境对路由进行“可达性 + 状态码”检查
- 默认使用 OPTIONS 请求，避免对 POST/PUT/DELETE 产生副作用

使用示例：
  python 4-docs/tools/scan_public_routes.py --base-url http://localhost:8000 --out 4-docs/public_routes_scan_results.csv

说明：
- 该脚本不负责启动服务；请先按 runbook 启动 compose
- 很多接口需要认证：未带 token 时，返回 401/403 也视为“路由存在”
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Tuple


DEFAULT_ROUTES_CSV = Path("4-docs/BACKEND_PUBLIC_ROUTES.csv")

# 这些接口按合同应为 410（弃用）
EXPECTED_410_PATHS = {
    "/api/plugin-api/quotas/shared-pool",
    "/api/plugin-api/quotas/consumption",
    "/api/plugin-api/preference",  # PUT（弃用）
}


@dataclass(frozen=True)
class RouteSpec:
    source: str
    method: str
    path: str


def _parse_route_spec(raw: str) -> Optional[RouteSpec]:
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    parts = text.split(maxsplit=1)
    if len(parts) != 2:
        return None
    method, path = parts[0].strip().upper(), parts[1].strip()
    if not method or not path.startswith("/"):
        return None
    return RouteSpec(source=text, method=method, path=path)


_PLACEHOLDER_RE = re.compile(r"\{([^}]+)\}")


def _substitute_path_params(path: str) -> str:
    """
    将 `/foo/{id}/bar/{model}` 里的 `{...}` 替换为“尽量合法”的占位值。
    目的：避免 404（路由不存在）与“参数缺失”，允许 401/403/405/422 等作为“可达性”证据。
    """

    def repl(match: re.Match[str]) -> str:
        name = (match.group(1) or "").strip().lower()
        if "model" in name:
            return "gemini-2.5-pro"
        if "cookie" in name:
            return "00000000-0000-0000-0000-000000000000"
        if name.endswith("_id") or name == "id" or "key" in name:
            return "1"
        return "1"

    return _PLACEHOLDER_RE.sub(repl, path)


def _iter_public_routes(csv_path: Path) -> Iterable[RouteSpec]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header:
            return
        for row in reader:
            if not row:
                continue
            spec = _parse_route_spec(row[0])
            if spec is None:
                continue
            yield spec


def _build_url(base_url: str, path: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    return f"{base}{path}"


def _request_once(
    *,
    url: str,
    method: str,
    token: Optional[str],
    timeout_seconds: float,
) -> Tuple[Optional[int], Optional[str]]:
    headers = {"User-Agent": "antihub-public-routes-scan/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            return int(getattr(resp, "status", None) or 0) or None, None
    except urllib.error.HTTPError as e:
        return int(getattr(e, "code", None) or 0) or None, None
    except urllib.error.URLError as e:
        return None, str(e.reason) if hasattr(e, "reason") else str(e)
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def _is_reachable(status_code: Optional[int]) -> bool:
    if status_code is None:
        return False
    # 404 基本可以认为“路由不存在/路径不匹配”
    if int(status_code) == 404:
        return False
    return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Scan BACKEND_PUBLIC_ROUTES.csv for reachability (non-destructive).")
    parser.add_argument("--routes-csv", default=str(DEFAULT_ROUTES_CSV), help="Path to BACKEND_PUBLIC_ROUTES.csv")
    parser.add_argument("--base-url", default="http://localhost:8000", help="Backend base URL")
    parser.add_argument("--token", default=os.getenv("ANTIHUB_TOKEN", ""), help="Bearer token (or set ANTIHUB_TOKEN)")
    parser.add_argument("--timeout", type=float, default=10.0, help="Request timeout seconds")
    parser.add_argument(
        "--check-method",
        default="OPTIONS",
        choices=["OPTIONS", "HEAD", "GET"],
        help="HTTP method used for checking (default OPTIONS; safe for all routes)",
    )
    parser.add_argument("--limit", type=int, default=0, help="Limit number of routes (0 = no limit)")
    parser.add_argument("--include", default="", help="Only scan specs containing this substring")
    parser.add_argument("--exclude", default="", help="Skip specs containing this substring")
    parser.add_argument("--out", default="", help="Write results to CSV file")
    parser.add_argument("--fail", action="store_true", help="Exit non-zero if any route is unreachable/violates 410")

    args = parser.parse_args(argv)

    routes_csv = Path(args.routes_csv)
    if not routes_csv.exists():
        print(f"[error] routes csv not found: {routes_csv}", file=sys.stderr)
        return 2

    token = (args.token or "").strip() or None
    check_method = (args.check_method or "OPTIONS").strip().upper()
    include = (args.include or "").strip()
    exclude = (args.exclude or "").strip()

    results = []
    total = 0
    for spec in _iter_public_routes(routes_csv):
        total += 1
        if include and include not in spec.source:
            continue
        if exclude and exclude in spec.source:
            continue
        path = _substitute_path_params(spec.path)
        url = _build_url(args.base_url, path)
        status_code, error = _request_once(
            url=url,
            method=check_method,
            token=token,
            timeout_seconds=float(args.timeout),
        )

        reachable = _is_reachable(status_code)
        expected_410 = spec.path in EXPECTED_410_PATHS
        violates_410 = expected_410 and (status_code not in (410, 401, 403))

        results.append(
            {
                "spec": spec.source,
                "check_method": check_method,
                "url": url,
                "status_code": status_code if status_code is not None else "",
                "reachable": "yes" if reachable else "no",
                "expected_410": "yes" if expected_410 else "no",
                "violates_410": "yes" if violates_410 else "no",
                "error": error or "",
            }
        )

        if args.limit and len(results) >= int(args.limit):
            break

    timestamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    ok = sum(1 for r in results if r["reachable"] == "yes")
    bad = sum(1 for r in results if r["reachable"] == "no")
    bad_410 = sum(1 for r in results if r["violates_410"] == "yes")

    print(f"[scan] at={timestamp} total_listed={total} scanned={len(results)} ok={ok} unreachable={bad} violates_410={bad_410}")

    out_path = (args.out or "").strip()
    if out_path:
        out_file = Path(out_path)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        with out_file.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "spec",
                    "check_method",
                    "url",
                    "status_code",
                    "reachable",
                    "expected_410",
                    "violates_410",
                    "error",
                ],
            )
            writer.writeheader()
            writer.writerows(results)
        print(f"[scan] wrote: {out_file}")

    if args.fail and (bad > 0 or bad_410 > 0):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

