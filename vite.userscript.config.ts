import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import monkey from 'vite-plugin-monkey';
export default defineConfig({
  plugins: [vue(), monkey({ entry: 'src/userscript.ts', userscript: {
    name: 'Pixiv Toolbox', namespace: 'pixiv-toolbox', version: '0.1.0', description: '预览、阅读、整理和下载 Pixiv 作品',
    match: ['https://www.pixiv.net/*'], 'run-at': 'document-idle', sandbox: 'DOM',
    connect: ['www.pixiv.net', 'pximg.net', '*'],
    grant: ['GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.listValues', 'GM.addValueChangeListener', 'GM.removeValueChangeListener', 'GM.xmlHttpRequest', 'GM_download', 'GM.registerMenuCommand'],
  }, build: { fileName: 'pixiv-toolbox.user.js', metaFileName: 'pixiv-toolbox.meta.js', systemjs: 'inline' } })],
  build: { target: 'chrome120', outDir: 'dist/userscript', modulePreload: false, rolldownOptions: { output: { charset: 'ascii' } } },
});
