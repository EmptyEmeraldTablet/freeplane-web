/**
 * 全项目共享的数据模型。
 * 构建脚本（Node）与前端（浏览器）都从这里取类型，避免两端字段漂移。
 */

/* ---------------- Freeplane 解析结果 ---------------- */

export interface NodeAttribute {
  name: string;
  value: string;
}

export interface EdgeInfo {
  color: string | null;
  style: string | null;
  width: string | null;
}

export interface CloudInfo {
  color: string | null;
  shape: string | null;
}

export interface ExternalRef {
  uri: string | null;
  size: string | null;
}

export interface ArrowLink {
  dest?: string;
  color: string | null;
  label: string | null;
}

/** 解析后的节点（构建期模型，字段较长） */
export interface MapNode {
  id?: string;
  text: string;
  html: string | null;
  details: string | null;
  note: string | null;
  attributes: NodeAttribute[];
  icons: string[];
  link: string | null;
  bg: string | null;
  fg: string | null;
  folded: boolean;
  style: string | null;
  position: string | null;
  edge: EdgeInfo | null;
  cloud: CloudInfo | null;
  external: ExternalRef | null;
  arrowlinks: ArrowLink[];
  children: MapNode[];
  parent: MapNode | null;
}

export interface ParsedMap {
  version: string | null;
  root: MapNode | null;
  freeNodes: MapNode[];
  error: Error | null;
}

/* ---------------- 引用分析 ---------------- */

export type RefType = 'empty' | 'inline' | 'remote' | 'builtin' | 'absolute' | 'relative';

export type RefKind = 'img' | 'external' | 'link';

export interface RefItem {
  kind: RefKind;
  ref: string;
  field: 'html' | 'details' | 'note' | 'hook' | 'LINK';
  node: MapNode;
}

export interface AssetEntry {
  type: RefType;
  ok: boolean;
  url?: string;
}

export type AssetMap = Record<string, AssetEntry>;

export interface ImageStats {
  total: number;
  relative: number;
  missing: number;
  absolute: number;
  remote: number;
  builtin: number;
  inline: number;
  localLinks: number;
}

export interface RefProblem {
  reason: string;
  ref: string;
  node?: string;
}

export interface AssetResult {
  assets: AssetMap;
  stats: ImageStats;
  problems: RefProblem[];
}

/* ---------------- 站点产物（build-data 写出，前端消费） ---------------- */

/** 前端节点：短键压缩体积 */
export interface SiteNode {
  /** id */
  i?: string;
  /** text */
  t: string;
  /** richcontent NODE */
  h?: string;
  /** details */
  d?: string;
  /** note */
  n?: string;
  /** attributes */
  a?: [string, string][];
  /** link */
  l?: string;
  /** icons（已映射成 emoji） */
  ic?: string[];
  bg?: string;
  fg?: string;
  /** folded */
  f?: 1;
  e?: EdgeInfo;
  cl?: CloudInfo;
  x?: { u: string; s: string | null };
  ar?: ArrowLink[];
  p?: string;
  c?: SiteNode[];
}

export interface IndexEntry {
  i?: string;
  t: string;
  d: number;
}

export interface MapStats {
  nodes: number;
  depth: number;
  details: number;
  notes: number;
  links: number;
  attrs: number;
  parseMs: number;
  sizeKB: number;
  images: ImageStats;
}

export interface MapData {
  slug: string;
  path: string;
  base: string;
  version: string | null;
  title: string;
  root: SiteNode;
  free: SiteNode[];
  assets: AssetMap;
  stats: MapStats;
  index: IndexEntry[];
}

export interface ManifestEntry {
  slug: string;
  path: string;
  title: string;
  base: string;
  nodes: number;
  depth: number;
  details: number;
  images: ImageStats;
  warnings: RefProblem[];
}

export interface Manifest {
  generatedAt: string;
  maps: ManifestEntry[];
}
