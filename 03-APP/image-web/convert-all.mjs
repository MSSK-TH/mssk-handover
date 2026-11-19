#!/usr/bin/env node
/**
 * 批量把历史 PNG 转成 WebP（显示用），原 PNG 保留。
 * 用法（容器内）： node /app/convert-all.mjs [--dry]
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const sharp = requireCjs('sharp');

const ROOT = process.env.DATA_DIR || '/data';
const MAX_W = Number(process.env.WEBP_MAX_W || 1600);
const QUALITY = Number(process.env.WEBP_QUALITY || 82);
const DRY = process.argv.includes('--dry');

async function* walkPng(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkPng(p);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) yield p;
  }
}

let done = 0, skipped = 0, failed = 0;
let inBytes = 0, outBytes = 0;
const t0 = Date.now();

for await (const png of walkPng(path.join(ROOT, 'users'))) {
  const out = png + '.webp';
  try {
    const st = await fsp.stat(out).catch(() => null);
    if (st && st.size > 0) { skipped++; continue; }
    const src = await fsp.stat(png);
    if (DRY) { done++; inBytes += src.size; continue; }

    const buf = await sharp(png)
      .rotate()
      .resize({ width: MAX_W, withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 4 })
      .toBuffer();
    await fsp.writeFile(out, buf);
    done++; inBytes += src.size; outBytes += buf.length;

    if (done % 50 === 0) {
      const s = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${done} 张已转（跳过 ${skipped}），累计 ${(inBytes/1024/1024).toFixed(0)}MB → ${(outBytes/1024/1024).toFixed(0)}MB，用时 ${s}s`);
    }
  } catch (e) {
    failed++;
    if (failed <= 5) console.log(`  失败 ${path.basename(png)}: ${e.message}`);
  }
}

const s = ((Date.now() - t0) / 1000).toFixed(0);
console.log('');
console.log(`完成：转换 ${done}，跳过 ${skipped}，失败 ${failed}，用时 ${s}s`);
if (!DRY) {
  console.log(`体积：${(inBytes/1024/1024).toFixed(0)}MB PNG → ${(outBytes/1024/1024).toFixed(0)}MB WebP`
    + (inBytes ? `（压缩到 ${(outBytes/inBytes*100).toFixed(0)}%）` : ''));
}
