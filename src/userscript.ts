import { userscriptRuntime } from './runtime';
import { createServices, startRunner } from './services';
import { mount } from './ui/mount';

const runtime = userscriptRuntime();
let cleanup: (() => void) | undefined;
let stop: (() => void) | undefined;
let extensionPresent = false;
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.product !== 'pixiv-toolbox' || event.data.type !== 'extension-present') return;
  extensionPresent = true; cleanup?.(); stop?.();
  void runtime.store.set('suspended', true).then(() => runtime.notify());
});
window.postMessage({ product: 'pixiv-toolbox', type: 'query-extension' }, location.origin);
// Startup arbitration is separate from hover activation; hover has no delay.
setTimeout(() => {
  if (extensionPresent) return;
  void createServices(runtime).then(service => { if (extensionPresent) return; cleanup = mount(service); stop = startRunner(service); });
}, 80);
GM.registerMenuCommand('恢复脚本任务（请先停用扩展）', async () => {
  if (extensionPresent) { alert('请先停用 MV3 扩展并刷新页面'); return; }
  await runtime.store.set('suspended', false); runtime.notify();
});
