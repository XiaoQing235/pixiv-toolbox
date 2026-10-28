// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client';
import type { HttpOptions, HttpResult, Runtime } from '../src/types';

const media = 'https://i.pximg.net/image.jpg';
const profile = { userId: '7', name: 'Author', isFollowed: true, imageBig: media, background: { url: media } };
const artwork = { id: '42', title: 'Picture', userId: '7', userName: 'Author', tags: { tags: [{ tag: 'Original' }] }, urls: { original: media, regular: media, small: media }, pageCount: 1, width: 100, height: 200, illustType: 0, bookmarkData: null, xRestrict: 0 };
const response = (value: unknown, status = 200): HttpResult => ({ status, headers: {}, body: typeof value === 'string' ? value : JSON.stringify(value) });
const wrapped = (value: unknown) => response({ error: false, body: value });
const identity = (user = '1') => response(`<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { serverSerializedPreloadedState: JSON.stringify({ api: { token: 'fixture-csrf' }, userData: { self: { id: user } } }) } } })}</script></head></html>`);

function mock(handler: (url: URL, options?: HttpOptions) => HttpResult | Promise<HttpResult>) {
  const request = vi.fn(async (url: string, options?: HttpOptions) => handler(new URL(url), options));
  const runtime = { mode: 'extension', request } as unknown as Runtime;
  return { client: createClient(runtime), request };
}

// Advance only the client's rate limiter; API responses remain deterministic local fixtures.
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function run<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

describe('account data without DOMParser', () => {
  it.each(['double', 'single'])('reads the complete Next.js HTML fixture with %s-quoted attributes in a worker', async quote => {
    let html = String(identity('12').body);
    if (quote === 'single') html = html.replace('id="__NEXT_DATA__"', "id='__NEXT_DATA__'");
    const old = new DOMParser().parseFromString(html, 'text/html').querySelector('#__NEXT_DATA__')!.textContent!;
    const expected = JSON.parse(JSON.parse(old).props.pageProps.serverSerializedPreloadedState);
    vi.stubGlobal('DOMParser', undefined);
    const { client, request } = mock((url, options) => url.pathname === '/' ? response(html) : options?.method === 'POST' ? response([]) : wrapped(artwork));
    expect(await run(client.account())).toBe(expected.userData.self.id);
    await run(client.bookmark({ id: '42', kind: 'illust' }, true));
    expect(request.mock.calls.find(([, options]) => options?.method === 'POST')![1]!.headers?.['x-csrf-token']).toBe(expected.api.token);
  });
  it.each([
    '<html><meta id="meta-global-data" content="{&quot;userData&quot;:{&quot;id&quot;:&quot;1&quot;},&quot;token&quot;:&quot;fixture&quot;}"></html>',
    `<html><head><meta content='{"userData":{"id":"2"},"token":"fixture-\\&quot;&apos;&amp;&lt;&gt;&#65;&#x1F600;"}' name='global-data'></head><body></body></html>`,
    '<html><head><meta name="global-data" content="{&#34;userData&#34;:{&#34;id&#34;:&#34;&#51;&#34;},&#34;token&#34;:&#34;fixture-&#x26;&#34;}"></head></html>',
  ])('matches DOM parsing for legacy JSON attributes while running without a DOM', async html => {
    const old = new DOMParser().parseFromString(html, 'text/html').querySelector('meta[name="global-data"], meta[id="meta-global-data"]')!.getAttribute('content')!;
    const expected = JSON.parse(old);
    vi.stubGlobal('DOMParser', undefined);
    const { client, request } = mock((url, options) => url.pathname === '/' ? response(html) : options?.method === 'POST' ? response([]) : wrapped(artwork));
    expect(await run(client.account())).toBe(expected.userData.id);
    await run(client.bookmark({ id: '42', kind: 'illust' }, true));
    expect(request.mock.calls.find(([, options]) => options?.method === 'POST')![1]!.headers?.['x-csrf-token']).toBe(expected.token);
  });
  it('ignores example containers inside comments and unrelated script text', async () => {
    const fake = `<meta name='global-data' content='{"userData":{"id":"99"},"token":"wrong"}'>`;
    const html = `<html><head><!-- ${fake} --><script>const example = ${JSON.stringify(fake)};</script><meta name='global-data' content='{"userData":{"id":"1"},"token":"fixture"}'></head></html>`;
    vi.stubGlobal('DOMParser', undefined);
    const { client } = mock(() => response(html));
    expect(await run(client.account())).toBe('1');
  });
});

describe('work data', () => {
  it('normalizes a work and caches completed values without leaking caller mutation', async () => {
    const { client, request } = mock(url => url.pathname === '/' ? identity() : url.pathname.startsWith('/ajax/user') ? wrapped(profile) : wrapped(artwork));
    const first = await run(client.work({ id: '42', kind: 'illust' }));
    expect(first.bookmarkCount).toBeNull();
    expect(first.following).toBe(true);
    expect(first.pages).toEqual([{ original: media, regular: media, width: 100, height: 200 }]);
    first.tags.push('changed');
    expect((await run(client.work({ id: '42', kind: 'illust' }))).tags).toEqual(['Original']);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('clears account-specific work cache after account switching', async () => {
    let user = '1';
    const { client, request } = mock(url => url.pathname === '/' ? identity(user) : url.pathname.startsWith('/ajax/user') ? wrapped(profile) : wrapped(artwork));
    await run(client.work({ id: '42', kind: 'illust' }));
    user = '2';
    expect(await run(client.account())).toBe('2');
    await run(client.work({ id: '42', kind: 'illust' }));
    expect(request.mock.calls.filter(([url]) => new URL(url).pathname === '/ajax/illust/42')).toHaveLength(2);
  });
  it('does not reuse an aborted request or cache its result', async () => {
    const controller = new AbortController();
    let shouldAbort = true;
    const { client, request } = mock(url => {
      if (url.pathname === '/') return identity();
      if (url.pathname.startsWith('/ajax/user')) return wrapped(profile);
      if (shouldAbort) { shouldAbort = false; controller.abort(); }
      return wrapped(artwork);
    });
    await expect(run(client.work({ id: '42', kind: 'illust' }, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect((await run(client.work({ id: '42', kind: 'illust' }))).id).toBe('42');
    expect(request.mock.calls.filter(([url]) => new URL(url).pathname === '/ajax/illust/42')).toHaveLength(2);
  });
  it('allows simultaneous work reads while cancellation remains caller-specific', async () => {
    const controller = new AbortController();
    let first = true;
    const { client, request } = mock(url => {
      if (url.pathname === '/') return identity();
      if (url.pathname.startsWith('/ajax/user')) return wrapped(profile);
      if (first) { first = false; controller.abort(); }
      return wrapped(artwork);
    });
    const results = await run(Promise.allSettled([
      client.work({ id: '42', kind: 'illust' }, controller.signal),
      client.work({ id: '42', kind: 'illust' }),
    ]));
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(request.mock.calls.filter(([url]) => new URL(url).pathname === '/')).toHaveLength(1);
  });
  it('preserves ugoira frame delays and maps both kinds of novel illustrations', async () => {
    const { client } = mock(url => {
      if (url.pathname === '/') return identity();
      if (url.pathname.startsWith('/ajax/user')) return wrapped(profile);
      if (url.pathname.endsWith('/ugoira_meta')) return wrapped({ originalSrc: 'https://i.pximg.net/animation.zip', frames: [{ file: '000000.jpg', delay: 80 }] });
      if (url.pathname.endsWith('/insert_illusts')) return wrapped({ '99-2': { visible: true, illust: { images: { original: media } } } });
      if (url.pathname === '/ajax/novel/42') return wrapped({ ...artwork, content: '[uploadedimage:8][pixivimage:99-2]', coverUrl: media, textEmbeddedImages: { '8': { urls: { original: media } } } });
      return wrapped({ ...artwork, illustType: 2 });
    });
    expect((await run(client.work({ id: '42', kind: 'illust' }))).animation?.frames[0].delay).toBe(80);
    expect((await run(client.work({ id: '42', kind: 'novel' }))).novelImages).toEqual({ 'uploadedimage:8': media, 'pixivimage:99-2': media });
  });
});

describe('writes and errors', () => {
  it('preserves an existing private bookmark when explicitly replacing its tags', async () => {
    const { client, request } = mock((url, options) => url.pathname === '/' ? identity() : options?.method === 'POST' ? response([]) : wrapped({ ...artwork, bookmarkData: { id: '987', private: true } }));
    await run(client.bookmark({ id: '42', kind: 'illust' }, true, ['替换标签']));
    const write = request.mock.calls.find(([, options]) => options?.method === 'POST')![1]!;
    expect(JSON.parse(String(write.body))).toMatchObject({ tags: ['替换标签'], restrict: 1 });
  });
  it('does not rewrite an existing bookmark when tags are omitted', async () => {
    const { client, request } = mock(url => url.pathname === '/' ? identity() : wrapped({ ...artwork, bookmarkData: { id: '987', private: true } }));
    await run(client.bookmark({ id: '42', kind: 'novel' }, true));
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('refuses to replace tags when the existing privacy value is unknown', async () => {
    const { client, request } = mock(url => url.pathname === '/' ? identity() : wrapped({ ...artwork, bookmarkData: { id: '987' } }));
    await expect(run(client.bookmark({ id: '42', kind: 'illust' }, true, []))).rejects.toThrow('隐私状态');
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('rejects privacy-only edits that would discard unread bookmark tags', async () => {
    const { client, request } = mock(url => url.pathname === '/' ? identity() : wrapped({ ...artwork, bookmarkData: { id: '987', private: true } }));
    await expect(run(client.bookmark({ id: '42', kind: 'illust' }, true, undefined, false))).rejects.toThrow('不能单独修改隐私');
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('still permits a new public bookmark with no tags', async () => {
    const { client, request } = mock((url, options) => url.pathname === '/' ? identity() : options?.method === 'POST' ? response([]) : wrapped(artwork));
    await run(client.bookmark({ id: '42', kind: 'novel' }, true));
    const write = request.mock.calls.find(([, options]) => options?.method === 'POST')![1]!;
    expect(JSON.parse(String(write.body))).toMatchObject({ novel_id: '42', tags: [], restrict: 0 });
  });
  it('uses bookmark record IDs for deletion and confirmed form fields for following', async () => {
    const { client, request } = mock((url, options) => url.pathname === '/' ? identity() : options?.method === 'POST' ? response([]) : wrapped({ ...artwork, bookmarkData: { id: '987', private: false } }));
    await run(client.bookmark({ id: '42', kind: 'illust' }, true, ['自定义'], true));
    await run(client.bookmark({ id: '42', kind: 'novel' }, false));
    await run(client.follow('7', true));
    await run(client.follow('7', false));
    const writes = request.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(JSON.parse(String(writes[0][1]!.body!))).toEqual({ illust_id: '42', comment: '', restrict: 1, tags: ['自定义'] });
    expect(writes[1][1]!.body).toBe('del=1&book_id=987');
    expect(new URL(writes[2][0]).pathname).toBe('/bookmark_add.php');
    expect(new URL(writes[3][0]).pathname).toBe('/rpc_group_setting.php');
    expect(writes[3][1]!.body).toBe('mode=del&type=bookuser&id=7');
  });
  it.each([403, 429])('reports HTTP %s without automatic retries', async status => {
    const { client, request } = mock(url => url.pathname === '/' ? identity() : response('blocked', status));
    await expect(run(client.work({ id: '42', kind: 'illust' }))).rejects.toThrow(String(status));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not treat an HTML follow response as a successful write', async () => {
    const { client } = mock(url => url.pathname === '/' ? identity() : response('<html>Verification required</html>'));
    await expect(run(client.follow('7', true))).rejects.toThrow('无法解析');
  });
  it('rejects unconfirmed JSON writes instead of claiming success', async () => {
    const { client } = mock(url => url.pathname === '/' ? identity() : response({ message: 'verification required' }));
    await expect(run(client.follow('7', true))).rejects.toThrow('未确认操作成功');
  });
});

describe('pagination', () => {
  it('keeps work kinds distinct on a user overview and selects the requested category', async () => {
    const { client } = mock(url => url.pathname === '/' ? identity() : wrapped({ illusts: { '42': null }, manga: { '41': null }, novels: { '42': null } }));
    expect((await run(client.list('/users/7', 1))).refs).toEqual([{ id: '42', kind: 'illust' }, { id: '42', kind: 'novel' }, { id: '41', kind: 'illust' }]);
    expect((await run(client.list('/users/7/manga', 1))).refs).toEqual([{ id: '41', kind: 'illust' }]);
  });
  it('reads novel ranking object entries and respects the upstream next marker', async () => {
    const { client } = mock(url => url.pathname === '/' ? identity() : wrapped({ display_a: { rank_a: { '0': { id: '42' } }, next: null } }));
    expect(await run(client.list('/novel/ranking.php?mode=rookie', 1))).toEqual({ refs: [{ id: '42', kind: 'novel' }], next: false });
  });
  it('retains bookmark privacy and uses the correct novel search page size', async () => {
    const { client, request } = mock(url => {
      if (url.pathname === '/') return identity();
      if (url.pathname.includes('bookmarks')) return wrapped({ works: [{ id: '42' }], total: 101 });
      return wrapped({ novel: { data: [{ id: '42' }], total: 91 } });
    });
    expect(await run(client.list('/users/7/bookmarks/novels?rest=hide&tag=a%26b', 2))).toEqual({ refs: [{ id: '42', kind: 'novel' }], next: false });
    const bookmarkURL = new URL(request.mock.calls[1][0]);
    expect(bookmarkURL.searchParams.get('offset')).toBe('100');
    expect(bookmarkURL.searchParams.get('tag')).toBe('a&b');
    expect(bookmarkURL.searchParams.get('rest')).toBe('hide');
    expect((await run(client.list('/search?q=猫&type=novel', 2))).next).toBe(true);
  });
  it('deduplicates discovery batches and stops a repeating feed', async () => {
    const { client } = mock(url => url.pathname === '/' ? identity() : wrapped({ thumbnails: { illust: [{ id: '42' }] } }));
    expect((await run(client.list('/discovery', 1))).next).toBe(true);
    expect(await run(client.list('/discovery', 2))).toEqual({ refs: [], next: false });
  });
  it('uses the returned series content order for the following request', async () => {
    const { client, request } = mock(url => url.pathname === '/' ? identity() : wrapped({ page: { seriesContents: Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), series: { contentOrder: index + 11 } })) } }));
    await run(client.list('/novel/series/5', 1));
    await run(client.list('/novel/series/5', 2));
    expect(new URL(request.mock.calls.at(-1)![0]).searchParams.get('last_order')).toBe('40');
  });
  it('rejects non-Pixiv URLs and invalid page numbers before making requests', async () => {
    const { client, request } = mock(() => identity());
    await expect(client.list('https://example.com/users/7', 1)).rejects.toThrow('Pixiv');
    await expect(client.list('/users/7', 0)).rejects.toThrow('页码');
    expect(request).not.toHaveBeenCalled();
  });
});
