import type { Filter, Ref, Settings, Work } from './types';

export const defaults: Settings = {
  hover: true, hoverRatio: 50, theme: 'auto', preload: 2, hideAds: false,
  filename: '{artist}/{title}_{id}', folder: 'Pixiv', metadata: false,
  animationFormat: 'zip', novelFormat: 'epub', mangaZip: false, concurrency: 3,
  filter: { minBookmarks: 0, hideBookmarked: false, hideFollowing: false, hideRead: false, hideAdult: false, hideAI: false, users: [], tags: [] },
};

export function refKey(ref: Ref): string { return `${ref.kind}:${ref.id}`; }

export function matches(work: Work, filter: Filter, readSet = new Set<string>()): boolean {
  if (filter.minBookmarks > 0 && work.bookmarkCount !== null && work.bookmarkCount < filter.minBookmarks) return false;
  if (filter.hideBookmarked && work.bookmarked || filter.hideFollowing && work.following || filter.hideRead && readSet.has(refKey(work))) return false;
  if (filter.hideAdult && work.restricted > 0 || filter.hideAI && work.ai) return false;
  const normalize = (text: string) => text.trim().toLocaleLowerCase();
  if (filter.users.some(user => normalize(user) === normalize(work.userId) || normalize(user) === normalize(work.userName))) return false;
  const tags = new Set(work.tags.map(normalize));
  return !filter.tags.some(tag => tags.has(normalize(tag)));
}

function segment(value: string): string {
  const clean = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  const safe = clean === '.' || clean === '..' || !clean ? '_' : clean;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}

/** Page indexes remain zero-based, matching Pixiv's original image filenames. */
export function filename(work: Work, settings: Settings, page?: number, extension?: string): string {
  if (page !== undefined && (!Number.isInteger(page) || page < 0)) throw new Error('图片页码无效');
  const ext = (extension ?? (work.kind === 'novel' ? settings.novelFormat : work.animation ? settings.animationFormat : 'jpg')).replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('文件扩展名无效');
  const templates = [settings.folder, settings.filename || defaults.filename].filter(Boolean).map(value => value.replaceAll('\\', '/'));
  if (templates.some(template => /^(?:\/|[a-z]:)/i.test(template) || template.split('/').some(part => part === '..'))) throw new Error('文件名必须是相对路径，且不能包含 ..');
  const template = templates.join('/');
  const pageMarker = '\uE000';
  const variables: Record<string, string> = { artist: segment(work.userName), title: segment(work.title), id: segment(work.id), page: pageMarker };
  const rendered = template.replace(/\{(artist|title|id|page)\}/g, (_, field: string) => variables[field]);
  const parts = rendered.split('/').filter(Boolean).map(part => segment(segment(part).slice(0, 120)));
  const base = parts.pop() || segment(work.id);
  const suffix = page !== undefined && !base.includes(pageMarker) ? `_p${page}` : '';
  parts.push(`${base}${suffix}.${ext}`);
  return parts.join('/').replaceAll(pageMarker, String(page ?? 0));
}

/** Ratio is a percentage: 50 means the central half of both width and height. */
export function inTrigger(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, ratio = 50): boolean {
  if (![rect.left, rect.top, rect.width, rect.height, x, y, ratio].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || ratio <= 0 || ratio > 100) return false;
  const horizontal = rect.width * ratio / 200;
  const vertical = rect.height * ratio / 200;
  return Math.abs(x - rect.left - rect.width / 2) <= horizontal && Math.abs(y - rect.top - rect.height / 2) <= vertical;
}
export function parsePages(input: string, count: number): number[] {
  const selected = new Set<number>();
  for (const token of input.trim().split(/[,，\s]+/)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!range) throw new Error('页码格式应为 1,3-5');
    const first = Number(range[1]), last = Number(range[2] || range[1]);
    if (first < 1 || last < first || last > count) throw new Error('页码超出作品范围');
    for (let page = first; page <= last; page++) selected.add(page - 1);
  }
  return [...selected];
}
