import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  build: {
    target: 'chrome120', outDir: 'dist/extension', emptyOutDir: false, modulePreload: false,
    rolldownOptions: mode === 'pages'
      ? { input: { options: 'options.html', offscreen: 'offscreen.html' }, output: { charset: 'ascii' } }
      : { input: `src/${mode}.ts`, output: { format: ['content', 'presence'].includes(mode) ? 'iife' : 'es', entryFileNames: `${mode}.js`, codeSplitting: false, charset: 'ascii' } },
  },
}));
