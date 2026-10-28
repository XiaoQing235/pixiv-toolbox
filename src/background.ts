import { database } from './store';
import { allowed, decode, encode, fetchResult } from './runtime';
import type { HttpOptions } from './types';

const store = database();
const pending = new Map<number, { resolve(): void; reject(error: Error): void; receipt?: string }>();
let opening: Promise<void> | undefined;
async function offscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  opening ||= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.BLOBS], justification: '处理动图、文件导出及可恢复下载任务' }).finally(() => { opening = undefined; });
  await opening;
}
async function save(url: string, filename: string, conflict: chrome.downloads.FilenameConflictAction, receipt?: string) {
  if (!url.startsWith(`blob:${chrome.runtime.getURL('')}`) && !await allowed(url, store)) throw new Error('下载地址不被允许');
  if (!filename || filename.startsWith('/') || /(^|[\\/])\.\.([\\/]|$)|^[a-z]:/i.test(filename)) throw new Error('下载文件名不正确');
  if (receipt) await store.set(`receipt:${receipt}`, { state: 'saving', at: Date.now() });
  const id = await chrome.downloads.download({ url, filename, conflictAction: conflict });
  if (receipt) await store.set(`receipt:${receipt}`, { state: 'saving', id, at: Date.now() });
  await new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject, receipt });
    // A very small cached file can finish before the listener is registered.
    void chrome.downloads.search({ id }).then(([item]) => { if (item?.state !== 'in_progress') void finish(id, item?.state === 'complete'); });
  });
}
async function finish(id: number, success: boolean, reason?: string) {
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  if (waiter.receipt) await store.set(`receipt:${waiter.receipt}`, { state: success ? 'done' : 'failed', id, at: Date.now() });
  if (success) waiter.resolve(); else waiter.reject(new Error(`保存失败：${reason || '下载被中断'}`));
}
chrome.downloads.onChanged.addListener(delta => { if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') void finish(delta.id, delta.state.current === 'complete', delta.error?.current); });
async function broadcast() {
  const message = { app: 'pixiv-toolbox', op: 'changed' };
  for (const tab of await chrome.tabs.query({ url: 'https://www.pixiv.net/*' })) if (tab.id) void chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  void chrome.runtime.sendMessage(message).catch(() => {});
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.app !== 'pixiv-toolbox' || message.op === 'changed' || message.op === 'blob') return;
  if (sender.id !== chrome.runtime.id || !sender.url || !(sender.url.startsWith(chrome.runtime.getURL('')) || new URL(sender.url).origin === 'https://www.pixiv.net')) return;
  const run = async () => {
    const [first, second, third, fourth] = message.args || [];
    switch (message.op) {
      case 'get': return store.get(String(first));
      case 'set': await store.set(String(first), second); return;
      case 'remove': await store.remove(String(first)); return;
      case 'list': return store.list(String(first));
      case 'request': {
        const options = second as HttpOptions & { encodedBody?: boolean };
        if (options.encodedBody) options.body = decode(options.body as string);
        const result = await fetchResult(store, String(first), options);
        return { ...result, body: result.body instanceof Uint8Array ? encode(result.body) : result.body, encoded: result.body instanceof Uint8Array };
      }
      case 'save': return save(String(first), String(second), third || 'uniquify', fourth);
      case 'saveBlob': {
        await offscreen();
        const result = await chrome.runtime.sendMessage({ app: 'pixiv-toolbox', op: 'blob', args: message.args });
        if (!result?.ok) throw new Error(result?.error || '文件处理失败');
        return;
      }
      case 'cancel': {
        const receipt = await store.get<{ id?: number }>(`receipt:${first}`);
        if (receipt?.id !== undefined) await chrome.downloads.cancel(receipt.id);
        return;
      }
      case 'options': return chrome.runtime.openOptionsPage();
      case 'notify': await offscreen(); return broadcast();
      case 'wake': return offscreen();
      default: throw new Error('不支持的操作');
    }
  };
  void run().then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error instanceof Error ? error.message : '操作失败' }));
  return true;
});
chrome.alarms.onAlarm.addListener(() => { void offscreen().then(broadcast); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create('plans', { periodInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('plans', { periodInMinutes: 1 }); void offscreen(); });
