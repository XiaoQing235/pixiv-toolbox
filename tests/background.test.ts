import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { records } = vi.hoisted(() => ({ records: new Map<string, unknown>() }));
vi.mock('../src/store', () => ({
  database: () => ({
    get: async (name: string) => structuredClone(records.get(name)),
    set: async (name: string, value: unknown) => { records.set(name, structuredClone(value)); },
    remove: async (name: string) => { records.delete(name); },
    list: async (prefix: string) => [...records].filter(([name]) => name.startsWith(prefix)).map(([id, value]) => ({ id, value: structuredClone(value) })),
  }),
}));

let background: typeof import('../src/background');
let changed: (delta: chrome.downloads.DownloadDelta) => void;
const downloads = {
  download: vi.fn<() => Promise<number>>(),
  search: vi.fn<(query: { id: number }) => Promise<{ id: number; state: `${chrome.downloads.State}` }[]>>(),
  cancel: vi.fn<(id: number) => Promise<void>>(),
  onChanged: { addListener: vi.fn((listener: typeof changed) => { changed = listener; }) },
};
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  records.clear();
  downloads.download.mockResolvedValue(8);
  downloads.search.mockImplementation(async ({ id }) => [{ id, state: 'in_progress' }]);
  downloads.cancel.mockImplementation(async id => { changed({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } }); });
  downloads.onChanged.addListener.mockImplementation(listener => { changed = listener; });
  vi.stubGlobal('chrome', {
    downloads,
    runtime: {
      id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => ({})), openOptionsPage: vi.fn(async () => {}),
    },
    offscreen: { hasDocument: vi.fn(async () => false), createDocument: vi.fn(async () => {}), closeDocument: vi.fn(async () => {}), Reason: { BLOBS: 'BLOBS' } },
    alarms: { onAlarm: { addListener: vi.fn() }, create: vi.fn(async () => {}) },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => {}) },
  });
  background = await import('../src/background');
});
afterEach(() => { vi.unstubAllGlobals(); });

const url = 'https://i.pximg.net/test.png';
const conflict = 'uniquify' as chrome.downloads.FilenameConflictAction;

describe('native download receipts', () => {
  it('honors cancellation while downloads.download is still waiting to return its ID', async () => {
    let returnId!: (id: number) => void;
    downloads.download.mockImplementation(() => new Promise(resolve => { returnId = resolve; }));
    const saved = background.saveDownload(url, 'test.png', conflict, 'late-id');
    const rejected = expect(saved).rejects.toThrow('USER_CANCELED');
    await vi.waitFor(() => { expect(downloads.download).toHaveBeenCalledOnce(); });
    expect(records.get('receipt:late-id')).toMatchObject({ state: 'saving' });
    await background.cancelDownload('late-id');
    expect(downloads.cancel).not.toHaveBeenCalled();
    expect(records.get('cancel:late-id')).toBe(true);

    returnId(8);
    await rejected;
    expect(downloads.cancel).toHaveBeenCalledExactlyOnceWith(8);
    expect(records.get('receipt:late-id')).toMatchObject({ state: 'failed', id: 8 });
    expect(records.has('cancel:late-id')).toBe(false);
  });

  it('records a known failed receipt when the browser rejects download creation', async () => {
    downloads.download.mockRejectedValue(new Error('Download permission denied'));
    await expect(background.saveDownload(url, 'test.png', conflict, 'rejected')).rejects.toThrow('Download permission denied');
    expect(records.get('receipt:rejected')).toEqual({ state: 'failed', at: expect.any(Number) });
    expect(downloads.search).not.toHaveBeenCalled();
    expect(downloads.cancel).not.toHaveBeenCalled();
  });

  it.each(['complete', 'interrupted'] as const)('settles the save and persists its receipt on a %s event', async state => {
    const saved = background.saveDownload(url, 'test.png', conflict, 'event');
    const settled = state === 'complete' ? expect(saved).resolves.toBeUndefined() : expect(saved).rejects.toThrow('下载被中断');
    await vi.waitFor(() => { expect(downloads.search).toHaveBeenCalledWith({ id: 8 }); });
    changed({ id: 8, state: { current: state } });
    await settled;
    expect(records.get('receipt:event')).toEqual({ state: state === 'complete' ? 'done' : 'failed', id: 8, at: expect.any(Number) });
  });
});

describe('receipt reconciliation after a background restart', () => {
  it.each(['complete', 'interrupted'] as const)('reconciles a saved ID against the browser %s state', async state => {
    records.set('receipt:recovered', { state: 'saving', id: 21, at: 100 });
    downloads.search.mockResolvedValue([{ id: 21, state }]);
    const receipt = await background.readReceipt('receipt:recovered');
    expect(downloads.search).toHaveBeenCalledExactlyOnceWith({ id: 21 });
    expect(receipt).toEqual({ state: state === 'complete' ? 'done' : 'failed', id: 21, at: 100 });
    expect(records.get('receipt:recovered')).toEqual(receipt);
  });

  it('keeps a receipt without an ID unresolved instead of reporting success or failure', async () => {
    records.set('receipt:unknown', { state: 'saving', at: 100 });
    expect(await background.readReceipt('receipt:unknown')).toEqual({ state: 'saving', at: 100 });
    expect(records.get('receipt:unknown')).toEqual({ state: 'saving', at: 100 });
    expect(downloads.search).not.toHaveBeenCalled();
    expect(downloads.download).not.toHaveBeenCalled();
  });
});
