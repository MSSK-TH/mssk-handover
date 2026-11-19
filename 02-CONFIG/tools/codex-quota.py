#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
查额度.py —— 读 ChatGPT/Codex 订阅的**真实**额度，写成控制台读的 JSON

为什么要重写（2026-09-21 实测结论）：
  1. 旧脚本走的 `codex/account/rateLimits/read` 在这条链路上**返回 403 + Cloudflare 挑战页**，
     根本取不到数据（不是字段名的问题）。
     真正能用的是 `backend-api/wham/usage`（new-api 内部也是用它，HTTP 200）。
  2. primary/secondary **只是传输槽位名，没有固定含义**，
     必须按 `limit_window_seconds` 判断：604800=7天、18000=5小时。
     本账号实测：primary_window.limit_window_seconds=604800，secondary_window=null
     （**根本没有第二个窗口** —— 旧脚本硬把 primary 当周、secondary 当短，短的那个是凭空来的）。
  3. 官方百分比是**服务端算好的加权结果**，不是 token 数，我们只能取、不能算。

设计取舍：
  · 只读数据库里的渠道凭据（mode=ro），**不刷新 token** —— 刷新会踢掉中转站正在用的凭据。
    token 真过期了，中转站自己下一次请求会刷新并写回数据库，本脚本下次跑就好了。
  · 取数失败**不覆盖**已有文件（保留上次成功的数据，前端会显示更新时间和过期状态）。
"""
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DB = os.environ.get("MSSK_DB", "/opt/codex-relay/deploy/data/one-api.db")
OUT = os.environ.get("MSSK_OUT", "/opt/mssk/console/codex-quota.json")
LOG = os.environ.get("MSSK_LOG", "/var/log/mssk-quota.log")
UPSTREAM = "https://chatgpt.com/backend-api/wham/usage"

WEEK_SECONDS = 604800      # 7 天
FIVE_HOUR_SECONDS = 18000  # 5 小时


def log(msg):
    line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def channel_cred():
    """从 new-api 的 SQLite 里读 codex 渠道凭据（只读，不写）"""
    uri = "file:%s?mode=ro" % DB
    con = sqlite3.connect(uri, uri=True, timeout=8)
    try:
        row = con.execute(
            "select key from channels where type=57 and status=1 order by id limit 1"
        ).fetchone()
    finally:
        con.close()
    if not row:
        raise RuntimeError("数据库里找不到启用的 codex 渠道(type=57)")
    return json.loads(row[0])


SOCKS = os.environ.get("MSSK_SOCKS", "").strip()   # 留空=直连；境内机可填 127.0.0.1:1080
WHAM_TMP = os.environ.get("MSSK_WHAM_TMP", "/tmp/mssk-wham.json")


def fetch_usage(token, account_id):
    """取 Codex 订阅用量。

    默认直连（境外主机可直接访问 chatgpt.com）。
    若目标机在境内、直连不可达，用环境变量指定代理：
        MSSK_SOCKS=127.0.0.1:1080 /usr/bin/python3 /opt/mssk/tools/codex-quota.py
    """
    import subprocess
    cmd = ["curl", "-sS"]
    if SOCKS:
        cmd += ["--socks5-hostname", SOCKS]
    cmd += [
        "-H", "Authorization: Bearer " + token,
        "-H", "chatgpt-account-id: " + account_id,
        "-H", "Accept: application/json",
        "-H", "originator: codex_cli_rs",
        "-H", "User-Agent: codex_cli_rs/0.162.0 (Linux 6.8; x86_64) codex",
        "-o", WHAM_TMP,
        "-w", "%{http_code}",
        "--max-time", "25",
        UPSTREAM,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    code = (r.stdout or "").strip()
    if code != "200":
        raise RuntimeError("HTTP %s%s" % (code or "?", (" :: " + (r.stderr or "")[:160]) if r.stderr else ""))
    with open(WHAM_TMP, encoding="utf-8") as f:
        return json.load(f)



def window(raw):
    """按**窗口长度**判定语义，不再靠 primary/secondary 的位置"""
    if not raw:
        return None
    secs = int(raw.get("limit_window_seconds") or 0)
    if secs >= WEEK_SECONDS:
        kind = "weekly"
    elif secs <= FIVE_HOUR_SECONDS:
        kind = "short"
    else:
        kind = "other"
    reset_at = raw.get("reset_at")
    return {
        "kind": kind,
        "used_percent": raw.get("used_percent"),
        "limit_window_seconds": secs,
        "reset_at": reset_at,
        "resets_at": (
            datetime.fromtimestamp(reset_at, timezone.utc).isoformat().replace("+00:00", "Z")
            if reset_at else None
        ),
        "reset_after_seconds": raw.get("reset_after_seconds"),
    }


def mask(email):
    if not email or "@" not in email:
        return None
    name, _, domain = email.partition("@")
    return (name[:2] + "***@" + domain) if len(name) > 2 else ("*@" + domain)


def main():
    cred = channel_cred()
    token = (cred.get("access_token") or "").strip()
    account_id = (cred.get("account_id") or "").strip()
    if not token or not account_id:
        raise RuntimeError("渠道凭据里缺 access_token / account_id")

    data = fetch_usage(token, account_id)

    rl = data.get("rate_limit") or {}
    wins = [w for w in (window(rl.get("primary_window")), window(rl.get("secondary_window"))) if w]
    weekly = next((w for w in wins if w["kind"] == "weekly"), None)
    short = next((w for w in wins if w["kind"] == "short"), None)

    payload = {
        "demo": False,
        "source": "wham/usage",
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "plan": data.get("plan_type"),
        "account": mask(data.get("email")),
        "limit_reached": rl.get("limit_reached"),
        "allowed": rl.get("allowed"),
        # 前端现在读这两个键；没有的窗口就给 null，别编数字
        "weekly": weekly,
        "short": short,
        # 通用列表：以后加窗口不用改前端
        "windows": wins,
        "reset_credits": (data.get("rate_limit_reset_credits") or {}).get("available_count"),
        "credits": {
            "has_credits": (data.get("credits") or {}).get("has_credits"),
            "unlimited": (data.get("credits") or {}).get("unlimited"),
        },
        "additional_rate_limits": data.get("additional_rate_limits"),
    }

    tmp = OUT + ".tmp"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, OUT)  # 原子替换，前端不会读到半个文件

    parts = []
    if weekly:
        parts.append("周额度已用 %s%%（%s 后重置）" % (
            weekly["used_percent"],
            ("%.1f 天" % (weekly["reset_after_seconds"] / 86400)) if weekly.get("reset_after_seconds") else "?",
        ))
    if short:
        parts.append("5 小时窗口已用 %s%%" % short["used_percent"])
    if not wins:
        parts.append("上游没返回任何窗口")
    log("OK plan=%s  %s  → %s" % (data.get("plan_type"), "；".join(parts), OUT))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as e:
        log("FAIL HTTP %s %s（不动旧文件，保留上次成功的数据）" % (e.code, e.reason))
        sys.exit(2)
    except Exception as e:  # noqa: BLE001
        log("FAIL %s: %s（不动旧文件）" % (type(e).__name__, e))
        sys.exit(1)
