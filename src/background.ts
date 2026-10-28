import { database } from './store';
import { allowed, decode, encode, fetchResult } from './runtime';
import type { HttpOptions, Schedule, Task } from './types';

const store = database();
const pending = new Map<number, { resolve(): void; reject(error: Error): void; receipt?: string }>();
let opening: Promise<void> | undefined;
let temporaryUsers = 0;
let lifecycle: Promise<void> = Promise.resolve();
const requests = new Map<string, AbortController>();
interface Receipt { state: 'saving' | 'done' | 'failed'; id?: number; at: number }
async function offscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  opening ||= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.BLOBS], justification: '处理动图、文件导出及可恢复下载任务' }).finally(() => { opening = undefined; });
  await opening;
}
export async function readReceipt(name: string): Promise<Receipt | undefined> {
  const receipt = await store.get<Receipt>(name);
  if (receipt?.state === 'saving' && receipt.id !== undefined) {
    const [item] = await chrome.downloads.search({ id: receipt.id });
    if (item && item.state !== 'in_progress') {
      receipt.state = item.state === 'complete' ? 'done' : 'failed';
      await store.set(name, receipt);
    }
  }
  return receipt;
}
export async function cancelDownload(receipt: string) {
  await store.set(`cancel:${receipt}`, true);
  const saved = await store.get<Receipt>(`receipt:${receipt}`);
  if (saved?.id !== undefined && saved.state === 'saving') await chrome.downloads.cancel(saved.id);
}
export async function saveDownload(url: string, filename: string, conflict: chrome.downloads.FilenameConflictAction, receipt?: string) {
  let id: number;
  try {
    if (!url.startsWith(`blob:${chrome.runtime.getURL('')}`) && !await allowed(url, store)) throw new Error('下载地址不被允许');
    if (!filename || filename.startsWith('/') || /(^|[\\/])\.\.([\\/]|$)|^[a-z]:/i.test(filename)) throw new Error('下载文件名不正确');
    if (receipt && await store.get(`cancel:${receipt}`)) throw new Error('下载已取消');
    if (receipt) await store.set(`receipt:${receipt}`, { state: 'saving', at: Date.now() });
    id = await chrome.downloads.download({ url, filename, conflictAction: conflict });
    if (receipt) await store.set(`receipt:${receipt}`, { state: 'saving', id, at: Date.now() });
  } catch (error) {
    if (receipt) { await store.set(`receipt:${receipt}`, { state: 'failed', at: Date.now() }); await store.remove(`cancel:${receipt}`); }
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject, receipt });
    // A very small cached file can finish before the listener is registered.
    void chrome.downloads.search({ id }).then(([item]) => { if (item?.state !== 'in_progress') void finish(id, item?.state === 'complete'); });
    if (receipt) void store.get(`cancel:${receipt}`).then(cancel => { if (cancel) return chrome.downloads.cancel(id); });
  });
}
async function finish(id: number, success: boolean, reason?: string) {
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  try {
    if (waiter.receipt) { await store.set(`receipt:${waiter.receipt}`, { state: success ? 'done' : 'failed', id, at: Date.now() }); await store.remove(`cancel:${waiter.receipt}`); }
    if (success) waiter.resolve(); else waiter.reject(new Error(`保存失败：${reason || '下载被中断'}`));
  } catch (error) { waiter.reject(error instanceof Error ? error : new Error('下载回执保存失败')); }
}
chrome.downloads.onChanged.addListener(delta => { if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') void finish(delta.id, delta.state.current === 'complete', delta.error?.current); });
async function broadcast() {
  const message = { app: 'pixiv-toolbox', op: 'changed' };
  for (const tab of await chrome.tabs.query({ url: 'https://www.pixiv.net/*' })) if (tab.id) void chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  void chrome.runtime.sendMessage(message).catch(() => {});
}
function maintain() {
  const next = lifecycle.then(async () => {
    const tasks = await store.list<Task>('task:');
    const schedules = await store.list<Schedule>('schedule:');
    const needed = temporaryUsers > 0 || pending.size > 0 || tasks.some(row => ['queued', 'running', 'saving'].includes(row.value.state)) || schedules.some(row => row.value.enabled && row.value.next <= Date.now());
    if (needed) await offscreen();
    else if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  });
  lifecycle = next.catch(() => {});
  return next;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.app !== 'pixiv-toolbox' || message.op === 'changed' || message.op === 'blob') return;
  if (sender.id !== chrome.runtime.id || !sender.url || !(sender.url.startsWith(chrome.runtime.getURL('')) || new URL(sender.url).origin === 'https://www.pixiv.net')) return;
  const run = async () => {
    const [first, second, third, fourth] = message.args || [];
    switch (message.op) {
      case 'get': return String(first).startsWith('receipt:') ? readReceipt(String(first)) : store.get(String(first));
      case 'set': await store.set(String(first), second); return;
      case 'remove': await store.remove(String(first)); return;
      case 'list': return store.list(String(first));
      case 'request': {
        const options = second as HttpOptions & { encodedBody?: boolean; requestId?: string };
        if (options.encodedBody) options.body = decode(options.body as string);
        const controller = new AbortController();
        if (options.requestId) requests.set(options.requestId, controller);
        try {
          const result = await fetchResult(store, String(first), { ...options, signal: controller.signal });
          return { ...result, body: result.body instanceof Uint8Array ? encode(result.body) : result.body, encoded: result.body instanceof Uint8Array };
        } finally { if (options.requestId) requests.delete(options.requestId); }
      }
      case 'abortRequest': requests.get(String(first))?.abort(); return;
      case 'save': return saveDownload(String(first), String(second), third || 'uniquify', fourth);
      case 'saveBlob': {
        temporaryUsers++;
        try {
          await maintain();
          const result = await chrome.runtime.sendMessage({ app: 'pixiv-toolbox', op: 'blob', args: message.args });
          if (!result?.ok) throw new Error(result?.error || '文件处理失败');
          return;
        } finally { temporaryUsers--; void maintain(); }
      }
      case 'cancel': return cancelDownload(String(first));
      case 'options': return chrome.runtime.openOptionsPage();
      case 'notify': await maintain(); return broadcast();
      case 'wake': return maintain();
      default: throw new Error('不支持的操作');
    }
  };
  void run().then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error instanceof Error ? error.message : '操作失败' }));
  return true;
});
chrome.alarms.onAlarm.addListener(() => { void maintain().then(broadcast); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create('plans', { periodInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('plans', { periodInMinutes: 1 }); void maintain(); });
