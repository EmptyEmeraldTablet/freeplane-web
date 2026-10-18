#!/usr/bin/env node
/**
 * 一条命令完成：同步笔记 → 构建校验 → git 提交（可选推送）。
 *
 *   npm run sync:commit            同步 + 构建 + commit
 *   npm run sync:push              同上，并 git push 触发 Cloudflare Pages
 *   npm run sync:commit -- -m "自定义提交信息"
 *   npm run sync:commit -- --no-build      跳过构建校验
 *   npm run sync:commit -- --dry-run       只看步骤，不做任何写操作
 *
 * 只提交 notesDir（public/notes）里的内容，不会动源码或其他文件。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, loadConfig, toPosix } from './shared.ts';

interface CliOptions {
  push: boolean;
  build: boolean;
  prune: boolean;
  dryRun: boolean;
  message?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { push: false, build: true, prune: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    switch (flag) {
      case '--push':
        opts.push = true;
        break;
      case '--no-build':
        opts.build = false;
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--dry-run':
      case '-n':
        opts.dryRun = true;
        break;
      case '-m':
      case '--message': {
        const v = inline ?? argv[++i];
        if (!v) throw new Error(`${flag} 需要提交信息`);
        opts.message = v;
        break;
      }
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

const HELP = `同步并提交

用法：
  npm run sync:commit                     同步 → 构建 → git commit
  npm run sync:push                       同上，并 git push
  npm run sync:commit -- --no-build       跳过构建校验
  npm run sync:commit -- --prune          源里删掉的笔记也从仓库删除
  npm run sync:commit -- -m "提交信息"     自定义 commit message
  npm run sync:commit -- --dry-run        只打印步骤，不写任何东西

说明：
  · 只会 git add / commit 笔记目录（notes.config.json 的 notesDir，默认 public/notes）
  · 构建失败会中止，不会产生半成品提交
  · 笔记没有变化时自动跳过，不会产生空提交
`;

interface RunResult {
  status: number;
  out: string;
  error?: Error;
}

function run(cmd: string, args: string[], capture: boolean): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  return {
    status: r.status ?? 1,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    error: r.error ?? undefined,
  };
}

const git = (args: string[], capture = false): RunResult => run('git', args, capture);

/** npm 在 Windows 上是 npm.cmd，需要 shell */
function npm(script: string, extra: string[] = []): RunResult {
  const r = spawnSync(`npm run ${script} ${extra.join(' ')}`.trim(), {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  return { status: r.status ?? 1, out: '' };
}

interface ChangeCount {
  added: number;
  modified: number;
  deleted: number;
  files: string[];
  /** 配置文件是否也有改动（单独统计，不混进笔记数量） */
  configChanged: boolean;
}

function parsePorcelain(out: string, configRel: string | null): ChangeCount {
  const stats: ChangeCount = { added: 0, modified: 0, deleted: 0, files: [], configChanged: false };
  for (const line of out.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const index = trimmed[0]!;
    const file = trimmed.slice(3);
    if (configRel && file === configRel) {
      stats.configChanged = true;
      continue;
    }
    if (index === 'A') stats.added++;
    else if (index === 'D') stats.deleted++;
    else stats.modified++;
    stats.files.push(file);
  }
  return stats;
}

/** 从 git 输出里挑一行最像错误原因的 */
function pushErrorText(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.find((l) => /^(fatal|error|remote:|!)/i.test(l)) ?? lines[lines.length - 1] ?? '未知错误').slice(0, 160);
}

function describe(stats: ChangeCount): string {
  const parts: string[] = [];
  if (stats.added) parts.push(`新增 ${stats.added}`);
  if (stats.modified) parts.push(`修改 ${stats.modified}`);
  if (stats.deleted) parts.push(`删除 ${stats.deleted}`);
  return parts.join(' · ');
}

function defaultMessage(stats: ChangeCount): string {
  if (!stats.files.length) return 'chore: 更新笔记配置';
  return `notes: ${describe(stats)}${stats.configChanged ? ' · 更新配置' : ''}`;
}

function main(argv: string[]): number {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const steps = [
    `npm run sync${opts.prune ? ' -- --prune' : ''}`,
    opts.build ? 'npm run build' : '(跳过构建)',
    'git add -A -- <notesDir>',
    'git commit -m "<自动生成>"',
    opts.push ? 'git push' : '(不推送)',
  ];

  if (opts.dryRun) {
    console.log('将要执行：');
    for (const s of steps) console.log(`  · ${s}`);
    console.log('\n（--dry-run：没有写文件、也没有提交）');
    return 0;
  }

  // 1. 必须在 git 仓库里
  const repoCheck = git(['rev-parse', '--is-inside-work-tree'], true);
  if (repoCheck.status !== 0) {
    console.error('✗ 当前目录不在 git 仓库里。先 git init 或 git clone 一个仓库。');
    return 1;
  }
  const topLevel = git(['rev-parse', '--show-toplevel'], true).out.trim();
  const repoRoot = topLevel.split('\n')[0]!.trim();

  const cfg = loadConfig({ required: true });
  const notesRel = toPosix(path.relative(repoRoot, cfg.notesDir));
  if (!notesRel || notesRel.startsWith('..') || path.isAbsolute(notesRel)) {
    console.error(`✗ 笔记目录不在当前 git 仓库内：${toPosix(cfg.notesDir)}`);
    console.error(`  仓库根：${toPosix(repoRoot)}`);
    console.error('  请把 notes.config.json 的 notesDir 指到仓库里的路径。');
    return 1;
  }

  // 配置文件如果在仓库里，也一起提交（避免每次 sync 后工作区永远脏一块）
  const configRel = toPosix(path.relative(repoRoot, cfg.configPath));
  const configInRepo = Boolean(configRel) && !configRel.startsWith('..') && !path.isAbsolute(configRel);
  const paths = configInRepo ? [notesRel, configRel] : [notesRel];

  console.log(`仓库：${toPosix(path.relative(ROOT, repoRoot)) || '.'}`);
  console.log(`笔记：${notesRel}/`);

  // 2. 同步
  console.log('\n▶ 同步笔记');
  const sync = npm('sync', opts.prune ? ['--', '--prune'] : []);
  if (sync.status !== 0) {
    console.error('\n✗ 同步失败，已中止（没有提交任何东西）。');
    return 1;
  }

  // 3. 构建校验
  if (opts.build) {
    console.log('\n▶ 构建校验');
    const build = npm('build');
    if (build.status !== 0) {
      console.error('\n✗ 构建失败，已中止（没有提交任何东西）。');
      console.error('  修饰一下再试，或用 --no-build 强制跳过。');
      return 1;
    }
  }

  // 4. 暂存笔记（+ 配置）
  console.log('\n▶ 暂存改动');
  const add = git(['add', '-A', '--', ...paths]);
  if (add.status !== 0) {
    console.error(`✗ git add 失败：${add.out.trim()}`);
    return 1;
  }

  // core.quotepath=false：中文文件名不要被转成 \346\226\207 这种八进制
  const status = git(['-c', 'core.quotepath=false', 'status', '--porcelain', '--', ...paths], true);
  const stats = parsePorcelain(status.out, configInRepo ? configRel : null);
  if (!stats.files.length && !stats.configChanged) {
    console.log('笔记没有变化，跳过提交。');
    if (opts.push) console.log('提示：没有新提交，也就不会推送。');
    return 0;
  }

  if (stats.files.length) {
    console.log(`  待提交 ${stats.files.length} 个笔记文件`);
    for (const f of stats.files.slice(0, 10)) console.log(`    ${f}`);
    if (stats.files.length > 10) console.log(`    … 其余 ${stats.files.length - 10} 个`);
  }
  if (stats.configChanged) console.log(`  同时更新配置：${configRel}`);

  // 5. 提交
  const message = opts.message ?? defaultMessage(stats);
  const commit = git(['commit', '-m', message, '--', ...paths]);
  if (commit.status !== 0) {
    console.error('\n✗ git commit 失败（可能没有配置 user.name / user.email）。');
    return 1;
  }

  let head = '';
  const headResult = git(['log', '-1', '--pretty=%h %s'], true);
  if (headResult.status === 0) head = headResult.out.trim();

  // 6. 推送
  if (opts.push) {
    console.log('\n▶ 推送');
    const push = git(['push'], true);
    if (push.status !== 0) {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], true).out.trim();
      const retry = branch ? git(['push', '-u', 'origin', branch], true) : { status: 1, out: '' };
      if (retry.status !== 0) {
        console.error(`✗ 推送失败：${pushErrorText(push.out || retry.out)}`);
        console.error(`  提交已生成本地记录：${head}`);
        console.error('  配置好 remote 后手动 git push 即可。');
        return 1;
      }
    }
    console.log('✓ 已推送到远程，Cloudflare Pages 会自动开始构建。');
  }

  console.log(`\n✓ 完成：${head || message}`);
  if (!opts.push) console.log('下一步：npm run sync:push（提交并推送），或手动 git push');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
}
