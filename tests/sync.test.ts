import { describe, expect, it, vi } from 'vitest';
import { mergeSnapshots, syncData, uploadFile } from '../src/sync';
import { defaults } from '../src/rules';
import type { CloudConfig, HttpOptions, HttpResult, Reading, Runtime, Settings, Store } from '../src/types';

const config: CloudConfig = { url: 'https://example.invalid/dav/', username: '', password: '', upload: true };
const reading: Reading = { account: '1', ref: { kind: 'illust', id: '42' }, title: 'Title', thumb: 'https://i.pximg.net/thumb.jpg', page: 0, position: 0.5, at: 10 };
const response = (status: number, body: unknown = '', headers: Record<string, string> = {}): HttpResult => ({ status, headers, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
function fixture(handler: (url: string, options?: HttpOptions) => HttpResult | Promise<HttpResult>, initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries({ cloud: config, settings: structuredClone(defaults), ...initial }));
  const store: Store = {
    get: async <T>(id: string) => structuredClone(data.get(id)) as T | undefined,
    set: vi.fn(async (id, value) => { data.set(id, structuredClone(value)); }),
    remove: vi.fn(async id => { data.delete(id); }),
    list: async <T>(prefix: string) => [...data.entries()].filter(([id]) => id.startsWith(prefix)).map(([id, value]) => ({ id, value: structuredClone(value) as T })),
  };
  const runtime = { store, request: vi.fn(async (url: string, options?: HttpOptions) => handler(url, options)) } as unknown as Runtime;
  return { runtime, store, data };
}

describe('file upload verification', () => {
  it('creates directories and sends a conditional first upload', async () => {
    const f = fixture((_url, options) => response(options?.method === 'MKCOL' ? 201 : 204));
    await uploadFile(f.runtime, config, 'Artist/image.png', new Blob(['image']));
    const calls = vi.mocked(f.runtime.request).mock.calls;
    expect(calls.map(([, options]) => options!.method)).toEqual(['MKCOL', 'PUT']);
    expect(calls[1][1]!.headers?.['If-None-Match']).toBe('*');
    expect(calls[1][1]!.body).toEqual(new TextEncoder().encode('image'));
    expect(f.store.set).not.toHaveBeenCalled();
  });
  it('confirms a previous upload only when length and SHA-256 match', async () => {
    const f = fixture((_url, options) => options?.method === 'PUT' ? response(412) : response(200, new TextEncoder().encode('same bytes')));
    await expect(uploadFile(f.runtime, config, 'image.png', new Blob(['same bytes']))).resolves.toBeUndefined();
    expect(f.runtime.request).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.runtime.request).mock.calls[1][1]!.bytes).toBe(true);
  });
  it.each(['different length', 'xyz'])('never overwrites different content after a 412: %s', async remote => {
    const f = fixture((_url, options) => options?.method === 'PUT' ? response(412) : response(200, new TextEncoder().encode(remote)));
    await expect(uploadFile(f.runtime, config, 'image.png', new Blob(['abc']))).rejects.toThrow('内容不同');
    expect(vi.mocked(f.runtime.request).mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it.each([403, 404, 500])('keeps unreadable existing uploads pending verification for HTTP %s', async status => {
    const f = fixture((_url, options) => response(options?.method === 'PUT' ? 412 : status));
    await expect(uploadFile(f.runtime, config, 'image.png', new Blob(['abc']))).rejects.toThrow('上传结果待核实');
    expect(f.runtime.request).toHaveBeenCalledTimes(2);
  });
  it('does not convert cancellation during verification into an ordinary conflict', async () => {
    const controller = new AbortController();
    const f = fixture((_url, options) => {
      if (options?.method === 'PUT') return response(412);
      controller.abort(); return response(200, new TextEncoder().encode('abc'));
    });
    await expect(uploadFile(f.runtime, config, 'image.png', new Blob(['abc']), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects oversized local data before creating any remote directories', async () => {
    const f = fixture(() => response(201));
    const blob = new Blob(['x']); Object.defineProperty(blob, 'size', { value: 256 * 1024 * 1024 + 1 });
    await expect(uploadFile(f.runtime, config, 'dir/image.png', blob)).rejects.toThrow('256 MiB');
    expect(f.runtime.request).not.toHaveBeenCalled();
  });
});

describe('sync manifest validation', () => {
  it.each([
    ['directory authorization', { schema: 1, records: { 'setting:directory': true } }],
    ['unknown prefix', { schema: 1, records: { 'saved:foreign': { at: 1, file: 'x' } } }],
    ['mismatched reading ID', { schema: 1, records: { 'read:1:illust:99': reading } }],
    ['invalid position', { schema: 1, records: { 'read:1:illust:42': { ...reading, position: 2 } } }],
    ['invalid title type', { schema: 1, records: { 'read:1:illust:42': { ...reading, title: 5 } } }],
    ['unsupported setting', { schema: 1, records: { 'setting:unrecognized': true } }],
    ['clamped concurrency', { schema: 1, records: { 'setting:concurrency': 100 } }],
    ['wrong setting type', { schema: 1, records: { 'setting:hover': 'yes' } }],
    ['path traversal', { schema: 1, records: { 'setting:folder': '../other' } }],
    ['array records', { schema: 1, records: [] }],
    ['unexpected manifest fields', { schema: 1, records: {}, unexpected: true }],
  ])('rejects %s before any local or cloud write', async (_label, manifest) => {
    const f = fixture(() => response(200, manifest, { etag: 'v1' }));
    await expect(syncData(f.runtime, 'remote')).rejects.toThrow();
    expect(f.runtime.request).toHaveBeenCalledTimes(1);
    expect(f.store.set).not.toHaveBeenCalled(); expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('enforces the 16 MiB limit in bytes, including multibyte UTF-8', async () => {
    const f = fixture(() => response(200, '中'.repeat(Math.floor(16 * 1024 * 1024 / 3) + 1), { etag: 'v1' }));
    await expect(syncData(f.runtime)).rejects.toThrow('16 MiB');
    expect(f.runtime.request).toHaveBeenCalledTimes(1); expect(f.store.set).not.toHaveBeenCalled();
  });
  it('rejects over 100000 records before validating or writing any individual record', async () => {
    const records = Object.fromEntries(Array.from({ length: 100001 }, (_, index) => [`read:1:illust:${index + 1}`, null]));
    const f = fixture(() => response(200, { schema: 1, records }, { etag: 'v1' }));
    await expect(syncData(f.runtime)).rejects.toThrow('100000');
    expect(f.store.set).not.toHaveBeenCalled(); expect(f.runtime.request).toHaveBeenCalledTimes(1);
  });
  it('uses the same settings whitelist for export and keeps directory permission local', async () => {
    const f = fixture((_url, options) => response(options?.method === 'PUT' ? 201 : 404), {
      settings: { ...defaults, directory: true, unrelated: 'must not be exported' },
      'read:1:illust:42': reading,
    });
    await syncData(f.runtime);
    const put = vi.mocked(f.runtime.request).mock.calls.find(([, options]) => options?.method === 'PUT')![1]!;
    const sent = JSON.parse(String(put.body));
    expect(put.headers?.['If-None-Match']).toBe('*');
    expect(sent.records['setting:directory']).toBeUndefined(); expect(sent.records['setting:unrelated']).toBeUndefined();
    expect(sent.records['read:1:illust:42']).toEqual(reading);
    expect((await f.store.get<Settings>('settings'))!.directory).toBe(true);
  });
});

describe('conditional merge', () => {
  it.each([409, 412])('leaves local state untouched when the conditional manifest write returns %s', async status => {
    const f = fixture((_url, options) => options?.method === 'PUT' ? response(status) : response(200, { schema: 1, records: {} }, { ETag: 'v1' }));
    await expect(syncData(f.runtime)).rejects.toThrow('其他设备更新');
    const put = vi.mocked(f.runtime.request).mock.calls[1][1]!;
    expect(put.headers?.['If-Match']).toBe('v1');
    expect(f.store.set).not.toHaveBeenCalled(); expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('refuses an existing manifest without an ETag before writing', async () => {
    const f = fixture(() => response(200, { schema: 1, records: {} }));
    await expect(syncData(f.runtime)).rejects.toThrow('ETag');
    expect(f.runtime.request).toHaveBeenCalledTimes(1); expect(f.store.set).not.toHaveBeenCalled();
  });
  it('requires an explicit setting conflict choice and applies a valid remote choice', async () => {
    const remote = { schema: 1, records: { 'setting:theme': 'dark' } };
    const f = fixture((_url, options) => options?.method === 'PUT' ? response(204) : response(200, remote, { etag: 'v1' }));
    await expect(syncData(f.runtime)).rejects.toThrow('明确选择');
    expect(f.store.set).not.toHaveBeenCalled();
    await syncData(f.runtime, 'remote');
    expect((await f.store.get<Settings>('settings'))!.theme).toBe('dark');
  });
  it('keeps three-way change tracking, deletion, and latest reading precedence', () => {
    const base = { schema: 1 as const, records: { 'setting:theme': 'auto', 'read:1:illust:42': reading } };
    const local = { schema: 1 as const, records: { 'setting:theme': 'dark', 'read:1:illust:42': { ...reading, at: 20 } } };
    const remote = { schema: 1 as const, records: { 'setting:theme': 'light', 'read:1:illust:42': { ...reading, at: 30 } } };
    expect(mergeSnapshots(local, remote, base, 'local').records).toEqual({ 'setting:theme': 'dark', 'read:1:illust:42': { ...reading, at: 30 } });
    expect(mergeSnapshots(base, { schema: 1, records: {} }, base).records).toEqual({});
  });
});
