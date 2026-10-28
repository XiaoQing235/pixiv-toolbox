import type { HttpOptions, PixivClient, Ref, Runtime, Work, WorkKind } from './types';
import { refKey } from './rules';

type Data = Record<string, unknown>;
const origin = 'https://www.pixiv.net';
const object = (value: unknown): Data => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pixiv 返回了不完整的数据');
  return value as Data;
};
const optional = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Pixiv 返回了无效的作品列表');
  return value;
};
const id = (value: unknown): string => {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text) || text === '0') throw new Error('Pixiv ID 无效');
  return text;
};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Pixiv 缺少${field}`);
  return value;
};
const asset = (value: unknown): string => {
  const url = new URL(required(value, '图片地址'));
  if (url.protocol !== 'https:' || !/(^|\.)pximg\.net$/.test(url.hostname) || url.username || url.password) throw new Error('Pixiv 返回了无效的媒体地址');
  return url.href;
};
const optionalAsset = (value: unknown): string | undefined => value ? asset(value) : undefined;
const refs = (value: unknown, kind: WorkKind, field = 'id'): Ref[] => array(value)
  .filter(item => !optional(item).isAdContainer && (typeof item === 'string' || typeof item === 'number' || optional(item)[field] != null))
  .map(item => ({ kind, id: id(typeof item === 'object' ? object(item)[field] : item) }));

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Uses Pixiv's browser session; credentials never enter persistent application storage. */
export function createClient(runtime: Runtime): PixivClient {
  let nextStart = 0;
  let identity = 'guest';
  let token = '';
  let checkedAt = 0;
  let generation = 0;
  let identityRequest = 0;
  let refreshing: Promise<string> | undefined;
  const cache = new Map<string, { value: Work; at: number }>();
  const discoveries = new Map<string, Set<string>>();
  const seriesCursors = new Map<string, Map<number, number>>();

  function invalidate() {
    generation++;
    identityRequest++;
    cache.clear(); discoveries.clear(); seriesCursors.clear();
    checkedAt = 0; token = '';
  }

  async function request(path: string, options: HttpOptions = {}): Promise<string> {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + 250;
    await wait(start - now, options.signal);
    options.signal?.throwIfAborted();
    const response = await runtime.request(new URL(path, origin).href, options);
    options.signal?.throwIfAborted();
    if (response.status === 401 || response.status === 403) {
      invalidate();
      throw new Error(`Pixiv HTTP ${response.status}：登录已失效或没有访问权限，请重新登录后重试`);
    }
    if (response.status === 429) throw new Error('Pixiv HTTP 429：请求过于频繁，请稍后手动重试');
    if (response.status < 200 || response.status >= 300) throw new Error(`Pixiv HTTP ${response.status}`);
    if (typeof response.body !== 'string') throw new Error('Pixiv 返回了非文本响应');
    return response.body;
  }

  async function json(path: string, options?: HttpOptions): Promise<unknown> {
    const text = await request(path, options);
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new Error('Pixiv 响应无法解析，请检查登录状态或网站验证'); }
    if (optional(result).error) {
      const message = string(optional(result).message);
      if (/token|login|ログイン|登录|認証/i.test(message)) invalidate();
      throw new Error(`Pixiv：${message || '请求失败'}`);
    }
    return result;
  }

  async function body(path: string, signal?: AbortSignal): Promise<unknown> {
    return object(await json(path, { signal })).body;
  }

  async function readAccount(): Promise<string> {
    const requestId = ++identityRequest;
    try {
      const html = await request(`/?toolbox_time=${Date.now()}`);
      const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? html;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      let state: Data = {};
      const next = doc.querySelector('#__NEXT_DATA__')?.textContent;
      if (next) {
        const page = optional(optional(optional(JSON.parse(next)).props).pageProps);
        const serialized = page.serverSerializedPreloadedState;
        state = typeof serialized === 'string' ? object(JSON.parse(serialized)) : optional(serialized);
      }
      const legacy = doc.querySelector('meta[name="global-data"], meta[id="meta-global-data"]')?.getAttribute('content');
      const global = legacy ? object(JSON.parse(legacy)) : {};
      const self = optional(optional(state.userData).self);
      const uid = self.id ?? self.userId ?? optional(global.userData).id
        ?? head.match(/user_id\s*:\s*['"](\d+)['"]/)?.[1]
        ?? head.match(/['"]user_id['"]\s*,\s*['"]?(\d+)/)?.[1];
      const current = uid ? id(uid) : 'guest';
      const freshToken = string(optional(state.api).token ?? global.token)
        || head.match(/pixiv\.context\.token\s*=\s*['"](\w+)['"]/)?.[1] || '';
      if (requestId !== identityRequest) throw new Error('Pixiv 登录状态已更新，请重试');
      if (identity !== current) invalidate();
      identity = current; token = freshToken; checkedAt = Date.now();
      return identity;
    } catch (error) {
      if (requestId === identityRequest) invalidate();
      throw error;
    }
  }

  function account(): Promise<string> {
    if (!refreshing) {
      // Identity reads have no caller-owned AbortSignal, so hover cancellation cannot
      // cancel another caller's authentication check.
      refreshing = readAccount().finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }

  async function session() {
    if (!checkedAt || Date.now() - checkedAt > 15_000) await account();
  }

  function unchanged(version: number) {
    if (version !== generation) throw new Error('Pixiv 会话状态已改变，请重新执行此操作');
  }

  async function work(ref: Ref, signal?: AbortSignal): Promise<Work> {
    id(ref.id);
    signal?.throwIfAborted();
    await session();
    signal?.throwIfAborted();
    const version = generation;
    const key = refKey(ref);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 300_000) {
      cache.delete(key); cache.set(key, hit);
      return structuredClone(hit.value);
    }
    const data = object(await body(`/ajax/${ref.kind}/${ref.id}?time=${Date.now()}`, signal));
    if (id(data.id) !== ref.id) throw new Error('Pixiv 返回的作品 ID 不一致');
    const userId = id(data.userId);
    const user = object(await body(`/ajax/user/${userId}?full=1`, signal));
    const result: Work = {
      ...ref, title: required(data.title, '作品标题'), userId,
      userName: required(data.userName, '作者名称'), thumb: '', pages: [],
      tags: array(object(data.tags).tags).map(tag => required(object(tag).tag, '标签')),
      bookmarkCount: typeof data.bookmarkCount === 'number' && Number.isFinite(data.bookmarkCount) ? data.bookmarkCount : null,
      bookmarked: data.bookmarkData != null, following: user.isFollowed === true,
      restricted: typeof data.xRestrict === 'number' ? data.xRestrict : 0, ai: data.aiType === 2,
      updated: string(data.uploadDate ?? data.createDate), description: string(data.description),
      avatar: optionalAsset(user.imageBig ?? user.image), cover: optionalAsset(optional(user.background).url),
    };
    if (ref.kind === 'novel') {
      result.text = required(data.content, '小说正文');
      result.thumb = asset(data.coverUrl);
      result.seriesId = optional(data.seriesNavData).seriesId ? id(optional(data.seriesNavData).seriesId) : undefined;
      result.novelImages = {};
      for (const [imageId, image] of Object.entries(optional(data.textEmbeddedImages))) {
        result.novelImages[`uploadedimage:${id(imageId)}`] = asset(object(object(image).urls).original);
      }
      const inserted = [...new Set([...result.text.matchAll(/\[pixivimage:(\d+(?:-\d+)?)\]/g)].map(match => match[1]))];
      for (let offset = 0; offset < inserted.length; offset += 20) {
        const query = new URLSearchParams();
        inserted.slice(offset, offset + 20).forEach(imageId => query.append('id[]', imageId));
        const images = object(await body(`/ajax/novel/${ref.id}/insert_illusts?${query}`, signal));
        for (const [imageId, image] of Object.entries(images)) {
          const illust = optional(optional(image).illust);
          if (optional(image).visible === true && illust.images) result.novelImages[`pixivimage:${imageId}`] = asset(object(illust.images).original);
        }
      }
    } else {
      const urls = object(data.urls);
      result.thumb = asset(urls.small ?? urls.thumb ?? urls.regular);
      const pages = data.pageCount === 1 ? [data] : array(await body(`/ajax/illust/${ref.id}/pages`, signal));
      result.pages = pages.map(page => {
        const p = object(page); const images = object(p.urls);
        if (typeof p.width !== 'number' || typeof p.height !== 'number' || p.width <= 0 || p.height <= 0) throw new Error('Pixiv 图片尺寸无效');
        return { original: asset(images.original), regular: asset(images.regular), width: p.width, height: p.height };
      });
      if (result.pages.length !== data.pageCount) throw new Error('Pixiv 图片页数不完整');
      if (data.illustType === 2) {
        const animation = object(await body(`/ajax/illust/${ref.id}/ugoira_meta`, signal));
        result.animation = { src: asset(animation.originalSrc ?? animation.src), frames: array(animation.frames).map(frame => {
          const f = object(frame);
          if (typeof f.file !== 'string' || !/^[\w.-]+$/.test(f.file) || typeof f.delay !== 'number' || !Number.isFinite(f.delay) || f.delay <= 0) throw new Error('Pixiv 动图帧数据无效');
          return { file: f.file, delay: f.delay };
        }) };
        if (!result.animation.frames.length) throw new Error('Pixiv 动图没有帧数据');
      }
    }
    signal?.throwIfAborted(); unchanged(version);
    cache.set(key, { value: result, at: Date.now() });
    if (cache.size > 48) cache.delete(cache.keys().next().value!);
    return structuredClone(result);
  }

  async function writeAuth() {
    await account();
    if (identity === 'guest' || !token) throw new Error('请先登录 Pixiv；未能取得当前账号的操作凭据');
    return { version: generation, csrf: token };
  }

  async function post(path: string, payload: Data | URLSearchParams, auth: { version: number; csrf: string }) {
    unchanged(auth.version);
    const form = payload instanceof URLSearchParams;
    const result = await json(path, { method: 'POST', headers: {
      Accept: 'application/json', 'Content-Type': form ? 'application/x-www-form-urlencoded; charset=utf-8' : 'application/json; charset=utf-8',
      'x-csrf-token': auth.csrf,
    }, body: form ? payload.toString() : JSON.stringify(payload) });
    if (!(Array.isArray(result) && result.length === 0) && optional(result).error !== false) throw new Error('Pixiv 未确认操作成功，请刷新页面核实');
    unchanged(auth.version);
    generation++;
    cache.clear();
  }

  async function bookmark(ref: Ref, enabled: boolean, tags: string[] = [], privateBookmark = false) {
    id(ref.id);
    const auth = await writeAuth();
    const type = ref.kind === 'novel' ? 'novels' : 'illusts';
    if (enabled) {
      await post(`/ajax/${type}/bookmarks/add`, {
        [ref.kind === 'novel' ? 'novel_id' : 'illust_id']: ref.id,
        comment: '', restrict: privateBookmark ? 1 : 0, tags,
      }, auth);
    } else {
      const data = object(await body(`/ajax/${ref.kind}/${ref.id}?time=${Date.now()}`));
      if (data.bookmarkData == null) return;
      const bookmarkId = id(object(data.bookmarkData).id);
      const payload: Record<string, string> = ref.kind === 'novel' ? { del: '1', book_id: bookmarkId } : { bookmark_id: bookmarkId };
      await post(`/ajax/${type}/bookmarks/delete`, new URLSearchParams(payload), auth);
    }
  }

  async function follow(userId: string, enabled: boolean) {
    id(userId);
    const auth = await writeAuth();
    const payload = enabled
      ? new URLSearchParams({ mode: 'add', type: 'user', user_id: userId, tag: '', restrict: '0', format: 'json', recaptcha_enterprise_score_token: '' })
      : new URLSearchParams({ mode: 'del', type: 'bookuser', id: userId });
    await post(enabled ? '/bookmark_add.php' : '/rpc_group_setting.php', payload, auth);
  }

  async function list(source: string, page: number): Promise<{ refs: Ref[]; next: boolean }> {
    if (!Number.isInteger(page) || page < 1) throw new Error('页码必须从 1 开始');
    const url = new URL(source, origin);
    if (url.origin !== origin || url.username || url.password) throw new Error('仅支持 Pixiv 页面地址');
    const path = url.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '');
    const params = url.searchParams;
    const artwork = path.match(/^\/artworks\/(\d+)\/?$/);
    const novelId = path === '/novel/show.php' ? params.get('id') : null;
    if (artwork || novelId) return { refs: page === 1 ? [{ kind: novelId ? 'novel' : 'illust', id: id(novelId ?? artwork![1]) }] : [], next: false };
    await session();
    const version = generation;
    const get = async (route: string) => { const value = await body(route); unchanged(version); return object(value); };
    const offset = (page - 1) * 100;
    const user = path.match(/^\/users\/(\d+)(?:\/(.*))?$/);
    if (user) {
      const rest = user[2] ?? '';
      const kind: WorkKind = rest.includes('novels') ? 'novel' : 'illust';
      const type = kind === 'novel' ? 'novels' : 'illusts';
      if (rest.startsWith('bookmarks')) {
        const query = new URLSearchParams({ tag: params.get('tag') ?? '', offset: String(offset), limit: '100', rest: params.get('rest') === 'hide' ? 'hide' : 'show', order: params.get('order') ?? 'desc', mode: params.get('mode') ?? 'all' });
        const data = await get(`/ajax/user/${user[1]}/${type}/bookmarks?${query}`);
        const items = refs(data.works, kind);
        return { refs: items, next: offset + array(data.works).length < Number(data.total) };
      }
      const tag = params.get('tag') ?? (rest.includes('/') ? decodeURIComponent(rest.slice(rest.indexOf('/') + 1)) : '');
      if (tag) {
        const category = rest.startsWith('manga') ? 'manga' : rest.startsWith('artworks') ? 'illustmanga' : type;
        const data = await get(`/ajax/user/${user[1]}/${category}/tag?${new URLSearchParams({ tag, offset: String(offset), limit: '100' })}`);
        const items = refs(data.works, kind);
        return { refs: items, next: offset + array(data.works).length < Number(data.total) };
      }
      const data = await get(`/ajax/user/${user[1]}/profile/all`);
      const categories = kind === 'novel' ? ['novels'] : rest.startsWith('manga') ? ['manga'] : rest.startsWith('illustrations') ? ['illusts'] : rest ? ['illusts', 'manga'] : ['illusts', 'manga', 'novels'];
      const all = categories.flatMap(category => Object.keys(optional(data[category])).map(value => ({ id: id(value), kind: category === 'novels' ? 'novel' as const : 'illust' as const })));
      const unique = [...new Map(all.map(ref => [refKey(ref), ref])).values()].sort((a, b) => Number(b.id) - Number(a.id));
      return { refs: unique.slice(offset, offset + 100), next: offset + 100 < unique.length };
    }
    const search = path.match(/^\/tags\/([^/]+)(?:\/(artworks|illustrations|manga|novels))?\/?$/);
    if (search || path === '/search') {
      const category = search ? search[2] ?? 'artworks' : params.get('type') === 'novel' ? 'novels' : params.get('type') === 'manga' ? 'manga' : 'illustrations';
      const keyword = search ? decodeURIComponent(search[1]) : params.get('q') ?? '';
      if (!keyword) throw new Error('搜索关键词为空');
      const kind = category === 'novels' ? 'novel' : 'illust';
      const query = new URLSearchParams(params); query.set('p', String(page)); query.set('q', keyword);
      if (kind === 'novel') query.set('gs', '0');
      const data = await get(`/ajax/search/${category}/${encodeURIComponent(keyword)}?${query}`);
      const key = { artworks: 'illustManga', illustrations: 'illust', manga: 'manga', novels: 'novel' }[category]!;
      const result = object(data[key]); const items = refs(result.data, kind);
      return { refs: items, next: items.length > 0 && page * (kind === 'novel' ? 30 : 60) < Number(result.total) };
    }
    if (/^\/bookmark_new_(illust|novel)(?:_r18)?\.php$/.test(path)) {
      const kind: WorkKind = path.includes('novel') ? 'novel' : 'illust';
      const data = await get(`/ajax/follow_latest/${kind}?${new URLSearchParams({ p: String(page), tag: params.get('tag') ?? '', mode: path.includes('_r18') ? 'r18' : 'all' })}`);
      const items = refs(object(data.page).ids, kind);
      return { refs: items, next: items.length > 0 };
    }
    if (path === '/ranking.php' || path === '/novel/ranking.php') {
      const kind: WorkKind = path.includes('novel') || params.get('content') === 'novel' ? 'novel' : 'illust';
      const query = new URLSearchParams(params); query.set('p', String(page)); query.set('mode', params.get('mode') ?? 'daily');
      if (kind === 'novel') {
        const data = await get(`/ajax/ranking/novel?${query}`); const display = object(data.display_a);
        const items = Array.isArray(display.rank_a) ? display.rank_a : Object.values(object(display.rank_a));
        return { refs: refs(items, 'novel'), next: Boolean(display.next) };
      }
      query.set('format', 'json');
      const data = object(await json(`/ranking.php?${query}`)); unchanged(version);
      return { refs: refs(data.contents, 'illust', 'illust_id'), next: Boolean(data.next) };
    }
    const series = path.match(/^\/novel\/series\/(\d+)\/?$/);
    if (series) {
      let cursors = seriesCursors.get(series[1]);
      if (!cursors || page === 1) { cursors = new Map([[1, 0]]); seriesCursors.set(series[1], cursors); }
      if (seriesCursors.size > 16) seriesCursors.delete(seriesCursors.keys().next().value!);
      if (!cursors.has(page)) throw new Error('小说系列需从第一页按顺序读取');
      const data = await get(`/ajax/novel/series_content/${series[1]}?limit=30&last_order=${cursors.get(page)}&order_by=asc`);
      const contents = array(object(data.page).seriesContents);
      if (contents.length) cursors.set(page + 1, Number(object(object(contents.at(-1)).series).contentOrder));
      return { refs: refs(contents, 'novel'), next: contents.length === 30 };
    }
    if (path === '/discovery' || path === '/discovery/artworks' || path === '/discovery/novels' || path === '/novel/discovery' || path === '/novel' || path === '/novel/' || path === '/' || path === '') {
      const kind: WorkKind = path.includes('novel') ? 'novel' : 'illust';
      const data = await get(`/ajax/discovery/${kind === 'novel' ? 'novels' : 'artworks'}?${new URLSearchParams({ mode: params.get('mode') ?? 'all', limit: '100' })}`);
      const items = refs(object(data.thumbnails)[kind], kind);
      const key = url.href; let seen = discoveries.get(key);
      if (!seen || page === 1) { seen = new Set(); discoveries.set(key, seen); }
      if (discoveries.size > 8) discoveries.delete(discoveries.keys().next().value!);
      const fresh = items.filter(ref => !seen!.has(ref.id)); fresh.forEach(ref => seen!.add(ref.id));
      // Discovery is a random feed without a page cursor; stop when the batch adds nothing.
      return { refs: fresh, next: fresh.length > 0 && seen.size < 5000 };
    }
    throw new Error('此 Pixiv 页面暂不支持批量读取');
  }

  return { work, account, bookmark, follow, list };
}
