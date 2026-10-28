import { extensionRuntime } from './runtime';
import { createServices } from './services';
import { mount } from './ui/mount';

const presence = () => window.postMessage({ product: 'pixiv-toolbox', type: 'extension-present' }, location.origin);
window.addEventListener('message', event => { if (event.source === window && event.origin === location.origin && event.data?.product === 'pixiv-toolbox' && event.data.type === 'query-extension') presence(); });
presence();
void createServices(extensionRuntime()).then(mount).catch(error => console.error('[Pixiv Toolbox]', error.message));
