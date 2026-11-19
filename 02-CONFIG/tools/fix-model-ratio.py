#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描并补齐"有渠道但没价格"的模型倍率。
用法：
  python3 fix-model-ratio.py                # 只检查，不改（dry-run）
  python3 fix-model-ratio.py --apply        # 缺的统一补成 1
  python3 fix-model-ratio.py --apply --ratio 2.5
  python3 fix-model-ratio.py --apply --set gpt-6.1-terra=1.25
"""
import sqlite3, json, shutil, time, sys, os

SKIP_MODELS = {"gpt-image-2", "codex-gpt-image-2"}  # 走表达式计费，不需要倍率
DB = os.environ.get("MSSK_DB", "/opt/mssk/new-api/data/one-api.db")

def main():
    args = sys.argv[1:]
    apply = "--apply" in args
    ratio = 1.0
    explicit = {}
    for i, a in enumerate(args):
        if a == "--ratio" and i + 1 < len(args):
            ratio = float(args[i + 1])
        if a == "--set" and i + 1 < len(args):
            k, _, v = args[i + 1].partition("=")
            explicit[k.strip()] = float(v)

    c = sqlite3.connect(DB, timeout=15)
    cur = c.cursor()
    mr = json.loads(cur.execute("select value from options where key='ModelRatio'").fetchone()[0])
    mp = json.loads(cur.execute("select value from options where key='ModelPrice'").fetchone()[0])
    bm = {}
    row = cur.execute("select value from options where key='billing_setting.billing_mode'").fetchone()
    if row and row[0]:
        try: bm = json.loads(row[0])
        except Exception: bm = {}

    models = [r[0] for r in cur.execute("select distinct model from abilities where enabled=1")]
    missing = []
    for m in sorted(models):
        if bm.get(m) == "tiered_expr":
            continue
        if m in SKIP_MODELS:
            continue
        if m in mp:
            continue
        if m not in mr:
            missing.append(m)

    print("有渠道的模型: %d 个" % len(models))
    if not missing:
        print("✅ 没有缺价格的模型")
        c.close()
        return
    print("缺价格: %d 个" % len(missing))
    for m in missing:
        print("   -", m, "→ 计划设为", explicit.get(m, ratio))

    if not apply:
        print("\n(dry-run) 加 --apply 才会写入")
        c.close()
        return

    bak = DB + ".bak-ratio-" + time.strftime("%Y%m%d-%H%M%S")
    shutil.copy2(DB, bak)
    print("\n备份:", bak)
    for m in missing:
        mr[m] = explicit.get(m, ratio)
    cur.execute("update options set value=? where key='ModelRatio'",
                (json.dumps(mr, ensure_ascii=False),))
    c.commit()
    print("已写入，ModelRatio 共 %d 个键" % len(mr))
    print("new-api 会在下次 SyncOptions 时生效（约 1 分钟）")
    c.close()

if __name__ == "__main__":
    main()