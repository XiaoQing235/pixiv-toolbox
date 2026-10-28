import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { cloudOrigins } from './scripts/cloud-origins.mjs';
export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  define: { __CLOUD_ORIGINS__: JSON.stringify(cloudOrigins) },
  build: {
    target: 'chrome120', outDir: 'dist/extension', emptyOutDir: false, modulePreload: false,
    rolldownOptions: mode === 'pages'
      ? { input: { options: 'options.html', offscreen: 'offscreen.html' } }
      : { input: `src/${mode}.ts`, output: { format: ['content', 'presence'].includes(mode) ? 'iife' : 'es', entryFileNames: `${mode}.js`, codeSplitting: false } },
  },
}));
