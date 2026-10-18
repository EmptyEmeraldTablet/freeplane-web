import { Markmap } from 'markmap-view';
import type { IMarkmapOptions } from 'markmap-view';
import type { INode, IPureNode } from 'markmap-common';
import DOMPurify from 'dompurify';
import type { Manifest, ManifestEntry, MapData, SiteNode } from '../shared/types.ts';

/* ---------------- 类型 ---------------- */

type NodePayload = {
  node: SiteNode;
  parentId: string | null;
  depth: number;
  branch: number;
  fold?: number;
};

interface PureTreeNode extends Omit<IPureNode, 'payload' | 'children'> {
  payload: NodePayload;
  children: PureTreeNode[];
}

interface TreeNode extends Omit<INode, 'payload' | 'children'> {
  payload: NodePayload;
  children: TreeNode[];
}

type ZoomedSvg = SVGElement & { __zoom?: { k: number; x: number; y: number } };

interface AppState {
  manifest: ManifestEntry[];
  map: MapData | null;
  mm: Markmap | null;
  idMap: Map<string, TreeNode>;
  selectedId: string | null;
  depth: number;
}

declare global {
  interface Window {
    __app?: AppState;
  }
}

/* ---------------- DOM ---------------- */

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`页面缺少元素：${selector}`);
  return el;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => must<T>(selector);

const state: AppState = {
  manifest: [],
  map: null,
  mm: null,
  idMap: new Map<string, TreeNode>(),
  selectedId: null,
  depth: 2,
};

const esc = (s = ''): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isExternal = (l = ''): boolean => /^(https?:|mailto:|ftp:)/i.test(l);

/* ---------------- 富文本 ---------------- */

/**
 * Freeplane 的图片路径相对于 .mm 所在目录。
 * 构建期已把「原始 src → 站点路径」算好（assets 映射），这里只做替换，
 * 避免 ../ 与 URL 编码在前端二次解析时出错。
 */
function rewriteSrc(html = ''): string {
  const map = state.map;
  const assets = map?.assets ?? {};
  return html.replace(/<img([^>]*?)src="([^"]+)"/gi, (_m, pre: string, src: string) => {
    const safe = esc(src);
    if (/^(https?:|data:)/i.test(src)) return `<img${pre}src="${safe}" loading="lazy"`;
    const asset = assets[src];
    if (asset && !asset.ok) {
      return `<img${pre}src="${esc(asset.url ?? '')}" data-missing="${safe}" title="图片缺失：${safe}" alt="图片缺失" class="fm-missing"`;
    }
    const url = asset?.url ?? `${map?.base ?? ''}${src.replace(/^\.\//, '')}`;
    return `<img${pre}src="${esc(url)}" loading="lazy"`;
  });
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(rewriteSrc(html), {
    ADD_ATTR: ['target', 'loading', 'data-missing'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
  });
}

const tidy = (html = ''): string => html.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();

function nodeContent(n: SiteNode, depth: number): string {
  const icons = (n.ic ?? []).filter(Boolean).map((i) => `<span class="fm-ic">${i}</span>`).join('');
  let inner = n.h ? tidy(sanitize(n.h)) : esc(n.t);
  inner = inner.replace(/<a /gi, '<a target="_blank" rel="noopener" ');
  const hasDoc = Boolean(n.d ?? n.n ?? n.a ?? n.x);
  const badge = hasDoc ? '<span class="fm-doc" title="有详情">▤</span>' : '';
  const link = !n.l
    ? ''
    : isExternal(n.l)
      ? `<a class="fm-doc" href="${esc(n.l)}" target="_blank" rel="noopener">↗</a>`
      : n.l.startsWith('#')
        ? `<a class="fm-doc" href="#" data-locate="${esc(n.l.slice(1))}" title="跳转到节点">↗</a>`
        : `<a class="fm-doc" href="${esc(n.l)}" target="_blank" rel="noopener">↗</a>`;
  const style: string[] = [];
  if (n.bg) style.push(`background:${n.bg}`);
  if (n.fg) style.push(`color:${n.fg}`);
  if (n.cl?.color) style.push(`box-shadow:0 0 0 3px ${n.cl.color}`);
  let thumb = '';
  if (n.x?.u) {
    const asset = state.map?.assets?.[n.x.u];
    const url = asset?.ok ? asset.url ?? '' : '';
    thumb = url
      ? `<img class="fm-thumb" src="${esc(url)}" loading="lazy" data-zoom="${esc(url)}" alt="" />`
      : `<span class="fm-missing-inline" title="附件不可用：${esc(n.x.u)}">🖼?</span>`;
  }
  const cls = `fm-node${depth === 0 ? ' root' : ''}${n.h ? '' : ' plain'}${thumb ? ' has-thumb' : ''}`;
  return `<span class="${cls}" style="${style.join(';')}">${icons}${inner}${badge}${link}${thumb}</span>`;
}

function toMarkmap(n: SiteNode, depth: number, parentId: string | null, branch = 0): PureTreeNode {
  return {
    content: nodeContent(n, depth),
    children: (n.c ?? []).map((c, i) => toMarkmap(c, depth + 1, n.i ?? null, depth === 0 ? i : branch)),
    payload: { node: n, parentId, depth, branch },
  };
}

/**
 * markmap 在 _initializeData 里会克隆子节点再挂 state，
 * 所以 toMarkmap 产出的对象在 create 之后已经不是树上的对象了。
 * idMap 必须在 create 之后按内部树重建，否则 locate() 里
 * centerNode / setHighlight 拿到无 state 的对象会直接抛错（搜索跳转失效）。
 */
function reindexTree(node: TreeNode | undefined): void {
  if (!node) return;
  const id = node.payload?.node?.i;
  if (id) state.idMap.set(id, node);
  node.children.forEach(reindexTree);
}

/* ---------------- 布局 / 侧栏 ---------------- */

const narrowQuery = window.matchMedia('(max-width: 900px)');
const isNarrow = (): boolean => narrowQuery.matches;

function setSidebar(open: boolean): void {
  $('#sidebar').classList.toggle('collapsed', !open);
  const scrim = $('#scrim');
  scrim.hidden = !(isNarrow() && open);
  document.body.classList.toggle('sidebar-open', isNarrow() && open);
}

function closeSidebar(): void {
  if (isNarrow()) setSidebar(false);
}

function syncViewport(): void {
  setSidebar(!isNarrow());
  const hint = $('#hint');
  hint.textContent = isNarrow()
    ? '双指缩放 · 单指拖动 · 点节点看详情'
    : '滚轮缩放 · 拖拽平移 · 点击圆点折叠 · 点击节点看详情';
}

/* ---------------- 渲染 ---------------- */

function markmapOptions(): Partial<IMarkmapOptions> {
  const narrow = isNarrow();
  return {
    duration: 250,
    maxWidth: narrow ? 230 : 400,
    spacingVertical: narrow ? 10 : 9,
    spacingHorizontal: narrow ? 58 : 84,
    paddingX: 10,
    nodeMinHeight: 18,
    initialExpandLevel: state.depth,
    toggleRecursively: false,
    color: (node: INode) => {
      const p = node.payload as NodePayload | undefined;
      if (!p || !p.depth) return '#4b5563';
      const palette = ['#2f6df6', '#e8562a', '#0f9d58', '#9c27b0', '#e0a100', '#00a0b0'];
      return palette[(p.branch ?? 0) % palette.length]!;
    },
  };
}

async function loadMap(slug: string): Promise<void> {
  const res = await fetch(`data/maps/${encodeURIComponent(slug)}.json`);
  if (!res.ok) throw new Error(`无法加载导图数据（HTTP ${res.status}）`);
  const data = (await res.json()) as MapData;

  state.map = data;
  state.idMap.clear();
  state.selectedId = null;
  closeDetailPanel();
  $<HTMLInputElement>('#search').value = '';
  $('#searchResults').hidden = true;

  const rootData = toMarkmap(data.root, 0, null);
  if (state.mm) {
    state.mm.destroy();
    must('#canvas svg').remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'mindmap';
    $('#canvas').prepend(svg);
  }
  state.mm = Markmap.create('#mindmap', markmapOptions(), rootData);
  reindexTree(state.mm.state.data as TreeNode | undefined);

  renderCrumbs(null);
  renderStats();
  relayoutAfterImages();
  document.querySelectorAll<HTMLElement>('.map-item').forEach((el) => {
    el.classList.toggle('on', el.dataset.slug === slug);
  });
  location.hash = encodeURIComponent(slug);
  closeSidebar();
  setTimeout(() => void state.mm?.fit(), 120);
}

function renderStats(): void {
  const s = state.map?.stats;
  if (!s) {
    $('#mapStats').textContent = '';
    return;
  }
  $('#mapStats').innerHTML =
    `${s.nodes.toLocaleString()} 个节点 · 深度 ${s.depth}<br>` +
    `${s.details} 条详情 · ${s.links} 个链接<br>` +
    `Freeplane ${state.map?.version ?? '?'} · 解析 ${s.parseMs}ms`;
}

function renderCrumbs(node: TreeNode | null): void {
  const el = $('#crumbs');
  if (!node) {
    el.innerHTML = `<b>${esc(state.map?.title ?? '')}</b>`;
    return;
  }
  const chain: TreeNode[] = [];
  let cur: TreeNode | null = node;
  while (cur) {
    chain.unshift(cur);
    const parentId: string | null = cur.payload.parentId;
    cur = parentId ? (state.idMap.get(parentId) ?? null) : null;
  }
  el.innerHTML = chain
    .map((n, i) => {
      const text = esc(n.payload.node.t.split('\n')[0] ?? '');
      return i === chain.length - 1 ? `<b>${text}</b>` : text;
    })
    .join('<span>/</span>');
  el.scrollLeft = el.scrollWidth;
}

/**
 * markmap 在图片加载前就完成了尺寸测量，图片撑开后会重叠或越界。
 * 等图片都 load/error 之后重排一次（只做一次，避免循环）。
 */
let relayoutTimer = 0;
function relayoutAfterImages(): void {
  window.clearTimeout(relayoutTimer);
  relayoutTimer = window.setTimeout(async () => {
    if (!state.mm) return;
    const k = getScale();
    await state.mm.renderData(state.mm.state.data);
    await setScale(Math.min(k, 1));
    await safeFit(0.6);
  }, 700);
}

/* ---------------- 详情面板 ---------------- */

function openDetailPanel(): void {
  $('#detail').hidden = false;
  document.body.classList.add('detail-open');
}

function closeDetailPanel(): void {
  $('#detail').hidden = true;
  document.body.classList.remove('detail-open');
}

function showDetail(node: SiteNode): void {
  const body = $('#detailBody');
  const kicker = $('#detailKicker');
  state.selectedId = node.i ?? null;
  $('#detailTitle').textContent = node.t || '(空节点)';
  const depth = node.i ? state.idMap.get(node.i)?.payload.depth : undefined;
  kicker.textContent = `第 ${(depth ?? 0) + 1} 层 · ${(node.c ?? []).length} 个子节点`;
  body.innerHTML = '';

  const add = (title: string, html: string): void => {
    const h = document.createElement('h3');
    h.textContent = title;
    const div = document.createElement('div');
    div.className = 'prose';
    div.innerHTML = html;
    body.append(h, div);
  };

  if (node.x?.u) {
    const asset = state.map?.assets?.[node.x.u];
    if (asset?.ok && asset.url) {
      const h = document.createElement('h3');
      h.textContent = '附件图';
      const img = document.createElement('img');
      img.src = asset.url;
      img.loading = 'lazy';
      img.className = 'detail-img';
      img.onclick = () => openLightbox(asset.url!);
      body.append(h, img);
    }
  }

  if (node.d) add('详情', sanitize(node.d));
  if (node.n) add('笔记', sanitize(node.n));

  if (node.a?.length) {
    const h = document.createElement('h3');
    h.textContent = '属性';
    const table = document.createElement('table');
    table.className = 'attrs';
    table.innerHTML = node.a.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    body.append(h, table);
  }

  if (node.l) {
    const h = document.createElement('h3');
    h.textContent = '链接';
    const a = document.createElement('a');
    a.className = 'link-btn';
    if (node.l.startsWith('#')) {
      a.href = '#';
      a.textContent = `↗ 跳转到 ${node.l.slice(1)}`;
      a.onclick = (ev) => {
        ev.preventDefault();
        void locate(node.l!.slice(1), true);
      };
    } else {
      a.href = node.l;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `↗ ${node.l}`;
    }
    body.append(h, a);
  }

  if (node.c?.length) {
    const h = document.createElement('h3');
    h.textContent = `子节点 (${node.c.length})`;
    const wrap = document.createElement('div');
    wrap.className = 'kids';
    node.c.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'kid';
      b.innerHTML = `<i>▸</i><span>${esc(c.t.split('\n')[0]?.slice(0, 90) ?? '') || '(空)'}</span>`;
      b.onclick = () => void locate(c.i, true);
      wrap.appendChild(b);
    });
    body.append(h, wrap);
  }

  openDetailPanel();
}

/* ---------------- 缩放 ---------------- */

const getScale = (): number => (state.mm?.svg.node() as ZoomedSvg | null)?.__zoom?.k ?? 1;

/** markmap 的 rescale 是相对缩放，这里封装成绝对缩放 */
async function setScale(abs: number): Promise<void> {
  if (!state.mm) return;
  const k = getScale();
  if (Math.abs(k - abs) > 0.01) await state.mm.rescale(abs / k);
}

async function zoomBy(factor: number): Promise<void> {
  const next = Math.min(2.5, Math.max(0.15, getScale() * factor));
  await setScale(next);
}

async function safeFit(minScale = 0.45): Promise<void> {
  const mm = state.mm;
  const data = mm?.state.data;
  if (!mm || !data) return;
  await mm.fit(1);
  if (getScale() < minScale) {
    await setScale(0.7);
    await mm.centerNode(data);
  }
}

function applyDepth(level: number): void {
  const root = state.mm?.state.data as TreeNode | undefined;
  if (!state.mm || !root) return;
  const walk = (n: TreeNode, d: number): void => {
    if (n.children.length) {
      n.payload = { ...n.payload, fold: level < 0 ? 0 : d >= level - 1 ? 1 : 0 };
      n.children.forEach((c) => walk(c, d + 1));
    }
  };
  walk(root, 0);
  state.mm.setOptions({ initialExpandLevel: level });
  // 关键：先在 1:1 缩放下重新布局，否则 markmap 测量节点尺寸会被当前缩放污染
  void (async () => {
    if (!state.mm) return;
    await setScale(1);
    await state.mm.renderData(root);
    if (level < 0) {
      const anchor = state.selectedId ? state.idMap.get(state.selectedId) : undefined;
      await state.mm.centerNode(anchor ?? root);
      await safeFit(0.32);
    } else {
      await safeFit();
    }
  })();
}

/* ---------------- 搜索 & 定位 ---------------- */

async function locate(id: string | null | undefined, openPanel = false): Promise<void> {
  if (!id || !state.mm) return;
  const target = state.idMap.get(id);
  if (!target) return;

  const chain: TreeNode[] = [];
  let cur: TreeNode | null = target;
  while (cur) {
    chain.unshift(cur);
    const parentId: string | null = cur.payload.parentId;
    cur = parentId ? (state.idMap.get(parentId) ?? null) : null;
  }
  for (const n of chain) {
    if (n.payload?.fold) await state.mm.toggleNode(n, false);
  }
  if (getScale() < 0.45) await setScale(0.85);
  await state.mm.centerNode(target, { left: 100, right: 100, top: 90, bottom: 90 });
  await state.mm.setHighlight(target);
  renderCrumbs(target);
  if (openPanel) showDetail(target.payload.node);
  closeSidebar();
  setTimeout(() => void state.mm?.setHighlight(null), 2200);
}

function runSearch(raw: string): void {
  const box = $('#searchResults');
  const q = raw.trim().toLowerCase();
  if (!q) {
    box.hidden = true;
    return;
  }
  const hits = (state.map?.index ?? []).filter((x) => x.t.toLowerCase().includes(q)).slice(0, 40);
  if (!hits.length) {
    box.innerHTML = '<div class="sr-empty">没有匹配的节点</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = hits
    .map(
      (x) =>
        `<div class="sr-item" data-id="${esc(x.i ?? '')}">${esc(x.t.split('\n')[0]?.slice(0, 80) ?? '')}<small>第 ${x.d + 1} 层</small></div>`,
    )
    .join('');
  box.hidden = false;
  box.querySelectorAll<HTMLElement>('.sr-item').forEach((el) => {
    el.onclick = () => {
      box.hidden = true;
      void locate(el.dataset.id, true);
    };
  });
}

/* ---------------- 灯箱 ---------------- */

function openLightbox(src: string): void {
  let box = document.getElementById('lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.className = 'lightbox';
    box.innerHTML = '<img alt="" /><span class="lightbox-hint">点击任意处关闭 · Esc</span>';
    box.addEventListener('click', () => box?.classList.remove('on'));
    document.body.appendChild(box);
  }
  const img = box.querySelector('img');
  if (img) img.src = src;
  box.classList.add('on');
}

/* ---------------- 事件 ---------------- */

function bindEvents(): void {
  $('#mapList').addEventListener('click', (ev) => {
    const btn = (ev.target as Element | null)?.closest<HTMLElement>('.map-item');
    const slug = btn?.dataset.slug;
    if (!slug) return;
    void loadMap(slug).catch((err: unknown) => {
      console.error(err);
      $('#mapStats').textContent = `加载失败：${(err as Error).message}`;
    });
  });

  $('#detailClose').onclick = () => {
    closeDetailPanel();
    state.mm?.setHighlight(null);
    void state.mm?.fit();
  };
  $('#btnFit').onclick = () => void state.mm?.fit();
  $('#btnZoomIn').onclick = () => void zoomBy(1.25);
  $('#btnZoomOut').onclick = () => void zoomBy(0.8);

  $('#canvas').addEventListener('click', (ev) => {
    const e = ev as MouseEvent;
    const target = e.target as Element | null;
    const g = target?.closest<SVGGElement>('g.markmap-node');
    if (!target || !g) return;
    if (target.tagName.toLowerCase() === 'circle') return;
    if (target.tagName === 'IMG') return;
    const jump = target.closest<HTMLElement>('[data-locate]');
    if (jump) {
      e.preventDefault();
      void locate(jump.dataset.locate, true);
      return;
    }
    if (target.closest('a')) return;
    const data = (g as SVGGElement & { __data__?: TreeNode }).__data__;
    if (data?.payload?.node) {
      showDetail(data.payload.node);
      renderCrumbs(data);
      void state.mm?.setHighlight(data);
    }
  });

  document.addEventListener('click', (ev) => {
    const img = (ev.target as Element | null)?.closest<HTMLImageElement>('.fm-node img, .detail-img');
    if (!img) return;
    ev.preventDefault();
    if (img.classList.contains('fm-missing')) return;
    openLightbox(img.dataset.zoom ?? img.currentSrc ?? img.src);
  });

  $('#toggleSidebar').onclick = () => {
    const open = $('#sidebar').classList.contains('collapsed');
    setSidebar(open);
  };
  $('#scrim').onclick = () => setSidebar(false);

  $('#depthSeg').addEventListener('click', (ev) => {
    const b = (ev.target as Element | null)?.closest<HTMLElement>('button');
    if (!b) return;
    document.querySelectorAll<HTMLElement>('#depthSeg button').forEach((x) => x.classList.toggle('on', x === b));
    state.depth = Number(b.dataset.depth ?? 2);
    applyDepth(state.depth);
  });

  $('#search').addEventListener('input', (ev) => runSearch((ev.target as HTMLInputElement).value));
  $('#search').addEventListener('focus', (ev) => runSearch((ev.target as HTMLInputElement).value));
  document.addEventListener('click', (ev) => {
    if (!(ev.target as Element | null)?.closest('.search-wrap')) $('#searchResults').hidden = true;
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement !== $('#search')) {
      ev.preventDefault();
      $('#search').focus();
    }
    if (ev.key === 'Escape') {
      document.getElementById('lightbox')?.classList.remove('on');
      closeDetailPanel();
      state.mm?.setHighlight(null);
      if (isNarrow() && !$('#sidebar').classList.contains('collapsed')) setSidebar(false);
    }
  });

  $('#btnTheme').onclick = () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : '';
    document.querySelector('#mindmap')?.classList.toggle('markmap-dark', dark);
    state.mm?.updateStyle();
  };

  // 触屏/鼠标首次操作后淡出提示
  const fadeHint = (): void => $('#hint').classList.add('fade');
  $('#canvas').addEventListener('pointerdown', fadeHint, { once: true });
  window.setTimeout(fadeHint, 7000);

  narrowQuery.addEventListener('change', syncViewport);
  // 移动端旋转屏幕后，markmap 自己会重排，这里只保证侧栏状态正确
  window.addEventListener('orientationchange', () => setTimeout(syncViewport, 200));
}

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  syncViewport();
  bindEvents();
  window.__app = state;

  try {
    const res = await fetch('data/manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = (await res.json()) as Manifest;
    state.manifest = manifest.maps;

    $('#mapList').innerHTML = manifest.maps
      .map((x) => {
        const imgs = x.images ? x.images.relative + x.images.absolute + x.images.remote : 0;
        const warn = x.warnings?.length ? ` · <b class="warn">⚠ ${x.warnings.length}</b>` : '';
        return `<button class="map-item" data-slug="${esc(x.slug)}"><span class="t">${esc(x.title)}</span><span class="m">${x.nodes} 节点 · 深度 ${x.depth} · ${imgs} 图${warn}</span></button>`;
      })
      .join('');

    if (!manifest.maps.length) {
      $('#mapStats').textContent = 'public/notes/ 下没有 .mm 文件';
      $('#crumbs').innerHTML = '<b>没有笔记</b>';
      return;
    }

    const fromHash = decodeURIComponent(location.hash.slice(1));
    const initial = fromHash || manifest.maps[0]!.slug;
    await loadMap(initial);
  } catch (err) {
    console.error(err);
    const message = (err as Error).message;
    $('#mapList').innerHTML = `<div class="load-error">数据加载失败<br><small>${esc(message)}</small></div>`;
    $('#crumbs').innerHTML = '<b>加载失败</b>';
  }
}

void boot();
