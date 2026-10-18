/** 删除构建产物（dist/ 与 public/data/），留下干净的仓库 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './shared.ts';

const targets = ['dist', 'public/data'];
for (const rel of targets) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { recursive: true, force: true });
    console.log(`- 已删除 ${rel}/`);
  }
}
console.log('清理完成：npm run dev / build 会重新生成这些文件。');
