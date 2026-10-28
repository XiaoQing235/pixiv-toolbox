import { defaults } from './rules';
import type { Settings } from './types';

export function checkedSettings(value: unknown): Settings {
  const input = value as Partial<Settings>;
  if (!input || typeof input !== 'object') throw new Error('设置格式不正确');
  const settings: Settings = JSON.parse(JSON.stringify(defaults));
  for (const field of Object.keys(settings) as (keyof Settings)[]) {
    if (field === 'filter') continue;
    if (typeof input[field] === typeof settings[field]) (settings as unknown as Record<string, unknown>)[field] = input[field];
  }
  settings.directory = input.directory === true;
  for (const field of ['hoverRatio', 'concurrency', 'preload'] as const) if (!Number.isFinite(settings[field])) throw new Error('设置数值必须有限');
  for (const field of Object.keys(settings.filter) as (keyof Settings['filter'])[]) {
    const value = input.filter?.[field];
    if (Array.isArray(settings.filter[field])) {
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) (settings.filter as unknown as Record<string, unknown>)[field] = value.slice(0, 5000);
    } else if (typeof value === typeof settings.filter[field]) (settings.filter as unknown as Record<string, unknown>)[field] = value;
  }
  if (!Number.isFinite(settings.filter.minBookmarks)) throw new Error('收藏数必须有限');
  settings.filter.minBookmarks = Math.max(0, Math.floor(settings.filter.minBookmarks));
  settings.hoverRatio = Math.min(100, Math.max(1, settings.hoverRatio));
  settings.concurrency = Math.min(6, Math.max(1, Math.floor(settings.concurrency)));
  settings.preload = Math.min(4, Math.max(0, Math.floor(settings.preload)));
  if (!['auto', 'light', 'dark'].includes(settings.theme) || !['zip', 'gif', 'mp4', 'webm'].includes(settings.animationFormat) || !['txt', 'epub'].includes(settings.novelFormat)) throw new Error('不支持该设置选项');
  return settings;
}
