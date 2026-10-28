const presence = () => window.postMessage({ product: 'pixiv-toolbox', type: 'extension-present' }, location.origin);
window.addEventListener('message', event => { if (event.source === window && event.origin === location.origin && event.data?.product === 'pixiv-toolbox' && event.data.type === 'query-extension') presence(); });
presence();
