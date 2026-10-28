import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client';
import { createPreviewMedia } from '../src/media';
import { uploadFile } from '../src/sync';
import { checkedSettings, createServices, saveFile, startRunner } from '../src/services';
import { defaults } from '../src/rules';
import type { Media, PixivClient, Runtime, Schedule, Store, Task, Work } from '../src/types';

vi.mock('../src/client', () => ({ createClient: vi.fn() }));
vi.mock('../src/media', () => ({ createPreviewMedia: vi.fn() }));
vi.mock('../src/sync', () => ({ uploadFile: vi.fn(), syncData: vi.fn() }));

const stops: (() => void)[] = [];
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function lockManager() {
  const queues = new Map<string, Promise<unknown>>();
  return {
    request: vi.fn((name: string, options: LockOptions | ((lock: { name: string } | null) => unknown), callback?: (lock: { name: string } | null) => unknown): Promise<unknown> => {
      const settings = typeof options === 'function' ? {} : options;
      const run = typeof options === 'function' ? options : callback!;
      if (settings.ifAvailable && queues.has(name)) return Promise.resolve(run(null));
      const previous = queues.get(name) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => { settings.signal?.throwIfAborted(); return run({ name }); });
      queues.set(name, next);
      void next.finally(() => { if (queues.get(name) === next) queues.delete(name); }).catch(() => {});
      return next;
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { locks: lockManager() });
  vi.mocked(uploadFile).mockResolvedValue(undefined);
});
afterEach(async () => {
  stops.splice(0).forEach(stop => stop());
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});
const work = (id = '42'): Work => ({ id, kind: 'illust', title: 'Work', userId: '7', userName: 'Artist', thumb: '', pages: [{ original: 'https://i.pximg.net/original.jpg', regular: 'https://i.pximg.net/regular.jpg', width: 1, height: 1 }], tags: [], bookmarkCount: null, bookmarked: false, following: false, restricted: 0, ai: false, updated: '2026-01-01' });
const task = (id = '42', extra: Partial<Task> = {}): Task => ({ id, account: '1', ref: { kind: 'illust', id }, title: id, state: 'queued', settings: structuredClone(defaults), completed: [], progress: 0, total: 1, created: Number(id), ...extra });

async function fixture(tasks: Task[] = []) {
  const data = new Map<string, unknown>(tasks.map(task => [`task:${task.id}`, structuredClone(task)]));
  const listeners = new Set<() => void>();
  const store: Store = {
    get: async <T>(id: string) => structuredClone(data.get(id)) as T | undefined,
    set: vi.fn(async (id, value) => { data.set(id, structuredClone(value)); }),
    remove: vi.fn(async id => { data.delete(id); }),
    list: async <T>(prefix: string) => [...data.entries()].filter(([id]) => id.startsWith(prefix)).map(([id, value]) => ({ id, value: structuredClone(value) as T })),
  };
  const runtime: Runtime = {
    mode: 'userscript', store, request: vi.fn(),
    save: vi.fn(async (_data, _name, _conflict, receipt) => { await store.set(`receipt:${receipt}`, { state: 'done' }); }),
    notify: vi.fn(() => listeners.forEach(listener => listener())),
    subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
  const client: PixivClient = {
    account: vi.fn(async () => '1'), work: vi.fn(async ref => work(ref.id)), list: vi.fn(async () => ({ refs: [], next: false })), bookmark: vi.fn(), follow: vi.fn(),
  };
  const media: Media = { export: vi.fn(async function* (work) { yield { name: `${work.id}.jpg`, data: work.pages[0].original }; }), frames: vi.fn() };
  vi.mocked(createClient).mockReturnValue(client); vi.mocked(createPreviewMedia).mockReturnValue({ frames: media.frames });
  const services = await createServices(runtime);
  const start = () => { const stop = startRunner(services, media); stops.push(stop); return stop; };
  return { data, store, runtime, client, media, services, start };
}
async function state(f: Awaited<ReturnType<typeof fixture>>, id: string, expected: Task['state']) {
  await vi.waitFor(async () => { expect((await f.store.get<Task>(`task:${id}`))?.state).toBe(expected); }, { timeout: 4000, interval: 10 });
}

describe('runner concurrency and cancellation', () => {
  it('runs three independent saves concurrently and never exceeds the configured limit', async () => {
    const f = await fixture(['41', '42', '43', '44'].map(id => task(id)));
    const release = gate(); let active = 0; let maximum = 0;
    vi.mocked(f.runtime.save).mockImplementation(async (_data, _name, _conflict, receipt) => {
      active++; maximum = Math.max(maximum, active); await release.promise; active--;
      await f.store.set(`receipt:${receipt}`, { state: 'done' });
    });
    f.start();
    await vi.waitFor(() => { expect(active).toBe(3); });
    release.resolve();
    await state(f, '44', 'done');
    expect(maximum).toBe(3); expect(f.runtime.save).toHaveBeenCalledTimes(4);
  });
  it('serializes encoding while allowing the completed files to save independently', async () => {
    const settings = { ...structuredClone(defaults), animationFormat: 'gif' as const };
    const f = await fixture([task('41', { settings }), task('42', { settings })]);
    vi.mocked(f.client.work).mockImplementation(async ref => ({ ...work(ref.id), animation: { src: 'https://i.pximg.net/a.zip', frames: [{ file: '1.jpg', delay: 100 }] } }));
    const release = gate(); let active = 0; let maximum = 0; let started = 0;
    f.media.export = vi.fn(async function* (work) {
      active++; started++; maximum = Math.max(maximum, active);
      if (started === 1) await release.promise;
      active--; yield { name: `${work.id}.gif`, data: new Blob(['encoded']) };
    });
    f.start(); await vi.waitFor(() => { expect(started).toBe(1); });
    release.resolve(); await state(f, '42', 'done');
    expect(maximum).toBe(1);
  });
  it.each(['pause', 'remove'] as const)('aborts the active request when another tab performs %s', async action => {
    const f = await fixture([task()]); let observed: AbortSignal | undefined;
    vi.mocked(f.client.work).mockImplementation((_ref, signal) => { observed = signal; return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); });
    f.start(); await vi.waitFor(() => { expect(observed).toBeDefined(); });
    // Write shared state directly, simulating another JS context with no access
    // to this tab's AbortController map.
    if (action === 'remove') await f.store.remove('task:42');
    else { const current = (await f.store.get<Task>('task:42'))!; await f.store.set('task:42', { ...current, state: 'paused', attempt: undefined }); }
    f.runtime.notify();
    await vi.waitFor(() => { expect(observed!.aborted).toBe(true); });
    expect(f.runtime.save).not.toHaveBeenCalled();
    if (action === 'remove') expect(await f.store.get('task:42')).toBeUndefined();
  });
  it('rechecks the account before saving after a long conversion', async () => {
    const f = await fixture([task()]);
    f.media.export = vi.fn(async function* () { vi.mocked(f.client.account).mockResolvedValue('2'); yield { name: '42.jpg', data: new Blob(['file']) }; });
    f.start(); await state(f, '42', 'paused');
    expect(f.runtime.save).not.toHaveBeenCalled(); expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('retry and recovery', () => {
  it('limits transient read failures to two automatic retries', async () => {
    const f = await fixture([task()]);
    vi.mocked(f.client.work).mockRejectedValue(new Error('网络请求失败'));
    f.start(); await state(f, '42', 'failed');
    expect(f.client.work).toHaveBeenCalledTimes(3);
    expect((await f.store.get<Task>('task:42'))!.retries).toBe(2);
  });
  it('does not retry permission failures', async () => {
    const f = await fixture([task()]); vi.mocked(f.client.work).mockRejectedValue(new Error('Pixiv HTTP 403'));
    f.start(); await state(f, '42', 'failed'); expect(f.client.work).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown save outcomes uncertain even when resume is requested', async () => {
    const f = await fixture([task()]); vi.mocked(f.runtime.save).mockRejectedValue(new Error('保存超时'));
    f.start(); await state(f, '42', 'uncertain');
    await f.services.taskAction('42', 'resume');
    expect((await f.store.get<Task>('task:42'))!.state).toBe('uncertain');
    expect(f.runtime.save).toHaveBeenCalledTimes(1);
  });
  it.each(['saving', 'running'] as const)('recovers %s tasks without saving completed files again', async previous => {
    const f = await fixture([task('42', { state: previous, savingFile: previous === 'saving' ? 'first.jpg' : undefined, completed: previous === 'running' ? ['first.jpg'] : [] })]);
    await f.store.set('receipt:42:first.jpg', { state: 'done' });
    f.media.export = vi.fn(async function* () { yield { name: 'first.jpg', data: new Blob(['1']) }; yield { name: 'second.jpg', data: new Blob(['2']) }; });
    f.start(); await state(f, '42', 'done');
    expect(f.runtime.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.runtime.save).mock.calls[0][1]).toBe('second.jpg');
    expect((await f.store.get<Task>('task:42'))!.completed).toEqual(['first.jpg', 'second.jpg']);
  });
  it('retries only the upload after a local save has already completed', async () => {
    const f = await fixture([task()]);
    await f.store.set('cloud', { url: 'https://example.invalid/dav/', username: '', password: '', upload: true });
    vi.mocked(uploadFile).mockRejectedValueOnce(new Error('上传失败 (503)')).mockResolvedValue(undefined);
    f.start(); await state(f, '42', 'failed');
    const failed = (await f.store.get<Task>('task:42'))!;
    expect(failed.completed).toEqual(['42.jpg']); expect(failed.uploadPending).toEqual(['42.jpg']);
    await f.services.taskAction('42', 'resume'); await state(f, '42', 'done');
    expect(f.runtime.save).toHaveBeenCalledTimes(1); expect(uploadFile).toHaveBeenCalledTimes(2);
    expect((await f.store.get<Task>('task:42'))!.uploadPending).toEqual([]);
  });
  it('does not spin through notifications when the scheduler fails', async () => {
    const f = await fixture();
    await f.store.set('schedule:x', { id: 'x', enabled: true, next: 0, account: '1' });
    vi.mocked(f.client.account).mockRejectedValue(new Error('offline'));
    f.start(); await vi.waitFor(async () => { expect(await f.store.get('runnerError')).toBe('offline'); });
    expect(f.client.account).toHaveBeenCalledTimes(1); expect(f.runtime.notify).not.toHaveBeenCalled();
  });
});

describe('snapshots and backup boundaries', () => {
  it('uses schedule settings without overwriting concurrently changed user settings', async () => {
    const f = await fixture(); const ready = gate(); let entered = false;
    const schedule: Schedule = { id: 'x', source: 'https://www.pixiv.net/discovery', everyMinutes: 5, limit: 1, next: 0, enabled: true, account: '1', settings: { ...structuredClone(defaults), folder: 'scheduled' } };
    await f.store.set('schedule:x', schedule);
    vi.mocked(f.client.list).mockImplementation(async () => { entered = true; await ready.promise; return { refs: [{ id: '42', kind: 'illust' }], next: false }; });
    f.start(); await vi.waitFor(() => { expect(entered).toBe(true); });
    await f.services.configure({ ...structuredClone(defaults), folder: 'current' });
    await f.services.enqueue([{ id: '55', kind: 'illust' }]);
    ready.resolve();
    await vi.waitFor(async () => { expect((await f.services.tasks()).filter(task => task.state === 'done')).toHaveLength(2); });
    expect((await f.services.tasks()).find(task => task.ref.id === '42')!.settings.folder).toBe('scheduled');
    expect((await f.services.tasks()).find(task => task.ref.id === '55')!.settings.folder).toBe('current');
    expect(f.services.settings.folder).toBe('current');
  });
  it('rejects nonfinite scheduling and settings values without writing', async () => {
    const f = await fixture();
    await expect(f.services.schedule('https://www.pixiv.net/discovery', Infinity, 10)).rejects.toThrow('有限');
    await expect(f.services.schedule('https://www.pixiv.net/discovery', 10, NaN)).rejects.toThrow('有限');
    expect(() => checkedSettings({ ...defaults, concurrency: Infinity })).toThrow('有限');
    expect(f.store.set).not.toHaveBeenCalled();
  });
  it('validates every imported record before making any backup or settings writes', async () => {
    const f = await fixture();
    const reading = { account: '1', ref: { kind: 'illust', id: '42' }, title: 'Title', thumb: '', page: 0, position: 0, at: 1 };
    await expect(f.services.restore(JSON.stringify({ schema: 1, settings: defaults, records: [{ id: 'read:1:illust:42', value: reading }, { id: 'read:1:illust:43', value: { ...reading, page: -1 } }] }))).rejects.toThrow('阅读记录');
    expect(f.store.set).not.toHaveBeenCalled();
  });
  it('enforces the record limit even when every entry has an allowed prefix', async () => {
    const f = await fixture();
    const records = Array.from({ length: 100001 }, () => ({ id: 'saved:x', value: { at: 1, file: 'x' } }));
    await expect(f.services.restore(JSON.stringify({ schema: 1, settings: defaults, records }))).rejects.toThrow('100000');
    expect(f.store.set).not.toHaveBeenCalled();
  });
  it('does not import saved records as proof of files on this device', async () => {
    const f = await fixture();
    await f.services.restore(JSON.stringify({ schema: 1, settings: { ...defaults, directory: true }, records: [{ id: 'saved:foreign', value: { at: 1, file: 'foreign.jpg' } }] }));
    expect(await f.store.get('saved:foreign')).toBeUndefined();
    expect(f.services.settings.directory).toBe(false);
  });
});

it('cleans up only its newly created directory file on cancellation and never falls back to native save', async () => {
  const f = await fixture(); const controller = new AbortController();
  const writable = { write: vi.fn(async () => { controller.abort(); }), close: vi.fn(), abort: vi.fn(async () => {}) };
  const file = { createWritable: vi.fn(async () => writable) };
  const directory = {
    queryPermission: vi.fn(async () => 'granted'), removeEntry: vi.fn(async () => {}),
    getFileHandle: vi.fn(async (_name: string, options?: { create: boolean }) => { if (!options?.create) throw new DOMException('Missing', 'NotFoundError'); return file; }),
  };
  vi.stubGlobal('window', { showDirectoryPicker: async () => directory });
  await f.services.chooseDirectory();
  await expect(saveFile(f.runtime, new Blob(['x']), 'only-this-file.jpg', f.services.settings, 'r', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(directory.removeEntry).toHaveBeenCalledExactlyOnceWith('only-this-file.jpg');
  expect((await f.store.get<{ state: string }>('receipt:r'))!.state).toBe('failed');
  expect(f.runtime.save).not.toHaveBeenCalled(); expect(writable.close).not.toHaveBeenCalled();
});

it('records denied directory access as a known failure without changing the destination', async () => {
  const f = await fixture();
  const directory = { queryPermission: vi.fn(async () => 'denied'), getFileHandle: vi.fn() };
  vi.stubGlobal('window', { showDirectoryPicker: async () => directory });
  await f.services.chooseDirectory();
  await expect(saveFile(f.runtime, new Blob(['x']), 'file.jpg', f.services.settings, 'denied', new AbortController().signal)).rejects.toThrow('授权');
  expect(await f.store.get('receipt:denied')).toMatchObject({ state: 'failed' });
  expect(directory.getFileHandle).not.toHaveBeenCalled(); expect(f.runtime.save).not.toHaveBeenCalled();
});
