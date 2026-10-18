import fs from 'node:fs';
import path from 'node:path';
import type {
  AssetEntry,
  AssetMap,
  AssetResult,
  ImageStats,
  MapNode,
  RefItem,
  RefProblem,
  RefType,
} from './types.ts';

/** 判断引用类型 */
export function classifyRef(ref = ''): RefType {
  if (!ref) return 'empty';
  if (/^data:/i.test(ref)) return 'inline';
  if (/^(https?:|mailto:|ftp:)/i.test(ref)) return 'remote';
  if (/^freeplaneresource:/i.test(ref)) return 'builtin';
  if (/^file:/i.test(ref)) return 'absolute';
  if (/^[a-zA-Z]:[\\/]/.test(ref) || ref.startsWith('/') || ref.startsWith('\\\\')) return 'absolute';
  return 'relative';
}

/** 解码 + 统一分隔符 + 去掉 #hash / ?query */
export function normalizeRef(ref = ''): string {
  let s = ref.split('#')[0]!.split('?')[0]!.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 保留原样 */
  }
  return s.replace(/\\/g, '/');
}

const HTML_FIELDS: { field: 'html' | 'details' | 'note'; kind: 'img' }[] = [
  { field: 'html', kind: 'img' },
  { field: 'details', kind: 'img' },
  { field: 'note', kind: 'img' },
];

/** 收集一张图里所有外部引用（图片 / 外部对象 / 本地链接） */
export function collectRefs(root: MapNode | null, freeNodes: MapNode[] = []): RefItem[] {
  const out: RefItem[] = [];
  const walk = (n: MapNode): void => {
    for (const { field, kind } of HTML_FIELDS) {
      const html = n[field];
      if (!html) continue;
      for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*"([^"]*)"/gi)) {
        out.push({ kind, ref: m[1] ?? '', field, node: n });
      }
    }
    if (n.external?.uri) out.push({ kind: 'external', ref: n.external.uri, field: 'hook', node: n });
    if (n.link && !/^(https?:|mailto:|#)/i.test(n.link)) {
      out.push({ kind: 'link', ref: n.link, field: 'LINK', node: n });
    }
    n.children.forEach(walk);
  };
  if (root) walk(root);
  freeNodes.forEach(walk);
  return out;
}

/**
 * 把引用解析成站点内路径，并检查文件是否存在。
 * assets 用「原始 src 字符串」作 key，前端按原样查表替换，避免 URL 规范化差异。
 */
export function buildAssets(refs: RefItem[], mapAbsPath: string, notesRoot: string): AssetResult {
  const assets: AssetMap = {};
  const stats: ImageStats = {
    total: 0,
    relative: 0,
    missing: 0,
    absolute: 0,
    remote: 0,
    builtin: 0,
    inline: 0,
    localLinks: 0,
  };
  const problems: RefProblem[] = [];
  const mapDir = path.dirname(mapAbsPath);

  for (const item of refs) {
    // 指向本地文件的节点链接不在图片统计里，Web 端无法打开本地文件
    if (item.kind === 'link') {
      stats.localLinks++;
      continue;
    }

    stats.total++;
    const type = classifyRef(item.ref);
    const entry: AssetEntry = { type, ok: true };

    if (type === 'relative') {
      stats.relative++;
      const abs = path.resolve(mapDir, normalizeRef(item.ref));
      const rel = path.relative(notesRoot, abs);
      const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      const exists = inside && fs.existsSync(abs) && fs.statSync(abs).isFile();
      entry.ok = exists;
      entry.url = inside ? `notes/${rel.split(path.sep).join('/')}` : item.ref;
      if (!exists) {
        stats.missing++;
        problems.push({
          reason: inside ? '文件不存在' : '越出笔记目录',
          ref: normalizeRef(item.ref),
          node: item.node.text?.slice(0, 40),
        });
      }
    } else if (type === 'absolute') {
      stats.absolute++;
      entry.ok = false;
      entry.url = item.ref;
      problems.push({
        reason: '绝对路径，CI 无法访问',
        ref: normalizeRef(item.ref),
        node: item.node.text?.slice(0, 40),
      });
    } else if (type === 'remote') {
      stats.remote++;
      entry.url = item.ref;
    } else if (type === 'builtin') {
      stats.builtin++;
      entry.ok = false;
      entry.url = '';
    } else if (type === 'inline') {
      stats.inline++;
      entry.url = item.ref;
    }

    // 同一个 src 可能出现多次，保留第一个可用结果
    const prev = assets[item.ref];
    if (!prev || (!prev.ok && entry.ok)) assets[item.ref] = entry;
  }

  return { assets, stats, problems };
}
