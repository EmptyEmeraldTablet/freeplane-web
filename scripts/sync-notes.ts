#!/usr/bin/env node
/**
 * 笔记同步：把 Freeplane 里的 .mm 及其图片目录增量同步进 public/notes。
 *
 *   npm run sync                       # 按 notes.config.json 增量同步
 *   npm run sync -- --dry-run          # 只预览，不写文件
 *   npm run sync -- --prune            # 同时删除源里已删掉的文件
 *   npm run sync -- --build            # 同步完自动 npm run build
 *   npm run sync -- --init --from "D:/notes/思维导图" --to "思维导图"
 *
 * 判断依据是「源文件 mtime + size」记录在 .notes-sync.json，
 * 所以同名同大小但内容改过（Freeplane 保存会改 mtime）也能被识别。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_NAME,
  DEFAULT_EXTENSIONS,
  DEFAULT_IGNORE,
  ROOT,
  formatBytes,
  loadConfig,
  matchesAny,
  toPosix,
} from './shared.ts';
import type { NotesConfigFile, ResolvedConfig, ResolvedSource } from './shared.ts';

interface CliOptions {
  init: boolean;
  save: boolean;
  dryRun: boolean;
  prune: boolean;
  build: boolean;
  help: boolean;
  configPath?: string;
  from?: string;
  to?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    init: false,
    save: false,
    dryRun: false,
    prune: false,
    build: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (!v) throw new Error(`${flag} 需要一个值`);
      return v;
    };
    switch (flag) {
      case '--init':
        opts.init = true;
        break;
      case '--save':
        opts.save = true;
        break;
      case '--dry-run':
      case '-n':
        opts.dryRun = true;
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--build':
        opts.build = true;
        break;
      case '--config':
        opts.configPath = value();
        break;
      case '--from':
        opts.from = value();
        break;
      case '--to':
        opts.to = value();
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

const HELP = `笔记同步

用法：
  npm run sync                                  按 ${CONFIG_NAME} 增量同步
  npm run sync -- --dry-run                     只预览，不写文件
  npm run sync -- --prune                       同时删除源里已删除的文件
  npm run sync -- --build                       同步完接着构建
  npm run sync -- --from "<目录>" --to "<子目录>"          临时用别的源同步一次（不改配置）
  npm run sync -- --from "<目录>" --save        把源目录写回配置（长期生效）
  npm run sync -- --init --from "<目录>" --to "<子目录>"   首次生成 / 更新配置并导入
  npm run sync -- --config <路径>               使用别的配置文件

配置示例（${CONFIG_NAME}）：
  {
    "notesDir": "public/notes",
    "sources": [{ "from": "../../我的笔记/思维导图", "to": "思维导图" }],
    "prune": false
  }

  "from" 相对配置文件所在目录，也可以写绝对路径（D:/notes/思维导图）。
  "to"   是导入到 notesDir 下的子目录，留空则直接放在 notesDir 根。
`;

const STATE_PATH = path.join(ROOT, '.notes-sync.json');

interface StateEntry {
  size: number;
  mtimeMs: number;
}
interface StateFile {
  version: 1;
  sources: Record<string, { from: string; files: Record<string, StateEntry> }>;
}

function readState(): StateFile {
  if (!fs.existsSync(STATE_PATH)) return { version: 1, sources: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as StateFile;
    return parsed.sources ? parsed : { version: 1, sources: {} };
  } catch {
    return { version: 1, sources: {} };
  }
}

function writeState(state: StateFile): void {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

interface SourceFile {
  srcAbs: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

function collectFiles(src: ResolvedSource): { files: SourceFile[]; skipped: number; skippedExt: Set<string> } {
  const files: SourceFile[] = [];
  const skippedExt = new Set<string>();
  let skipped = 0;

  const walk = (dirAbs: string, base: string): void => {
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (matchesAny(rel, src.ignore)) continue;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!src.extensions.includes(ext)) {
        skipped++;
        skippedExt.add(ext || '(无扩展名)');
        continue;
      }
      const st = fs.statSync(abs);
      files.push({ srcAbs: abs, rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  };

  walk(src.from, '');
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
  return { files, skipped, skippedExt };
}

interface SourceResult {
  added: string[];
  updated: string[];
  removed: string[];
  pendingRemoval: string[];
  unchanged: number;
  bytes: number;
  files: Record<string, StateEntry>;
}

function syncSource(
  cfg: ResolvedConfig,
  src: ResolvedSource,
  prevFiles: Record<string, StateEntry>,
  opts: CliOptions,
): SourceResult {
  const destRoot = path.join(cfg.notesDir, src.to);
  const { files } = collectFiles(src);
  const result: SourceResult = {
    added: [],
    updated: [],
    removed: [],
    pendingRemoval: [],
    unchanged: 0,
    bytes: 0,
    files: {},
  };

  const current = new Set(files.map((f) => f.rel));

  for (const file of files) {
    const destAbs = path.join(destRoot, ...file.rel.split('/'));
    const destStat = fs.existsSync(destAbs) ? fs.statSync(destAbs) : null;
    const prev = prevFiles[file.rel];

    let action: 'add' | 'update' | 'same';
    if (!destStat) action = 'add';
    else if (destStat.size !== file.size) action = 'update';
    else if (prev && (prev.size !== file.size || prev.mtimeMs !== file.mtimeMs)) action = 'update';
    else action = 'same';

    result.files[file.rel] = { size: file.size, mtimeMs: file.mtimeMs };

    if (action === 'same') {
      result.unchanged++;
      continue;
    }
    if (opts.dryRun) {
      (action === 'add' ? result.added : result.updated).push(file.rel);
      result.bytes += file.size;
      continue;
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(file.srcAbs, destAbs);
    const copied = fs.statSync(destAbs);
    if (copied.size !== file.size) {
      throw new Error(`复制后大小不一致：${file.rel}（源 ${file.size} / 目标 ${copied.size}）`);
    }
    (action === 'add' ? result.added : result.updated).push(file.rel);
    result.bytes += file.size;
  }

  // 源里删掉的文件
  for (const rel of Object.keys(prevFiles)) {
    if (current.has(rel)) continue;
    const destAbs = path.join(destRoot, ...rel.split('/'));
    // 目标里也没了：直接把它从同步记录里丢掉
    if (!fs.existsSync(destAbs)) continue;
    if (!opts.prune) {
      result.pendingRemoval.push(rel);
      // 保留记录，否则下次就跑 --prune 也找不到它了
      result.files[rel] = prevFiles[rel]!;
      continue;
    }
    if (opts.dryRun) {
      result.removed.push(rel);
      continue;
    }
    fs.rmSync(destAbs);
    result.removed.push(rel);
  }

  return result;
}

/** 删除空目录（自底向上，最多删到 stopAt） */
function removeEmptyDirs(dir: string, stopAt: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name), stopAt);
  }
  if (path.resolve(dir) === path.resolve(stopAt)) return;
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

const normalizeTarget = (to: string | undefined): string =>
  (to ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

interface ConfigFileShape extends NotesConfigFile {
  [key: string]: unknown;
}

function readConfigJson(configPath: string): ConfigFileShape {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as ConfigFileShape;
  } catch {
    return {};
  }
}

/**
 * 把 --from / --to 写回配置文件。
 * 有同名的 to 就更新那一条，没有就追加，方便一个仓库挂多套笔记。
 */
function persistSource(configPath: string, from: string, to: string | undefined): void {
  const exists = fs.existsSync(configPath);
  const base: ConfigFileShape = exists
    ? readConfigJson(configPath)
    : {
        _说明: 'from 改成 Freeplane 里笔记所在目录（可写绝对路径）；to 是导入到 public/notes 下的子目录。',
        notesDir: 'public/notes',
        extensions: DEFAULT_EXTENSIONS,
        prune: false,
      };

  // 用户给的相对路径按当前工作目录解析后写成绝对路径，避免和配置文件位置产生歧义
  const sourcePath = toPosix(path.resolve(from));
  const target = normalizeTarget(to) || normalizeTarget(base.sources?.[0]?.to) || '思维导图';
  const sources = Array.isArray(base.sources) ? base.sources.map((s) => ({ ...s })) : [];
  const index = sources.findIndex((s) => normalizeTarget(s.to) === target);
  if (index >= 0) sources[index] = { ...sources[index], from: sourcePath, to: target };
  else sources.push({ from: sourcePath, to: target });

  const next: ConfigFileShape = {
    ...base,
    notesDir: base.notesDir ?? 'public/notes',
    sources,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);

  console.log(`${exists ? '已更新配置' : '已生成配置'}：${toPosix(path.relative(process.cwd(), configPath))}`);
  console.log(`  from: ${sourcePath}`);
  console.log(`  to:   ${target}`);
}

/** --init：没有配置就生成（带占位提示），有配置且给了 --from 就更新 */
function runInit(configPath: string, from: string | undefined, to: string | undefined): boolean {
  const exists = fs.existsSync(configPath);
  if (from) {
    persistSource(configPath, from, to);
    return false;
  }
  if (exists) {
    console.log(`配置已存在：${toPosix(path.relative(process.cwd(), configPath))}（未改动）`);
    console.log('  要换源：npm run sync -- --from "<目录>" --to "<子目录>" --save');
    return false;
  }
  const template: NotesConfigFile = {
    notesDir: 'public/notes',
    sources: [{ from: '../../我的笔记/思维导图', to: '思维导图' }],
    extensions: DEFAULT_EXTENSIONS,
    prune: false,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`已生成配置：${toPosix(path.relative(process.cwd(), configPath))}`);
  console.log('⚠ 里面的 from 还是占位路径，请配合 --from 重跑，或直接改这个文件。');
  return true;
}

function main(argv: string[]): number {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const configPath = opts.configPath ? path.resolve(opts.configPath) : path.join(ROOT, CONFIG_NAME);

  if (opts.init) {
    const stopped = runInit(configPath, opts.from, opts.to);
    if (stopped) return 0;
  } else if (opts.save) {
    if (!opts.from) {
      console.error('✗ --save 需要同时指定 --from "<目录>"');
      return 1;
    }
    persistSource(configPath, opts.from, opts.to);
  }

  const cfg = loadConfig({ required: true, configPath });

  // --from/--to 只做一次性覆盖；用 --save / --init 才会写回配置
  const persisted = opts.init || opts.save;
  let sources = cfg.sources;
  if (opts.from && !persisted) {
    const to = (opts.to ?? sources[0]?.to ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    sources = [
      {
        label: to || '(根目录)',
        from: path.resolve(opts.from),
        to,
        extensions: DEFAULT_EXTENSIONS,
        ignore: DEFAULT_IGNORE,
      },
    ];
  }

  if (!sources.length) {
    console.error(`配置里没有任何 sources：${toPosix(path.relative(process.cwd(), cfg.configPath))}`);
    return 1;
  }

  console.log(`配置：${toPosix(path.relative(process.cwd(), cfg.configPath))}`);
  console.log(`目标：${toPosix(path.relative(process.cwd(), cfg.notesDir))}/`);
  if (opts.dryRun) console.log('模式：预览（不写文件）');

  const state = readState();
  let totalAdd = 0;
  let totalUpdate = 0;
  let totalRemove = 0;
  let totalPending = 0;
  let totalBytes = 0;
  let failed = false;

  for (const src of sources) {
    if (!fs.existsSync(src.from)) {
      console.error(`\n✗ [${src.label}] 源目录不存在：${toPosix(src.from)}`);
      console.error(
        `  ↳ 改一下 ${toPosix(path.relative(process.cwd(), cfg.configPath))} 里的 from，` +
          `或用 npm run sync -- --init --from "<Freeplane 笔记目录>" --to "${src.to || '笔记'}"`,
      );
      failed = true;
      continue;
    }
    const prev = state.sources[src.to]?.files ?? {};
    const result = syncSource(cfg, src, prev, opts);

    console.log(`\n▶ ${src.label}   ← ${toPosix(src.from)}`);
    console.log(
      `  新增 ${result.added.length} · 更新 ${result.updated.length} · 未变 ${result.unchanged}` +
        ` · 删除 ${result.removed.length}${result.pendingRemoval.length ? ` · 待删除 ${result.pendingRemoval.length}` : ''}` +
        ` · 复制 ${formatBytes(result.bytes)}`,
    );
    for (const f of result.added.slice(0, 20)) console.log(`  + ${f}`);
    if (result.added.length > 20) console.log(`  + … 其余 ${result.added.length - 20} 个`);
    for (const f of result.updated.slice(0, 20)) console.log(`  ~ ${f}`);
    if (result.updated.length > 20) console.log(`  ~ … 其余 ${result.updated.length - 20} 个`);
    for (const f of result.removed.slice(0, 20)) console.log(`  - ${f}`);
    if (result.pendingRemoval.length) {
      console.log(`  ! 源里已删除但目标仍保留（加 --prune 才会删）：`);
      for (const f of result.pendingRemoval.slice(0, 10)) console.log(`    - ${f}`);
    }

    totalAdd += result.added.length;
    totalUpdate += result.updated.length;
    totalRemove += result.removed.length;
    totalPending += result.pendingRemoval.length;
    totalBytes += result.bytes;

    if (!opts.dryRun) {
      state.sources[src.to] = { from: toPosix(src.from), files: result.files };
      if (result.removed.length) removeEmptyDirs(path.join(cfg.notesDir, src.to), cfg.notesDir);
    } else {
      state.sources[src.to] = { from: toPosix(src.from), files: { ...prev, ...result.files } };
    }
  }

  // 有源目录失败时不落盘，避免留下半套同步记录
  if (!opts.dryRun && !failed) writeState(state);

  console.log(
    `\n合计：新增 ${totalAdd} · 更新 ${totalUpdate} · 删除 ${totalRemove}` +
      ` · 复制 ${formatBytes(totalBytes)}${opts.dryRun ? '（预览，未写入）' : ''}`,
  );
  if (totalPending) console.log(`提示：${totalPending} 个文件在目标里已多余，需要时执行 npm run sync -- --prune`);
  if (!totalAdd && !totalUpdate && !totalRemove) console.log('已经是最新，无变化。');

  if (failed) return 1;

  if (opts.build) {
    if (opts.dryRun) {
      console.log('预览模式，跳过 --build');
      return 0;
    }
    console.log('\n开始构建…');
    const r = spawnSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true });
    return r.status ?? 1;
  }

  console.log('\n下一步：npm run check（图片体检）→ npm run build（产出 dist/）');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
}
