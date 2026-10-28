import { chromium, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('packaged MV3 loads its worker and options in an isolated Chromium profile', async ({}, info) => {
  const extension = resolve('dist/extension');
  const context = await chromium.launchPersistentContext(info.outputPath('profile'), {
    channel: process.env.PIXIV_TEST_BROWSER ? undefined : 'chromium', executablePath: process.env.PIXIV_TEST_BROWSER, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const id = new URL(worker.url()).host;
    // Only replace the fixture's external data source; extension messaging,
    // IndexedDB, content script and options are the actual packaged code.
    await worker.evaluate(() => {
      globalThis.fetch = async () => new Response('<html><meta id="meta-global-data" content="{&quot;userData&quot;:{&quot;id&quot;:&quot;1&quot;},&quot;token&quot;:&quot;fixture&quot;}"></html>', { headers: { 'Content-Type': 'text/html' } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.getByRole('heading', { name: '工具箱设置' })).toBeVisible();
    await expect(page.getByText('浏览器扩展', { exact: true })).toBeVisible();
    const permissions = await worker.evaluate(async () => chrome.permissions.getAll());
    expect(permissions.origins).not.toContain('https://*/*');
    await page.getByRole('slider').first().fill('70');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText('设置已保存', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('slider').first()).toHaveValue('70');
    const task = await page.evaluate(async () => {
      const call = async (op: string, args: unknown[] = []) => {
        const result = await chrome.runtime.sendMessage({ app: 'pixiv-toolbox', op, args });
        if (!result.ok) throw new Error(result.error);
        return result.value;
      };
      await call('set', ['suspended', true]);
      const settings = await call('get', ['settings']);
      await call('enqueue', [[{ id: '101', kind: 'illust' }], {}, settings]);
      const [record] = await call('list', ['task:']);
      await call('taskAction', [record.value.id, 'pause']);
      return (await call('get', [record.id])).state;
    });
    expect(task).toBe('paused');
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('options.png'), fullPage: true });
  } finally { await context.close(); }
});
