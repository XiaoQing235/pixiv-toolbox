import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  build: {
    target: 'chrome120', outDir: 'dist/extension', emptyOutDir: false,
    rollupOptions: mode === 'pages'
      ? { input: { options: 'options.html', offscreen: 'offscreen.html' } }
      : { input: `src/${mode}.ts`, output: { format: mode === 'content' ? 'iife' : 'es', entryFileNames: `${mode}.js`, inlineDynamicImports: true } },
  },
}));
