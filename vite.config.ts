import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径，方便把 dist/ 丢到任意子目录（GitHub Pages 子路径也能用）
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
