#!/usr/bin/env node
/**
 * 图片引用体检：不改文件，只报告。
 * 用法：npm run check
 * 退出码：0 = 全部可用；1 = 存在绝对路径 / 缺失文件
 */
import fs from 'node:fs';
import { parseFreeplane } from '../shared/parser.ts';
import { collectRefs, buildAssets } from '../shared/refs.ts';
import { findMaps, loadConfig, toPosix } from './shared.ts';
import path from 'node:path';

const NOTES_DIR = loadConfig().notesDir;
const maps = findMaps(NOTES_DIR).sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
let bad = 0;
let total = 0;

console.log(`\n检查 ${maps.length} 个 .mm 文件（${toPosix(path.relative(process.cwd(), NOTES_DIR))}）\n`);

for (const { abs, rel } of maps) {
  const map = parseFreeplane(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
  if (!map.root) {
    console.log(`✗ ${rel} —— 无法解析（可能已加密）`);
    bad++;
    continue;
  }
  const refs = collectRefs(map.root, map.freeNodes);
  const { stats, problems } = buildAssets(refs, abs, NOTES_DIR);
  total += stats.total;

  const ok = stats.total - stats.missing - stats.absolute - stats.builtin;
  const flag = problems.length ? '✗' : '✓';
  console.log(
    `${flag} ${rel}` +
      `\n   图片引用 ${stats.total}（可用 ${Math.max(0, ok)} · 缺失 ${stats.missing} · 绝对路径 ${stats.absolute}` +
      ` · 远程 ${stats.remote} · 内置 ${stats.builtin} · data URI ${stats.inline}）` +
      (stats.localLinks ? `\n   另有 ${stats.localLinks} 个指向本地文件的节点链接（Web 不可打开，已忽略）` : ''),
  );
  for (const p of problems) {
    bad++;
    console.log(`   ↳ ${p.reason}：${p.ref}${p.node ? `　[node] ${p.node.replace(/\n/g, ' ')}` : ''}`);
  }
}

console.log(`\n合计 ${total} 个图片引用，${bad} 个需要处理。`);
if (bad) {
  console.log(`
处理建议：
  1. 绝对路径（C:\\… / /Users/… / file:///…）——在 Freeplane 里删除该图后重新插入；
     或直接把图片拖进 map 所在目录再引用。注意：偏好设置里的「相对链接」对插入图片不生效。
  2. 缺失的相对路径——确认图片是否随 .mm 一起提交（.gitignore 很容易漏掉 Images/）。
  3. 想先让页面能跑，可以先忽略：构建会为这些引用显示占位框，并在侧栏标 ⚠。
`);
  process.exitCode = 1;
}
