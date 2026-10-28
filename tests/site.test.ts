// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inTrigger, latestRequest, parseRef, scanCards, watchCards } from '../src/site';
import type { Ref } from '../src/types';

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

describe('Pixiv card references', () => {
  it('reads artwork and novel IDs without accepting unrelated hosts or malformed IDs', () => {
    expect(parseRef('/en/artworks/123?utm_source=test')).toEqual({ kind: 'illust', id: '123' });
    expect(parseRef('https://www.pixiv.net/novel/show.php?id=45')).toEqual({ kind: 'novel', id: '45' });
    expect(parseRef('https://example.com/artworks/123')).toBeNull();
    expect(parseRef('/novel/show.php?id=oops')).toBeNull();
    expect(parseRef('/users/123')).toBeNull();
  });

  it('retains the actual anchor and image, including an added anchor as root', () => {
    document.body.innerHTML = '<a href="https://www.pixiv.net/artworks/7"><img src="thumb.jpg"></a><a href="https://www.pixiv.net/users/7">Author</a>';
    const anchor = document.querySelector('a')!;
    const cards = scanCards(anchor);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.element).toBe(anchor);
    expect(cards[0]?.image).toBe(anchor.querySelector('img'));
    expect(cards[0]?.ref.id).toBe('7');
  });

  it('updates reused and removed cards and disconnects cleanly', async () => {
    const callback = vi.fn();
    const stop = watchCards(callback);
    const link = document.createElement('a');
    link.href = 'https://www.pixiv.net/artworks/10';
    document.body.append(link);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callback.mock.lastCall?.[0][0].ref.id).toBe('10');
    link.href = 'https://www.pixiv.net/novel/show.php?id=11';
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callback.mock.lastCall?.[0][0].ref).toEqual({ kind: 'novel', id: '11' });
    link.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callback.mock.lastCall?.[0]).toEqual([]);
    stop();
    const count = callback.mock.calls.length;
    document.body.append(link);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callback).toHaveBeenCalledTimes(count);
  });
});

describe('instant central hover region', () => {
  const rect = { left: 100, top: 200, width: 200, height: 100 };
  it('uses the central half of each dimension at the default setting', () => {
    expect(inTrigger(rect, 150, 225, 50)).toBe(true);
    expect(inTrigger(rect, 250, 275, 50)).toBe(true);
    expect(inTrigger(rect, 149, 250, 50)).toBe(false);
    expect(inTrigger(rect, 200, 224, 50)).toBe(false);
  });
  it('treats 1 as one percent and 100 as the whole rectangle', () => {
    expect(inTrigger(rect, 200, 250, 1)).toBe(true);
    expect(inTrigger(rect, 198, 250, 1)).toBe(false);
    expect(inTrigger(rect, 100, 200, 100)).toBe(true);
  });
});

describe('latest preview request', () => {
  it('starts immediately, shares the same target request and rejects stale completion', async () => {
    const pending = new Map<string, (value: string) => void>();
    const signals = new Map<string, AbortSignal>();
    const load = vi.fn((item: Ref, signal: AbortSignal) => {
      signals.set(item.id, signal);
      return new Promise<string>(resolve => pending.set(item.id, resolve));
    });
    const requests = latestRequest(load);
    const first = requests.request({ kind: 'illust', id: '1' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(requests.request({ kind: 'illust', id: '1' })).toBe(first);
    const second = requests.request({ kind: 'illust', id: '2' });
    expect(signals.get('1')?.aborted).toBe(true);
    pending.get('2')!('new target');
    expect(await second).toBe('new target');
    pending.get('1')!('old target');
    expect(await first).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('discards canceled results even if the transport ignores AbortSignal', async () => {
    let finish!: (value: string) => void;
    const requests = latestRequest(() => new Promise<string>(resolve => { finish = resolve; }));
    const result = requests.request({ kind: 'novel', id: '9' });
    requests.cancel(); finish('late');
    expect(await result).toBeUndefined();
  });

  it('allows retrying the same target after a real failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce('ok');
    const requests = latestRequest<string>(load);
    await expect(requests.request({ kind: 'illust', id: '3' })).rejects.toThrow('network');
    await expect(requests.request({ kind: 'illust', id: '3' })).resolves.toBe('ok');
  });
});
