import fs from 'node:fs';
import path from 'node:path';
import { parseFreeplane, htmlBody } from '../shared/parser.ts';
import { collectRefs, buildAssets } from '../shared/refs.ts';
import { ROOT, findMaps, loadConfig, toPosix } from './shared.ts';
import type { Manifest, ManifestEntry, MapData, MapNode, SiteNode } from '../shared/types.ts';

const NOTES_DIR = loadConfig().notesDir;
const OUT_DIR = path.join(ROOT, 'public/data/maps');
const MANIFEST = path.join(ROOT, 'public/data/manifest.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

const ICON_MAP: Record<string, string> = {
  idea: '💡', book: '📖', book_open: '📖', attach: '📎', bell: '🔔', info: 'ℹ️',
  'help': '❓', messagebox_warning: '⚠️', button_ok: '✔️', button_cancel: '✖️',
  'button_help': '❓', edit: '✏️', pencil: '✏️', folder: '📁', file: '📄',
  'desktop_new': '🆕', go: '➡️', lamp: '💡', 'stop-sign': '⛔', closed: '🔒',
  open: '🔓', knot: '🔗', 'full-1': '1️⃣', 'full-2': '2️⃣', 'full-3': '3️⃣',
  'full-4': '4️⃣', 'full-5': '5️⃣', 'full-6': '6️⃣', 'full-7': '7️⃣', 'full-8': '8️⃣',
  'full-9': '9️⃣', 'full-10': '🔟', yes: '✅', no: '❌', bee: '🐝',
  soccer: '⚽', heart: '❤️', star: '⭐', flag: '🚩', clock: '🕐',
  xmag: '🔍', group: '👥', male: '♂️', female: '♀️',
};

/** 序列化节点，短键以压缩体积 */
function serialize(n: MapNode): SiteNode {
  const o: SiteNode = { t: n.text };
  if (n.id) o.i = n.id;
  if (n.html) o.h = htmlBody(n.html);
  if (n.details) o.d = htmlBody(n.details);
  if (n.note) o.n = htmlBody(n.note);
  if (n.attributes.length) {
    o.a = n.attributes.filter((x) => x.value).map((x) => [x.name, x.value] as [string, string]);
  }
  if (n.link) o.l = n.link;
  if (n.icons.length) o.ic = n.icons.map((x) => ICON_MAP[x] ?? '');
  if (n.bg) o.bg = n.bg;
  if (n.fg) o.fg = n.fg;
  if (n.folded) o.f = 1;
  if (n.edge) o.e = n.edge;
  if (n.cloud) o.cl = n.cloud;
  if (n.external?.uri) o.x = { u: n.external.uri, s: n.external.size };
  if (n.arrowlinks.length) o.ar = n.arrowlinks;
  if (n.position) o.p = n.position;
  if (n.children.length) o.c = n.children.map(serialize);
  return o;
}

interface WalkAcc {
  count: number;
  depth: number;
  details: number;
  notes: number;
  links: number;
  attrs: number;
  index: { i?: string; t: string; d: number }[];
}

function walk(node: MapNode, acc: WalkAcc, depth = 0): void {
  acc.count++;
  acc.depth = Math.max(acc.depth, depth);
  if (node.details) acc.details++;
  if (node.note) acc.notes++;
  if (node.link) acc.links++;
  if (node.attributes.length) acc.attrs++;
  acc.index.push({ i: node.id, t: node.text, d: depth });
  node.children.forEach((c) => walk(c, acc, depth + 1));
}

const files = findMaps(NOTES_DIR).sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
const manifest: ManifestEntry[] = [];
let totalProblems = 0;

if (!files.length) {
  console.warn(`[warn] ${toPosix(path.relative(ROOT, NOTES_DIR))} 下没有 .mm 文件`);
}

for (const { abs, rel } of files) {
  const xml = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  const t0 = performance.now();
  const map = parseFreeplane(xml);
  const ms = performance.now() - t0;
  if (!map.root) {
    console.warn(`[skip] ${rel}: 找不到根节点（文件可能已加密）`);
    continue;
  }
  if (map.error) console.warn(`[warn] ${rel}: XML 解析告警 ${map.error.message}`);

  const acc: WalkAcc = { count: 0, depth: 0, details: 0, notes: 0, links: 0, attrs: 0, index: [] };
  walk(map.root, acc);

  // —— 图片 / 附件引用分析 ——
  const refs = collectRefs(map.root, map.freeNodes);
  const { assets, stats: imgStats, problems } = buildAssets(refs, abs, NOTES_DIR);
  totalProblems += problems.length;

  const slug = rel.replace(/\.mm$/i, '').replace(/\//g, '__');
  const dir = path.posix.dirname(toPosix(rel));
  const base = dir === '.' ? 'notes/' : `notes/${dir}/`;

  const out: MapData = {
    slug,
    path: rel,
    base,
    version: map.version,
    title: map.root.text.split('\n')[0]!.slice(0, 120),
    root: serialize(map.root),
    free: map.freeNodes.map(serialize),
    assets,
    stats: {
      nodes: acc.count,
      depth: acc.depth + 1,
      details: acc.details,
      notes: acc.notes,
      links: acc.links,
      attrs: acc.attrs,
      parseMs: Math.round(ms),
      sizeKB: Math.round(Buffer.byteLength(xml) / 1024),
      images: imgStats,
    },
    index: acc.index,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.json`), JSON.stringify(out));

  manifest.push({
    slug,
    path: rel,
    title: out.title,
    base,
    nodes: out.stats.nodes,
    depth: out.stats.depth,
    details: out.stats.details,
    images: imgStats,
    warnings: problems.slice(0, 8),
  });

  const bad = problems.length ? ` · ⚠ ${problems.length} 个问题` : '';
  console.log(
    `[ok] ${rel} | ${acc.count} nodes | depth ${acc.depth + 1} | ` +
      `图片 ${imgStats.relative} 相对 / ${imgStats.absolute} 绝对 / ${imgStats.remote} 远程${bad} | ${ms.toFixed(1)}ms`,
  );
  for (const p of problems.slice(0, 5)) {
    console.warn(`      ↳ ${p.reason}：${p.ref}${p.node ? `（节点：${p.node}）` : ''}`);
  }
}

// 清掉已经不存在的旧 slug，避免 dist 里残留
const keep = new Set(manifest.map((m) => `${m.slug}.json`));
for (const name of fs.readdirSync(OUT_DIR)) {
  if (name.endsWith('.json') && !keep.has(name)) {
    fs.rmSync(path.join(OUT_DIR, name));
    console.log(`[clean] 移除过期数据 ${name}`);
  }
}

const output: Manifest = { generatedAt: new Date().toISOString(), maps: manifest };
fs.writeFileSync(MANIFEST, JSON.stringify(output, null, 2));
console.log(`\n${manifest.length} map(s) → ${toPosix(path.relative(ROOT, MANIFEST))}`);
if (totalProblems) {
  console.warn(`\n⚠ 共 ${totalProblems} 个图片引用需要处理。绝对路径必须在本地改成相对路径后重新提交。`);
}
