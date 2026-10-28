import type { CloudConfig, HttpOptions, HttpResult, Runtime, Store } from './types';
import { database, privateStore } from './store';

export function encode(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}
export function decode(text: string): Uint8Array { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
export async function allowed(url: string, store: Store): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.hostname === 'www.pixiv.net' || /(^|\.)pximg\.net$/.test(parsed.hostname)) return true;
  const cloud = await store.get<CloudConfig>('cloud');
  return !!cloud?.url && parsed.origin === new URL(cloud.url).origin && parsed.pathname.startsWith(new URL(cloud.url).pathname);
}
export async function fetchResult(store: Store, url: string, options: HttpOptions = {}): Promise<HttpResult> {
  if (!await allowed(url, store)) throw new Error('该请求地址未获得访问许可');
  const response = await fetch(url, { method: options.method, headers: options.headers, body: options.body instanceof Uint8Array ? new Uint8Array(options.body).buffer : options.body,
    signal: options.signal, credentials: new URL(url).hostname === 'www.pixiv.net' ? 'include' : 'omit', redirect: 'error' });
  const size = Number(response.headers.get('content-length') || 0);
  if (size > 256 * 1024 * 1024) throw new Error('文件超过 256 MiB 内存处理上限');
  return { status: response.status, headers: Object.fromEntries(response.headers), body: options.bytes ? new Uint8Array(await response.arrayBuffer()) : await response.text() };
}
export function extensionRuntime(): Runtime {
  async function call<T>(op: string, args: unknown[] = []): Promise<T> {
    const reply = await chrome.runtime.sendMessage({ app: 'pixiv-toolbox', op, args });
    if (!reply?.ok) throw new Error(reply?.error || '扩展后台未响应');
    return reply.value as T;
  }
  return {
    mode: 'extension',
    store: { get: id => call('get', [id]), set: (id, value) => call('set', [id, value]), remove: id => call('remove', [id]), list: prefix => call('list', [prefix]) },
    request: async (url, options = {}) => {
      options.signal?.throwIfAborted();
      const { signal, ...init } = options;
      const wire = init.body instanceof Uint8Array ? { ...init, body: encode(init.body), encodedBody: true } : init;
      const result = await call<HttpResult & { encoded?: boolean }>('request', [url, wire]);
      signal?.throwIfAborted();
      return { ...result, body: result.encoded ? decode(result.body as string) : result.body };
    },
    save: async (data, filename, conflict = 'uniquify', receipt, signal) => {
      signal?.throwIfAborted();
      const cancel = () => { if (receipt) void call('cancel', [receipt]).catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (typeof data === 'string') await call('save', [data, filename, conflict, receipt]);
        else await call('saveBlob', [encode(new Uint8Array(await data.arrayBuffer())), data.type, filename, conflict, receipt]);
        signal?.throwIfAborted();
      } finally { signal?.removeEventListener('abort', cancel); }
    },
    notify: () => { void call('notify').catch(() => {}); },
    subscribe: callback => {
      const listener = (message: { app?: string; op?: string }) => { if (message.app === 'pixiv-toolbox' && message.op === 'changed') callback(); };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
  };
}
export function userscriptRuntime(): Runtime {
  const store = privateStore();
  return {
    mode: 'userscript', store,
    request: async (url, options = {}) => {
      if (!await allowed(url, store)) throw new Error('该请求地址未获得访问许可');
      options.signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const abort = () => { handle.abort(); reject(new DOMException('已取消', 'AbortError')); };
        const clean = () => options.signal?.removeEventListener('abort', abort);
        const handle = GM.xmlHttpRequest({ url, method: (options.method || 'GET') as 'GET', headers: options.headers, data: options.body instanceof Uint8Array ? new Blob([new Uint8Array(options.body)]) : options.body,
          responseType: options.bytes ? 'arraybuffer' : undefined, timeout: 60000,
          onload: result => { clean(); resolve({ status: result.status, headers: Object.fromEntries(result.responseHeaders.trim().split(/\r?\n/).filter(line => line.includes(':')).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; })), body: options.bytes ? new Uint8Array(result.response) : result.responseText }); },
          onerror: () => { clean(); reject(new Error('网络请求失败')); }, ontimeout: () => { clean(); reject(new Error('网络请求超时')); }, onabort: clean });
        options.signal?.addEventListener('abort', abort, { once: true });
      });
    },
    save: async (data, filename, conflict = 'uniquify', receipt, signal) => {
      signal?.throwIfAborted();
      if (receipt) await store.set(`receipt:${receipt}`, { state: 'saving', at: Date.now() });
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { handle.abort(); clean(); reject(new DOMException('已取消', 'AbortError')); };
        const clean = () => signal?.removeEventListener('abort', cancel);
        const handle = GM_download({ url: data as string, name: filename, saveAs: false, conflictAction: conflict,
          onload: () => { clean(); resolve(); }, onerror: error => { clean(); reject(new Error(`保存失败：${error.error}`)); }, ontimeout: () => { clean(); reject(new Error('保存超时')); } });
        signal?.addEventListener('abort', cancel, { once: true });
      });
      if (receipt) await store.set(`receipt:${receipt}`, { state: 'done', at: Date.now() });
    },
    notify: () => { void GM.setValue('changed', crypto.randomUUID()); },
    subscribe: callback => {
      const listener = GM.addValueChangeListener('changed', callback);
      return () => { void Promise.resolve(listener).then(id => GM.removeValueChangeListener(id)); };
    },
  };
}
export function localExtensionRuntime(save: Runtime['save'], notify: () => void): Runtime {
  const store = database();
  return { mode: 'extension', store, request: (url, options) => fetchResult(store, url, options), save, notify, subscribe: () => () => {} };
}
