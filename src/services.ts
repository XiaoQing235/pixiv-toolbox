import { createClient } from './client';
import { createPreviewMedia } from './media';
import { defaults, refKey, matches } from './rules';
import { database } from './store';
import { syncData, uploadFile } from './sync';
import { checkedSettings } from './settings';
export { checkedSettings } from './settings';
import type { CloudConfig, Media, Reading, Ref, Runtime, Schedule, Services, Settings, Task } from './types';

let chosenDirectory: FileSystemDirectoryHandle | undefined;
const controllers = new Map<string, AbortController>();
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export async function exclusive<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('浏览器不支持安全的跨标签任务协调');
  return navigator.locks.request(`pixiv-toolbox:${name}`, run);
}
async function enqueueWithSettings(services: Services, refs: Ref[], settings: Settings, options: Parameters<Services['enqueue']>[1] = {}, expectedAccount?: string): Promise<void> {
  const snapshot = checkedSettings(settings);
  for (const ref of refs) if (!/^\d+$/.test(ref.id) || !['illust', 'novel'].includes(ref.kind)) throw new Error('作品编号不正确');
  if (options.pages?.some(page => !Number.isInteger(page) || page < 0)) throw new Error('作品页码不正确');
  const account = await services.client.account();
  if (expectedAccount && expectedAccount !== account) throw new Error('当前账号与创建计划时不同');
  await exclusive('enqueue', async () => {
    if (await services.client.account() !== account) throw new Error('账号已切换，请重新创建任务');
    const tasks = await services.tasks();
    for (const ref of new Map(refs.map(ref => [refKey(ref), ref])).values()) {
      const identity = JSON.stringify([refKey(ref), account, options.pages, options.asset, snapshot]);
      if (!options.force && tasks.some(task => !['failed', 'done'].includes(task.state) && task.id === identity)) continue;
      const id = options.force ? `${identity}:${crypto.randomUUID()}` : identity;
      const task: Task = { id, ref: clone(ref), account, title: `${ref.kind === 'novel' ? '小说' : '作品'} ${ref.id}`, state: 'queued', created: Date.now(), settings: clone(snapshot), completed: [], total: 0, progress: 0, ...clone(options) };
      await services.runtime.store.set(`task:${id}`, task);
    }
  });
  services.runtime.notify();
}
export async function createServices(runtime: Runtime): Promise<Services> {
  const client = createClient(runtime);
  const media = createPreviewMedia(runtime);
  const store = runtime.store;
  const service: Services = {
    runtime, client, media, settings: checkedSettings(await store.get('settings') || defaults),
    configure: async settings => { const next = checkedSettings(settings); await exclusive('settings', async () => { await store.set('settings', next); service.settings = next; }); runtime.notify(); },
    enqueue: (refs, options) => enqueueWithSettings(service, refs, service.settings, options),
    tasks: async () => (await store.list<Task>('task:')).map(row => row.value).sort((a, b) => b.created - a.created),
    taskAction: async (id, action) => {
      controllers.get(id)?.abort();
      await exclusive(`task:${id}`, async () => {
        const task = await store.get<Task>(`task:${id}`);
        if (!task) return;
        if (action === 'remove') await store.remove(`task:${id}`);
        else {
          if (action === 'confirm') {
            if (task.state !== 'uncertain' || !task.savingFile) throw new Error('此任务没有可确认的保存文件');
            await store.set(`receipt:${id}:${task.savingFile}`, { state: 'done', confirmed: true, at: Date.now() });
            if (!task.completed.includes(task.savingFile)) task.completed.push(task.savingFile);
            task.savingFile = undefined;
          }
          task.state = action === 'pause' ? 'paused' : 'queued'; task.attempt = undefined; task.error = undefined; task.retries = 0;
          if (action === 'resume' && task.savingFile) {
            const receipt = await store.get<{ state: string }>(`receipt:${id}:${task.savingFile}`);
            if (receipt?.state === 'done') { if (!task.completed.includes(task.savingFile)) task.completed.push(task.savingFile); task.savingFile = undefined; }
            else if (receipt?.state === 'failed') task.savingFile = undefined;
            else { task.state = 'uncertain'; task.error = '请先核实上次保存结果'; }
          }
          await store.set(`task:${id}`, task);
        }
      });
      runtime.notify();
    },
    history: async () => {
      const account = await client.account();
      return (await store.list<Reading>(`read:${account}:`)).map(row => row.value).sort((a, b) => b.at - a.at);
    },
    read: async (work, page, position = 0) => {
      const account = await client.account();
      const reading: Reading = { account, ref: { id: work.id, kind: work.kind }, title: work.title, thumb: work.thumb, page, position, at: Date.now() };
      await store.set(`read:${account}:${refKey(work)}`, reading);
    },
    backup: async () => {
      const records = (await store.list<unknown>('read:')).concat(await store.list('saved:'));
      return new Blob([JSON.stringify({ schema: 1, settings: { ...service.settings, directory: false }, records }, null, 2)], { type: 'application/json' });
    },
    restore: async text => {
      if (text.length > 16 * 1024 * 1024) throw new Error('备份超过 16 MiB');
      const backup = JSON.parse(text);
      if (backup.schema !== 1 || !Array.isArray(backup.records)) throw new Error('不支持该备份版本');
      const settings = checkedSettings(backup.settings);
      const records = backup.records as { id: string; value: unknown }[];
      if (records.length > 100000) throw new Error('备份记录超过 100000 条');
      for (const row of records) {
        if (!row || typeof row.id !== 'string' || !/^(read|saved):/.test(row.id)) throw new Error('备份含不支持的数据');
        if (row.id.startsWith('read:')) {
          const value = row.value as Reading;
          if (!value?.ref || typeof value.ref.id !== 'string' || !/^\d+$/.test(value.ref.id) || !['illust', 'novel'].includes(value.ref.kind)
            || !/^(guest|\d+)$/.test(value.account) || row.id !== `read:${value.account}:${refKey(value.ref)}`
            || !Number.isFinite(value.at) || value.at < 0 || typeof value.title !== 'string' || typeof value.thumb !== 'string'
            || !Number.isInteger(value.page) || value.page < 0 || !Number.isFinite(value.position) || value.position < 0) throw new Error('阅读记录不正确');
        } else {
          const value = row.value as { at: number; file: string };
          if (!value || !Number.isFinite(value.at) || typeof value.file !== 'string') throw new Error('下载记录不正确');
        }
      }
      await store.set('restore-backup', await (await service.backup()).text());
      for (const row of records) if (row.id.startsWith('read:')) {
        const old = await store.get<Reading>(row.id), incoming = row.value as Reading;
        if (!old || incoming.at > old.at) await store.set(row.id, incoming);
      }
      await service.configure({ ...settings, directory: false });
    },
    chooseDirectory: async () => {
      if (runtime.mode === 'extension' && location.protocol !== 'chrome-extension:') {
        await chrome.runtime.sendMessage({ app: 'pixiv-toolbox', op: 'options', args: [] });
        throw new Error('请在打开的扩展设置页中选择目录');
      }
      const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (!picker) throw new Error('浏览器不支持自选目录');
      chosenDirectory = await picker({ mode: 'readwrite' });
      if (runtime.mode === 'extension') await database().set('directoryHandle', chosenDirectory);
      await service.configure({ ...service.settings, directory: true });
    },
    schedules: async () => (await store.list<Schedule>('schedule:')).map(row => row.value),
    schedule: async (source, everyMinutes, limit) => {
      const settings = clone(service.settings);
      const url = new URL(source);
      if (url.origin !== 'https://www.pixiv.net' || url.username || url.password) throw new Error('请选择 Pixiv 页面作为任务来源');
      if (!Number.isFinite(everyMinutes) || !Number.isFinite(limit)) throw new Error('计划间隔和数量必须是有限数字');
      const minutes = Math.min(525600, Math.max(5, Math.floor(everyMinutes)));
      const schedule: Schedule = { id: crypto.randomUUID(), source, everyMinutes: minutes, limit: Math.min(1000, Math.max(1, Math.floor(limit))), next: Date.now() + minutes * 60000, enabled: true, account: await client.account(), settings };
      await store.set(`schedule:${schedule.id}`, schedule); runtime.notify();
    },
    removeSchedule: async id => { await store.remove(`schedule:${id}`); runtime.notify(); },
    cloud: async () => { const config = await store.get<CloudConfig>('cloud'); return config ? { ...config, password: '' } : undefined; },
    setCloud: async config => {
      const url = new URL(config.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请使用不含登录信息的 HTTPS 地址');
      if (runtime.mode === 'extension') {
        if (location.protocol !== 'chrome-extension:') { await chrome.runtime.sendMessage({ app: 'pixiv-toolbox', op: 'options', args: [] }); throw new Error('请在扩展设置页配置云端访问权限'); }
        if (!await chrome.permissions.request({ origins: [`${url.origin}/*`] })) throw new Error('未获得云端访问权限');
      }
      const previous = await store.get<CloudConfig>('cloud');
      const address = url.href.replace(/\/?$/, '/');
      const password = config.password || (previous?.url === address && previous.username === config.username ? previous.password : '');
      await store.set('cloud', { ...config, password, url: address });
    },
    sync: async choice => { await syncData(runtime, choice); service.settings = checkedSettings(await store.get('settings') || defaults); runtime.notify(); },
  };
  return service;
}

export async function saveFile(runtime: Runtime, data: Blob | string, name: string, settings: Settings, receipt: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!settings.directory) return runtime.save(data, name, 'uniquify', receipt, signal);
  // Until a writable file is opened, a permission or path failure is a known
  // non-save rather than an ambiguous browser download outcome.
  await runtime.store.set(`receipt:${receipt}`, { state: 'failed', at: Date.now() });
  const root = chosenDirectory || (runtime.mode === 'extension' ? await database().get<FileSystemDirectoryHandle>('directoryHandle') : undefined);
  if (!root || await (root as FileSystemDirectoryHandle & { queryPermission(o: { mode: string }): Promise<string> }).queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('需要重新选择并授权保存目录');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part)) || name.startsWith('/')) throw new Error('保存路径不正确');
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const original = parts.at(-1)!;
  let candidate = original;
  const file = await exclusive('directory-name', async () => {
    for (let index = 1; ; index++) {
      try { await directory.getFileHandle(candidate); candidate = original.replace(/(\.[^.]+)?$/, ` (${index})$1`); }
      catch (error) { if ((error as DOMException).name === 'NotFoundError') break; throw error; }
    }
    signal.throwIfAborted();
    return directory.getFileHandle(candidate, { create: true });
  });
  let writable: FileSystemWritableFileStream | undefined;
  let closed = false;
  const abort = () => { void writable?.abort().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await runtime.store.set(`receipt:${receipt}`, { state: 'saving', at: Date.now() });
    signal.throwIfAborted();
    writable = await file.createWritable();
    if (typeof data === 'string') { const response = await runtime.request(data, { bytes: true, signal }); if (response.status !== 200) throw new Error(`原图读取失败 (${response.status})`); data = new Blob([new Uint8Array(response.body as Uint8Array)]); }
    signal.throwIfAborted(); await writable.write(data); signal.throwIfAborted(); await writable.close(); closed = true;
    await runtime.store.set(`receipt:${receipt}`, { state: 'done', at: Date.now() });
  } catch (error) {
    if (!closed) {
      await writable?.abort().catch(() => {});
      // Only this invocation's newly allocated file can be removed. Existing files
      // and the selected directory are never replaced when a write fails.
      try { await directory.removeEntry(candidate); await runtime.store.set(`receipt:${receipt}`, { state: 'failed', at: Date.now() }); } catch { /* Preserve an uncertain receipt if cleanup cannot be verified. */ }
    }
    throw error;
  } finally { signal.removeEventListener('abort', abort); }
}

export function startRunner(services: Services, media: Media): () => void {
  const { runtime, client } = services;
  const store = runtime.store;
  let stopped = false;
  let ticking = false;
  let again = false;
  const active = new Map<string, { controller: AbortController; attempt: string }>();
  const errorText = (error: unknown) => error instanceof Error ? error.message : '任务失败';
  const retryable = (error: unknown) => /网络请求失败|网络请求超时|Failed to fetch|fetch failed|NetworkError|HTTP 50[234]|读取失败 \(50[234]\)/i.test(errorText(error));
  const accountCheck = async (account: string) => {
    if (await client.account() !== account) { const error = new Error('当前账号与创建任务时不同'); error.name = 'AccountChangedError'; throw error; }
  };
  const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });

  async function cancelChanged() {
    const suspended = await store.get('suspended');
    for (const [id, running] of active) {
      const current = await store.get<Task>(`task:${id}`);
      if (stopped || suspended || !current || current.attempt !== running.attempt || !['running', 'saving'].includes(current.state)) running.controller.abort();
    }
  }

  async function recover(task: Task) {
    await exclusive(`task:${task.id}`, async () => {
      const current = await store.get<Task>(`task:${task.id}`);
      if (!current || !['saving', 'running'].includes(current.state)) return;
      if (current.savingFile) {
        const receipt = await store.get<{ state: string }>(`receipt:${current.id}:${current.savingFile}`);
        if (receipt?.state === 'done') {
          if (!current.completed.includes(current.savingFile)) current.completed.push(current.savingFile);
          current.savingFile = undefined; current.state = 'queued';
        } else if (receipt?.state === 'failed') { current.savingFile = undefined; current.state = 'queued'; }
        else { current.state = 'uncertain'; current.error = '上次保存结果需要核实后再继续'; }
      } else if (current.state === 'saving') { current.state = 'uncertain'; current.error = '上次保存文件缺少回执，不能自动重试'; }
      else current.state = 'queued';
      current.attempt = undefined; current.progress = current.completed.length;
      await store.set(`task:${current.id}`, current); runtime.notify();
    });
  }

  async function runTask(id: string) {
    const controller = new AbortController();
    const signal = controller.signal;
    const attempt = crypto.randomUUID();
    let pending: Task | undefined;
    await exclusive(`task:${id}`, async () => {
      const task = await store.get<Task>(`task:${id}`);
      if (!task || task.state !== 'queued' || stopped || await store.get('suspended')) return;
      pending = task; task.attempt = attempt; task.state = 'running'; task.error = undefined;
      await store.set(`task:${id}`, task);
      active.set(id, { controller, attempt }); controllers.set(id, controller);
    });
    if (!pending) return;
    const task = pending;
    runtime.notify();
    const check = async (account = false) => {
      await cancelChanged(); signal.throwIfAborted();
      if (account) { await accountCheck(task.account); await cancelChanged(); signal.throwIfAborted(); }
    };
    const persist = async () => {
      await exclusive(`task:${id}`, async () => {
        const current = await store.get<Task>(`task:${id}`);
        if (!current || current.attempt !== attempt || !['running', 'saving'].includes(current.state)) { controller.abort(); return; }
        await store.set(`task:${id}`, task);
      });
      runtime.notify();
    };
    let phase: 'read' | 'save' | 'upload' = 'read';
    try {
      for (;;) {
        try {
          await check(true);
          phase = 'read';
          const work = await client.work(task.ref, signal);
          task.title = work.title; task.total = task.pages?.length || Math.max(1, work.pages.length);
          const iterator = media.export(work, task.settings, { pages: task.pages, asset: task.asset, signal });
          const conversion = !task.asset && (work.animation && task.settings.animationFormat !== 'zip' || work.kind === 'novel' && task.settings.novelFormat === 'epub' || task.settings.mangaZip && work.pages.length > 1 || task.settings.metadata);
          try {
            for (;;) {
              await check(); phase = 'read';
              // Only producing an encoded file is serialized; downloading/saving
              // ordinary originals and uploading finished files remain concurrent.
              const next = conversion
                ? await navigator.locks.request('pixiv-toolbox:conversion', { signal }, () => iterator.next())
                : await iterator.next();
              if (next.done) break;
              const file = next.value;
              await check();
              const identity = JSON.stringify([task.account, refKey(work), work.updated, file.name, task.settings.animationFormat, task.settings.novelFormat, task.settings.metadata, task.settings.directory]);
              const saved = await store.get(`saved:${identity}`);
              const cloud = await runtime.store.get<CloudConfig>('cloud');
              const completed = task.completed.includes(file.name);
              if (!completed && saved && !task.force) task.completed.push(file.name);
              if (!completed && cloud?.upload && !(task.uploaded || []).includes(file.name)) task.uploadPending = [...new Set([...(task.uploadPending || []), file.name])];
              if (!task.completed.includes(file.name)) {
                await check(true);
                phase = 'save'; task.state = 'saving'; task.savingFile = file.name;
                await persist(); signal.throwIfAborted();
                await saveFile(runtime, file.data, file.name, task.settings, `${id}:${file.name}`, signal);
                task.completed.push(file.name); task.progress = task.completed.length; task.savingFile = undefined; task.state = 'running';
                // A completed receipt is local proof even if a pause races with the
                // subsequent task update. Never save the same completed file twice.
                await store.set(`saved:${identity}`, { at: Date.now(), file: file.name });
                await check(); await persist();
              }
              if (task.uploadPending?.includes(file.name)) {
                await check(true); phase = 'upload';
                if (!cloud?.upload) throw new Error('云上传待办尚未完成，请恢复云端配置后重试');
                await uploadFile(runtime, cloud, file.name, file.data, signal);
                task.uploaded = [...new Set([...(task.uploaded || []), file.name])];
                task.uploadPending = task.uploadPending.filter(name => name !== file.name);
                await check(); await persist();
              }
            }
          } finally { await iterator.return(undefined); }
          await check();
          if (task.uploadPending?.length) throw new Error('仍有未完成的云上传文件，请重新获取作品后重试');
          task.state = 'done'; task.error = undefined; task.progress = task.total = task.completed.length;
          await persist();
          break;
        } catch (error) {
          const current = await store.get<Task>(`task:${id}`);
          if (!current || current.attempt !== attempt || !['running', 'saving'].includes(current.state)) break;
          if (task.savingFile) {
            const receipt = await store.get<{ state: string }>(`receipt:${id}:${task.savingFile}`);
            if (receipt?.state === 'done') {
              if (!task.completed.includes(task.savingFile)) task.completed.push(task.savingFile);
              task.savingFile = undefined;
            } else if (receipt?.state === 'failed') task.savingFile = undefined;
          }
          const aborted = signal.aborted || error instanceof Error && error.name === 'AccountChangedError';
          if (!aborted && phase === 'read' && !task.savingFile && retryable(error) && (task.retries || 0) < 2) {
            task.retries = (task.retries || 0) + 1; task.state = 'running'; task.error = `网络错误，准备第 ${task.retries} 次重试`;
            await persist(); await delay(500 * task.retries, signal); continue;
          }
          task.state = task.savingFile ? 'uncertain' : aborted ? 'paused' : 'failed';
          task.error = errorText(error); task.progress = task.completed.length;
          await persist(); break;
        }
      }
    } finally {
      active.delete(id);
      if (controllers.get(id) === controller) controllers.delete(id);
    }
  }

  async function runSchedules() {
    for (const plan of await services.schedules()) {
      if (!plan.enabled || plan.next > Date.now() || stopped || await store.get('suspended')) continue;
      if (await client.account() !== plan.account) continue;
      if (!Number.isFinite(plan.everyMinutes) || !Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 1000) throw new Error('计划配置无效');
      plan.next = Date.now() + Math.max(5, plan.everyMinutes) * 60000;
      await store.set(`schedule:${plan.id}`, plan);
      const refs = new Map<string, Ref>();
      for (let page = 1; refs.size < plan.limit && page <= 100; page++) {
        if (stopped || await store.get('suspended')) return;
        const result = await client.list(plan.source, page);
        for (const ref of result.refs) {
          const work = await client.work(ref);
          const read = await store.get(`read:${plan.account}:${refKey(ref)}`);
          if (matches(work, plan.settings.filter, read ? new Set([refKey(ref)]) : new Set())) refs.set(refKey(ref), ref);
          if (refs.size >= plan.limit) break;
        }
        if (!result.next || !result.refs.length) break;
      }
      await enqueueWithSettings(services, [...refs.values()], plan.settings, {}, plan.account);
    }
  }

  async function tick() {
    if (stopped || await store.get('suspended')) return;
    if (!navigator.locks) throw new Error('浏览器不支持安全的跨标签任务协调');
    await navigator.locks.request('pixiv-toolbox:runner', { ifAvailable: true }, async lock => {
      if (!lock || stopped) return;
      const configured = await store.get<Settings>('settings');
      if (configured) services.settings = checkedSettings(configured);
      await runSchedules();
      for (const task of await services.tasks()) if (['saving', 'running'].includes(task.state)) await recover(task);
      const queued = (await services.tasks()).reverse().filter(task => task.state === 'queued');
      let index = 0;
      const workers = Array.from({ length: Math.min(checkedSettings(services.settings).concurrency, queued.length) }, async () => {
        while (index < queued.length && !stopped && !await store.get('suspended')) { const task = queued[index++]; await runTask(task.id); }
      });
      const results = await Promise.allSettled(workers);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
  }

  function wake() {
    if (stopped) return;
    if (ticking) { again = true; return; }
    ticking = true; again = false;
    void tick().catch(async error => {
      again = false;
      // Do not notify from a scheduler failure: the same subscription wakes this
      // scheduler and would otherwise retry a persistent error without a limit.
      await store.set('runnerError', errorText(error));
    }).finally(() => { ticking = false; if (again && !stopped) queueMicrotask(wake); });
  }
  const unsubscribe = runtime.subscribe(() => {
    void cancelChanged().then(wake).catch(error => { void store.set('runnerError', errorText(error)); });
  });
  const interval = setInterval(wake, 60000);
  wake();
  return () => { stopped = true; clearInterval(interval); unsubscribe(); for (const running of active.values()) running.controller.abort(); };
}
