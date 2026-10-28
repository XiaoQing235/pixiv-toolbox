import { createClient } from './client';
import { createMedia } from './media';
import { defaults, refKey, matches } from './rules';
import { database } from './store';
import { syncData, uploadFile } from './sync';
import type { CloudConfig, Reading, Ref, Runtime, Schedule, Services, Settings, Task } from './types';

let chosenDirectory: FileSystemDirectoryHandle | undefined;
const controllers = new Map<string, AbortController>();
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export async function exclusive<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('浏览器不支持安全的跨标签任务协调');
  return navigator.locks.request(`pixiv-toolbox:${name}`, run);
}
export function checkedSettings(value: unknown): Settings {
  const input = value as Partial<Settings>;
  if (!input || typeof input !== 'object') throw new Error('设置格式不正确');
  const settings = clone(defaults);
  for (const field of Object.keys(settings) as (keyof Settings)[]) {
    if (field === 'filter') continue;
    if (typeof input[field] === typeof settings[field]) (settings as unknown as Record<string, unknown>)[field] = input[field];
  }
  settings.directory = input.directory === true;
  for (const field of Object.keys(settings.filter) as (keyof Settings['filter'])[]) {
    const value = input.filter?.[field];
    if (Array.isArray(settings.filter[field])) {
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) (settings.filter as unknown as Record<string, unknown>)[field] = value.slice(0, 5000);
    } else if (typeof value === typeof settings.filter[field]) (settings.filter as unknown as Record<string, unknown>)[field] = value;
  }
  settings.hoverRatio = Math.min(100, Math.max(1, settings.hoverRatio || 50));
  settings.concurrency = Math.min(6, Math.max(1, settings.concurrency || 3));
  settings.preload = Math.min(4, Math.max(0, settings.preload || 0));
  if (!['zip', 'gif', 'mp4', 'webm'].includes(settings.animationFormat) || !['txt', 'epub'].includes(settings.novelFormat)) throw new Error('不支持该导出格式');
  return settings;
}
export async function createServices(runtime: Runtime): Promise<Services> {
  const client = createClient(runtime);
  const media = createMedia(runtime);
  const store = runtime.store;
  const service: Services = {
    runtime, client, media, settings: checkedSettings(await store.get('settings') || defaults),
    configure: async settings => { service.settings = checkedSettings(settings); await store.set('settings', service.settings); runtime.notify(); },
    enqueue: async (refs, options = {}) => {
      const account = await client.account();
      await exclusive('enqueue', async () => {
        const tasks = await service.tasks();
        for (const ref of refs) {
          if (!/^\d+$/.test(ref.id) || !['illust', 'novel'].includes(ref.kind)) throw new Error('作品编号不正确');
          const identity = JSON.stringify([refKey(ref), account, options.pages, options.asset, service.settings]);
          if (!options.force && tasks.some(task => !['failed', 'done'].includes(task.state) && task.id === identity)) continue;
          const id = options.force ? `${identity}:${crypto.randomUUID()}` : identity;
          const task: Task = { id, ref, account, title: `${ref.kind === 'novel' ? '小说' : '作品'} ${ref.id}`, state: 'queued', created: Date.now(), settings: clone(service.settings), completed: [], total: 0, progress: 0, ...options };
          await store.set(`task:${id}`, task);
        }
      });
      runtime.notify();
    },
    tasks: async () => (await store.list<Task>('task:')).map(row => row.value).sort((a, b) => b.created - a.created),
    taskAction: async (id, action) => {
      const task = await store.get<Task>(`task:${id}`);
      if (!task) return;
      controllers.get(id)?.abort();
      if (action === 'remove') await store.remove(`task:${id}`);
      else { task.state = action === 'confirm' ? 'done' : action === 'resume' ? 'queued' : 'paused'; task.attempt = undefined; task.error = undefined; await store.set(`task:${id}`, task); }
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
      if (records.length > 100000 || records.some(row => !row || typeof row.id !== 'string' || !row.id.startsWith('read:'))) {
        // Download history is informative across installations, never proof of a local file.
        if (records.some(row => !row || typeof row.id !== 'string' || !/^(read|saved):/.test(row.id))) throw new Error('备份含不支持的数据');
      }
      await store.set('restore-backup', await (await service.backup()).text());
      for (const row of records) if (row.id.startsWith('read:')) {
        const value = row.value as Reading;
        if (!value?.ref || !/^\d+$/.test(value.ref.id) || !Number.isFinite(value.at) || typeof value.title !== 'string') throw new Error('阅读记录不正确');
      }
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
      if (new URL(source).origin !== 'https://www.pixiv.net') throw new Error('请选择 Pixiv 页面作为任务来源');
      const schedule: Schedule = { id: crypto.randomUUID(), source, everyMinutes: Math.max(5, everyMinutes), limit: Math.min(1000, Math.max(1, limit)), next: Date.now() + Math.max(5, everyMinutes) * 60000, enabled: true, account: await client.account(), settings: clone(service.settings) };
      await store.set(`schedule:${schedule.id}`, schedule); runtime.notify();
    },
    removeSchedule: async id => { await store.remove(`schedule:${id}`); runtime.notify(); },
    cloud: () => store.get<CloudConfig>('cloud'),
    setCloud: async config => {
      const url = new URL(config.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请使用不含登录信息的 HTTPS 地址');
      if (runtime.mode === 'extension') {
        if (location.protocol !== 'chrome-extension:') { await chrome.runtime.sendMessage({ app: 'pixiv-toolbox', op: 'options', args: [] }); throw new Error('请在扩展设置页配置云端访问权限'); }
        if (!await chrome.permissions.request({ origins: [`${url.origin}/*`] })) throw new Error('未获得云端访问权限');
      }
      await store.set('cloud', { ...config, url: url.href.replace(/\/?$/, '/') });
    },
    sync: async choice => { await syncData(runtime, choice); service.settings = checkedSettings(await store.get('settings') || defaults); runtime.notify(); },
  };
  return service;
}

export async function saveFile(runtime: Runtime, data: Blob | string, name: string, settings: Settings, receipt: string, signal: AbortSignal): Promise<void> {
  if (!settings.directory) return runtime.save(data, name, 'uniquify', receipt, signal);
  const root = chosenDirectory || (runtime.mode === 'extension' ? await database().get<FileSystemDirectoryHandle>('directoryHandle') : undefined);
  if (!root || await (root as FileSystemDirectoryHandle & { queryPermission(o: { mode: string }): Promise<string> }).queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('需要重新选择并授权保存目录');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || name.startsWith('/')) throw new Error('保存路径不正确');
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const original = parts.at(-1)!;
  let candidate = original;
  for (let index = 1; ; index++) {
    try { await directory.getFileHandle(candidate); candidate = original.replace(/(\.[^.]+)?$/, ` (${index})$1`); }
    catch (error) { if ((error as DOMException).name === 'NotFoundError') break; throw error; }
  }
  signal.throwIfAborted();
  const file = await directory.getFileHandle(candidate, { create: true });
  const writable = await file.createWritable();
  try {
    if (typeof data === 'string') { const response = await runtime.request(data, { bytes: true, signal }); if (response.status !== 200) throw new Error(`原图读取失败 (${response.status})`); data = new Blob([new Uint8Array(response.body as Uint8Array)]); }
    signal.throwIfAborted(); await writable.write(data); await writable.close();
    await runtime.store.set(`receipt:${receipt}`, { state: 'done', at: Date.now() });
  } catch (error) { await writable.abort().catch(() => {}); throw error; }
}

export function startRunner(services: Services): () => void {
  const { runtime, client, media } = services;
  let stopped = false;
  async function tick() {
    if (stopped || await runtime.store.get('suspended')) return;
    await navigator.locks.request('pixiv-toolbox:runner', { ifAvailable: true }, async lock => {
      if (!lock || stopped) return;
      const account = await client.account();
      for (const plan of await services.schedules()) if (plan.enabled && plan.next <= Date.now() && plan.account === account) {
        plan.next = Date.now() + plan.everyMinutes * 60000;
        await runtime.store.set(`schedule:${plan.id}`, plan);
        const refs = new Map<string, Ref>();
        for (let page = 1; refs.size < plan.limit && page <= 100; page++) {
          const result = await client.list(plan.source, page);
          for (const ref of result.refs) {
            const work = await client.work(ref);
            const read = await runtime.store.get(`read:${account}:${refKey(ref)}`);
            if (matches(work, plan.settings.filter, read ? new Set([refKey(ref)]) : new Set())) refs.set(refKey(ref), ref);
            if (refs.size >= plan.limit) break;
          }
          if (!result.next || !result.refs.length) break;
        }
        const old = services.settings; services.settings = plan.settings;
        try { await services.enqueue([...refs.values()]); } finally { services.settings = old; }
      }
      for (const pending of (await services.tasks()).reverse()) {
        if (stopped || await runtime.store.get('suspended')) break;
        if (pending.state === 'saving') {
          pending.state = 'uncertain'; pending.error = '上次保存结果需要核实后再继续'; await runtime.store.set(`task:${pending.id}`, pending); continue;
        }
        if (pending.state === 'running') { pending.state = 'queued'; await runtime.store.set(`task:${pending.id}`, pending); }
        if (pending.state !== 'queued') continue;
        if (pending.account !== account) { pending.state = 'paused'; pending.error = '当前账号与创建任务时不同'; await runtime.store.set(`task:${pending.id}`, pending); continue; }
        const signal = new AbortController(); controllers.set(pending.id, signal);
        const attempt = crypto.randomUUID(); pending.attempt = attempt; pending.state = 'running'; pending.error = undefined;
        await runtime.store.set(`task:${pending.id}`, pending); runtime.notify();
        const check = async () => {
          const current = await runtime.store.get<Task>(`task:${pending.id}`);
          if (!current || current.attempt !== attempt || current.state === 'paused' || stopped || await runtime.store.get('suspended')) signal.abort();
          signal.signal.throwIfAborted();
        };
        try {
          const work = await client.work(pending.ref, signal.signal); pending.title = work.title; pending.total = pending.pages?.length || Math.max(1, work.pages.length);
          for await (const file of media.export(work, pending.settings, { pages: pending.pages, asset: pending.asset, signal: signal.signal })) {
            await check();
            const identity = JSON.stringify([pending.account, refKey(work), work.updated, file.name, pending.settings.animationFormat, pending.settings.novelFormat, pending.settings.metadata, pending.settings.directory]);
            const receipt = `${pending.id}:${file.name}`;
            const saved = await runtime.store.get(`saved:${identity}`);
            if (pending.completed.includes(file.name) || saved && !pending.force) { if (!pending.completed.includes(file.name)) pending.completed.push(file.name); continue; }
            pending.state = 'saving'; await runtime.store.set(`task:${pending.id}`, pending); runtime.notify();
            await saveFile(runtime, file.data, file.name, pending.settings, receipt, signal.signal);
            await runtime.store.set(`saved:${identity}`, { at: Date.now(), file: file.name });
            pending.completed.push(file.name); pending.progress = pending.completed.length; pending.state = 'running';
            await check(); await runtime.store.set(`task:${pending.id}`, pending); runtime.notify();
            const cloud = await services.cloud();
            if (cloud?.upload) { await uploadFile(runtime, cloud, file.name, file.data, signal.signal); pending.uploaded = [...pending.uploaded || [], file.name]; await runtime.store.set(`task:${pending.id}`, pending); }
          }
          await check(); pending.state = 'done'; pending.progress = pending.total = pending.completed.length;
        } catch (error) {
          const current = await runtime.store.get<Task>(`task:${pending.id}`);
          if (!current || current.attempt !== attempt) continue;
          pending.state = signal.signal.aborted ? 'paused' : pending.state === 'saving' ? 'uncertain' : 'failed';
          pending.error = error instanceof Error ? error.message : '任务失败';
        } finally { controllers.delete(pending.id); }
        const current = await runtime.store.get<Task>(`task:${pending.id}`);
        if (current?.attempt === attempt) await runtime.store.set(`task:${pending.id}`, pending);
        runtime.notify();
      }
    });
  }
  const wake = () => { void tick().catch(async error => { await runtime.store.set('runnerError', error instanceof Error ? error.message : '调度失败'); runtime.notify(); }); };
  const unsubscribe = runtime.subscribe(wake);
  const interval = setInterval(wake, 60000);
  wake();
  return () => { stopped = true; clearInterval(interval); unsubscribe(); for (const controller of controllers.values()) controller.abort(); };
}
