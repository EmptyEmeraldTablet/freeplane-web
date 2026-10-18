import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { buildData } from './scripts/build-data.ts';

/**
 * 构建时先把 public/notes 解析成 JSON。
 * 放进插件里，是为了让「只跑 vite build」的环境（Cloudflare、Netlify 等
 * 直接执行 vite 的平台）也不会漏掉数据生成这一步。
 */
function notesData(): Plugin {
  return {
    name: 'freeplane-notes-data',
    apply: 'build',
    buildStart() {
      buildData();
    },
  };
}

export default defineConfig({
  // 显式声明 plugins 数组：有些平台（如 Cloudflare 的 wrangler 自动配置）
  // 会尝试往这里注入插件，没有数组就会报
  // "Cannot modify Vite config: could not find a valid plugins array."
  plugins: [notesData()],
  // 相对路径，方便把 dist/ 丢到任意子目录（GitHub Pages 子路径也能用）
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
