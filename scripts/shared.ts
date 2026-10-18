import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（脚本都在 scripts/ 下） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_NOTES_DIR = 'public/notes';
export const CONFIG_NAME = 'notes.config.json';

export const DEFAULT_EXTENSIONS = [
  '.mm',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.pdf',
];

export const DEFAULT_IGNORE = [
  '**/~$*',
  '**/.*',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/*.tmp',
  '**/.git/**',
];

export interface NotesSourceConfig {
  /** 源目录（Freeplane 里笔记所在目录），相对路径以配置文件所在目录为准 */
  from: string;
  /** 导入到 notesDir 下的子目录名，空字符串表示根目录 */
  to?: string;
  extensions?: string[];
  ignore?: string[];
}

export interface NotesConfigFile {
  notesDir?: string;
  sources?: NotesSourceConfig[];
  extensions?: string[];
  ignore?: string[];
  prune?: boolean;
}

export interface ResolvedSource {
  label: string;
  from: string;
  /** 目标子目录（posix 相对路径，'' 表示 notesDir 根） */
  to: string;
  extensions: string[];
  ignore: string[];
}

export interface ResolvedConfig {
  configPath: string;
  notesDir: string;
  sources: ResolvedSource[];
  prune: boolean;
}

export const toPosix = (p: string): string => p.split(path.sep).join('/');

/** 极简 glob：支持 **、*、?，按 posix 相对路径匹配 */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

export function matchesAny(relPosix: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(relPosix));
}

/** 读取配置；文件不存在时返回默认配置（build/check 用） */
export function loadConfig(options: { required?: boolean; configPath?: string } = {}): ResolvedConfig {
  const configPath = path.resolve(
    options.configPath ?? process.env.NOTES_CONFIG ?? path.join(ROOT, CONFIG_NAME),
  );
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configPath)) {
    if (options.required) {
      throw new Error(
        `找不到配置文件 ${toPosix(path.relative(process.cwd(), configPath))}\n` +
          `先执行：npm run sync -- --init --from "<Freeplane 笔记目录>"`,
      );
    }
    return {
      configPath,
      notesDir: path.join(ROOT, DEFAULT_NOTES_DIR),
      sources: [],
      prune: false,
    };
  }

  let json: NotesConfigFile;
  try {
    json = JSON.parse(fs.readFileSync(configPath, 'utf8')) as NotesConfigFile;
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON：${configPath}\n${(err as Error).message}`);
  }

  const notesDir = path.resolve(configDir, json.notesDir ?? DEFAULT_NOTES_DIR);
  const extensions = (json.extensions ?? DEFAULT_EXTENSIONS).map((e) =>
    (e.startsWith('.') ? e : `.${e}`).toLowerCase(),
  );

  const sources: ResolvedSource[] = (json.sources ?? []).map((s, i) => {
    const to = (s.to ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return {
      label: to || `(根目录)#${i + 1}`,
      from: path.resolve(configDir, s.from),
      to,
      extensions: (s.extensions ?? extensions).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()),
      ignore: s.ignore ?? json.ignore ?? DEFAULT_IGNORE,
    };
  });

  return { configPath, notesDir, sources, prune: Boolean(json.prune) };
}

export interface MapFile {
  abs: string;
  rel: string;
}

/** 递归找出目录下所有 .mm */
export function findMaps(dir: string, base = ''): MapFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: MapFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...findMaps(path.join(dir, entry.name), rel));
    else if (entry.name.toLowerCase().endsWith('.mm')) out.push({ abs: path.join(dir, entry.name), rel });
  }
  return out;
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
