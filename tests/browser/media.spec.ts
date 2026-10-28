import { test, expect } from '@playwright/test';

interface EncodedResult {
  name: string; type: string; size: number; header: number[]; width: number; height: number;
  duration?: number; samples?: number[][];
}
declare global {
  interface Window {
    mediaFixture: {
      encode(format: 'gif' | 'mp4' | 'webm'): Promise<EncodedResult>;
      lifecycle(): Promise<{ sizes: number[][]; delays: number[]; remaining: number; released: number[][] }>;
      cancelBeforeStart(): Promise<{ name: string; requests: number }>;
      cancelDuringPreview(): Promise<{ name: string; decoded: number; released: number[][] }>;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixture.html');
  await page.waitForFunction(() => Boolean(window.mediaFixture));
});

test('GIF is genuinely encoded and decodable by the browser', async ({ page }) => {
  const file = await page.evaluate(() => window.mediaFixture.encode('gif'));
  expect(file.name).toMatch(/\.gif$/);
  expect(file.type).toBe('image/gif');
  expect(file.size).toBeGreaterThan(100);
  expect(String.fromCharCode(...file.header.slice(0, 6))).toBe('GIF89a');
  expect([file.width, file.height]).toEqual([96, 64]);
});

for (const format of ['mp4', 'webm'] as const) {
  test(`${format.toUpperCase()} contains playable frames at their original timestamps`, async ({ page }) => {
    const file = await page.evaluate(format => window.mediaFixture.encode(format), format);
    expect(file.name).toMatch(new RegExp(`\\.${format}$`));
    expect(file.type).toBe(`video/${format}`);
    expect(file.size).toBeGreaterThan(100);
    if (format === 'mp4') expect(String.fromCharCode(...file.header.slice(4, 8))).toBe('ftyp');
    else expect(file.header.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect([file.width, file.height]).toEqual([96, 64]);
    expect(file.duration).toBeCloseTo(0.76, 2);
    expect(file.samples).toHaveLength(3);
    for (const [index, pixel] of file.samples!.entries()) {
      expect(pixel[index]).toBeGreaterThan(180);
      expect(pixel[(index + 1) % 3]).toBeLessThan(80);
      expect(pixel[(index + 2) % 3]).toBeLessThan(80);
      expect(pixel[3]).toBe(255);
    }
  });
}

test('real preview bitmaps preserve delays and are released idempotently', async ({ page }) => {
  const result = await page.evaluate(() => window.mediaFixture.lifecycle());
  expect(result.sizes).toEqual([[96, 64], [96, 64], [96, 64]]);
  expect(result.delays).toEqual([120, 230, 410]);
  expect(result.remaining).toBe(0);
  expect(result.released).toEqual([[0, 0], [0, 0], [0, 0]]);
});

test('cancellation prevents network work and closes partially decoded bitmaps', async ({ page }) => {
  expect(await page.evaluate(() => window.mediaFixture.cancelBeforeStart())).toEqual({ name: 'AbortError', requests: 0 });
  const during = await page.evaluate(() => window.mediaFixture.cancelDuringPreview());
  expect(during.name).toBe('AbortError');
  expect(during.decoded).toBe(2);
  expect(during.released).toEqual([[0, 0], [0, 0]]);
});
