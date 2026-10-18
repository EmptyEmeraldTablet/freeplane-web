import { SaxesParser } from 'saxes';
import type { SaxesAttributeNS, SaxesTagPlain } from 'saxes';
import type { MapNode, ParsedMap } from './types.ts';

/** 把 Freeplane richcontent 的 HTML 片段转成纯文本 */
export function htmlToText(html = ''): string {
  const text = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#xa0;|&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** 取出 richcontent HTML 的 body 内部片段 */
export function htmlBody(html = ''): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return (m?.[1] ?? html).trim();
}

interface StackFrame {
  name: string;
  node: MapNode | null;
}

interface RichBlock {
  type: string;
  body: string;
}

/** saxes 的属性值可能是字符串（xmlns:false）或对象（xmlns:true），统一取字符串 */
function attrReader(tag: SaxesTagPlain) {
  const attrs = (tag.attributes ?? {}) as Record<string, string | SaxesAttributeNS | undefined>;
  return (name: string): string | null => {
    const v = attrs[name];
    if (typeof v === 'string') return v;
    return v?.value ?? null;
  };
}

/**
 * 解析 Freeplane .mm（FreeMind 兼容 XML）
 */
export function parseFreeplane(xml: string): ParsedMap {
  /**
   * 关键：richcontent 里是 HTML，不是 XML。
   * 如果让 XML 解析器直接穿过它，标签会被当成元素丢掉、不规范实体还会报错。
   * 做法：先把每段 HTML 原文抽出来换成占位符，解析完再原样填回。
   */
  const blocks: RichBlock[] = [];
  const stripped = xml.replace(
    /<richcontent\b([^>]*)>([\s\S]*?)<\/richcontent>/gi,
    (_m, attrs: string, body: string) => {
      const type = /TYPE\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
      blocks.push({ type, body });
      return `<richcontent${attrs} data-ref="${blocks.length - 1}"/>`;
    },
  );

  const parser = new SaxesParser({ fragment: false, xmlns: false });
  let root: MapNode | null = null;
  const freeNodes: MapNode[] = [];
  let version: string | null = null;
  const stack: StackFrame[] = [{ name: '#root', node: null }];
  let currentRich: { type: string; ref: string | null } | null = null;
  let parseError: Error | null = null;

  const top = (): StackFrame => stack[stack.length - 1]!;

  parser.on('error', (e) => {
    parseError = e;
  });

  parser.on('opentag', (tag) => {
    const a = attrReader(tag);

    if (tag.name === 'map') {
      version = a('version');
      stack.push({ name: 'map', node: null });
      return;
    }

    if (tag.name === 'node') {
      const node: MapNode = {
        id: a('ID') ?? undefined,
        text: a('TEXT') ?? '',
        html: null,
        details: null,
        note: null,
        attributes: [],
        icons: [],
        link: a('LINK'),
        bg: a('BACKGROUND_COLOR'),
        fg: a('COLOR'),
        folded: a('FOLDED') === 'true',
        style: a('STYLE_REF') ?? a('LOCALIZED_STYLE_REF') ?? a('STYLE'),
        position: a('POSITION'),
        edge: null,
        cloud: null,
        external: null,
        arrowlinks: [],
        children: [],
        parent: top().node,
      };
      const parent = top().node;
      if (top().name === 'map') {
        // map 的直接子 node：第一个是根，其余是游离节点
        if (!root) root = node;
        else freeNodes.push(node);
      } else if (parent) {
        parent.children.push(node);
      }
      stack.push({ name: 'node', node });
      return;
    }

    if (tag.name === 'richcontent') {
      currentRich = { type: a('TYPE') ?? '', ref: a('data-ref') };
      stack.push({ name: 'richcontent', node: top().node });
      return;
    }

    if (tag.name === 'icon') {
      const icon = a('BUILTIN');
      const owner = top().node;
      if (owner && icon) owner.icons.push(icon);
      stack.push({ name: 'icon', node: owner });
      return;
    }

    if (tag.name === 'attribute') {
      const owner = top().node;
      if (owner) owner.attributes.push({ name: a('NAME') ?? '', value: a('VALUE') ?? '' });
      stack.push({ name: 'attribute', node: owner });
      return;
    }

    const owner = top().node;
    if (tag.name === 'edge' && owner) {
      owner.edge = { color: a('COLOR'), style: a('STYLE'), width: a('WIDTH') };
    } else if (tag.name === 'cloud' && owner) {
      owner.cloud = { color: a('COLOR'), shape: a('SHAPE') };
    } else if (tag.name === 'hook' && owner && a('NAME') === 'ExternalObject') {
      owner.external = { uri: a('URI'), size: a('SIZE') };
    } else if (tag.name === 'arrowlink' && owner) {
      owner.arrowlinks.push({ dest: a('DESTINATION') ?? undefined, color: a('COLOR'), label: a('TEXT') });
    }

    stack.push({ name: tag.name, node: owner });
  });

  parser.on('closetag', (tag) => {
    if (tag.name === 'richcontent' && currentRich) {
      const html = (blocks[Number(currentRich.ref)]?.body ?? '').trim();
      const owner = stack[stack.length - 1]?.node;
      if (owner) {
        if (currentRich.type === 'NODE') owner.html = html;
        else if (currentRich.type === 'DETAILS') owner.details = html;
        else if (currentRich.type === 'NOTE') owner.note = html;
      }
      currentRich = null;
    }
    stack.pop();
  });

  parser.write(stripped).close();

  // 后处理：文本回退 / 兼容旧版把 HTML 直接塞进 TEXT 的情况
  const walk = (n: MapNode): void => {
    if (/^<html[\s>]/i.test(n.text ?? '')) {
      n.html = n.html ?? n.text;
      n.text = htmlToText(n.text);
    }
    if ((!n.text || !n.text.trim()) && n.html) n.text = htmlToText(n.html);
    n.children.forEach(walk);
  };
  if (root) walk(root);
  freeNodes.forEach(walk);

  return { version, root, freeNodes, error: parseError };
}
