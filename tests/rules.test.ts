import { describe, expect, it } from 'vitest';
import { defaults, filename, inTrigger, matches, refKey } from '../src/rules';
import type { Work } from '../src/types';

const work: Work = { kind: 'illust', id: '42', title: 'A/B:作品', userId: '7', userName: 'Artist', thumb: '', pages: [], tags: ['Original'], bookmarkCount: null, bookmarked: false, following: false, restricted: 0, ai: false, updated: '' };

describe('filters', () => {
  it('keeps unknown bookmark counts and separates illustration and novel read IDs', () => {
    expect(matches(work, { ...defaults.filter, minBookmarks: 100 })).toBe(true);
    expect(matches({ ...work, bookmarkCount: 99 }, { ...defaults.filter, minBookmarks: 100 })).toBe(false);
    expect(matches(work, { ...defaults.filter, hideRead: true }, new Set(['novel:42']))).toBe(true);
    expect(matches(work, { ...defaults.filter, hideRead: true }, new Set([refKey(work)]))).toBe(false);
  });
  it('combines blocked authors, tags, and adult settings', () => {
    expect(matches(work, { ...defaults.filter, users: ['7'] })).toBe(false);
    expect(matches(work, { ...defaults.filter, tags: [' original '] })).toBe(false);
    expect(matches({ ...work, restricted: 1 }, { ...defaults.filter, hideAdult: true })).toBe(false);
  });
});

describe('filenames', () => {
  it('allows template directories but sanitizes work data and retains page and extension', () => {
    expect(filename(work, defaults, 3, '.png')).toBe('Pixiv/Artist/A_B_作品_42_p3.png');
    expect(filename({ ...work, userName: '../CON', title: 'NUL' }, { ...defaults, filename: '{artist}/{title}_{page}' }, 2, 'jpg')).toBe('Pixiv/.._CON/NUL_2.jpg');
    expect(filename(work, { ...defaults, folder: '', filename: 'CON' }, undefined, 'zip')).toBe('_CON.zip');
  });
  it('rejects path traversal and absolute settings', () => {
    for (const folder of ['../out', 'C:\\out', '/out', '\\\\server\\share']) expect(() => filename(work, { ...defaults, folder })).toThrow('相对路径');
    expect(() => filename(work, { ...defaults, filename: '../out' })).toThrow();
    expect(() => filename(work, defaults, 0, '../jpg')).toThrow('扩展名');
  });
  it('preserves the page suffix when a long title would truncate its placeholder', () => {
    const result = filename({ ...work, title: 'x'.repeat(200) }, { ...defaults, filename: '{title}_{page}' }, 11, 'webm');
    expect(result).toMatch(/_p11\.webm$/);
    expect(result.split('/').at(-1)!.length).toBeLessThan(140);
  });
});

it('requires the central half of BOTH dimensions and treats 1 as one percent', () => {
  const rect = { left: 10, top: 20, width: 100, height: 200 };
  expect(inTrigger(rect, 35, 70)).toBe(true);
  expect(inTrigger(rect, 60, 69)).toBe(false);
  expect(inTrigger(rect, 34, 120)).toBe(false);
  expect(inTrigger(rect, 61, 120, 1)).toBe(false);
  expect(inTrigger(rect, 60, 120, 1)).toBe(true);
});
