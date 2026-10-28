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
  const response = await fetch(url, { method: options.method, headers: options.headers, body: options.body,
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
      const result = await call<HttpResult & { encoded?: boolean }>('request', [url, init]);
      signal?.throwIfAborted();
      return { ...result, body: result.encoded ? decode(result.body as string) : result.body };
    },
    save: async (data, filename, conflict = 'uniquify') => {
      if (typeof data === 'string') return call('save', [data, filename, conflict]);
      return call('saveBlob', [encode(new Uint8Array(await data.arrayBuffer())), data.type, filename, conflict]);
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
        const handle = GM.xmlHttpRequest({ url, method: (options.method || 'GET') as 'GET', headers: options.headers, data: options.body,
          responseType: options.bytes ? 'arraybuffer' : 'text', timeout: 60000,
          onload: result => { clean(); resolve({ status: result.status, headers: Object.fromEntries(result.responseHeaders.trim().split(/\r?\n/).filter(line => line.includes(':')).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; })), body: options.bytes ? new Uint8Array(result.response) : result.responseText }); },
          onerror: () => { clean(); reject(new Error('网络请求失败')); }, ontimeout: () => { clean(); reject(new Error('网络请求超时')); }, onabort: clean });
        options.signal?.addEventListener('abort', abort, { once: true });
      });
    },
    save: (data, filename, conflict = 'uniquify') => new Promise((resolve, reject) => {
      GM.download({ url: data as string, name: filename, saveAs: false, conflictAction: conflict,
        onload: () => resolve(), onerror: error => reject(new Error(`保存失败：${error.error}`)), ontimeout: () => reject(new Error('保存超时')) });
    }),
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
