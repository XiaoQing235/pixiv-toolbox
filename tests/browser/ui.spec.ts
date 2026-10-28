import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// This bridge exercises the shipped script and its real UI/services. It does not
// represent Tampermonkey's sandbox, grants, installation, or download behavior.
interface BridgeRequest { url: string; state: 'pending' | 'completed' | 'aborted' | 'failed' }
declare global {
  interface Window {
    gmBridge: { values: Record<string, unknown>; requests: BridgeRequest[] };
  }
}

const script = fileURLToPath(new URL('../../dist/userscript/pixiv-toolbox.user.js', import.meta.url));
const presence = fileURLToPath(new URL('../../dist/extension/presence.js', import.meta.url));
const imageURL = (id: string, page = 0) => `https://i.pximg.net/toolbox-fixture/${id}_p${page}.png`;
const fixtureHTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Generated Pixiv fixture</title>
<style>body{margin:0;background:#edf1f6;color:#25364a;font:16px system-ui}h1{margin:35px 70px;font-size:24px}main{margin:60px 70px;display:flex;flex-direction:column;gap:70px;width:200px}article{margin:0}a{display:block;width:200px;height:160px}img{display:block;width:200px;height:160px;object-fit:cover}p{margin:8px 0}</style></head>
<body><h1>本地生成的 Pixiv 测试列表</h1><main><article><a id="card-a" href="/artworks/101"><img src="${imageURL('101')}" alt="生成作品 A"></a><p>多页作品 A</p></article><article><a id="card-b" href="/artworks/202"><img src="${imageURL('202')}" alt="生成作品 B"></a><p>作品 B</p></article></main></body></html>`;

async function installBridge(page: Page, suspended: boolean) {
  await page.addInitScript(suspended => {
    const values: Record<string, unknown> = { suspended, settings: { preload: 0 } };
    const requests: BridgeRequest[] = [];
    const listeners = new Map<number, { name: string; callback: (name: string, old: unknown, value: unknown, remote: boolean) => void }>();
    let nextListener = 1;
    window.gmBridge = { values, requests };
    const gm = {
      async getValue(name: string, fallback?: unknown) { return name in values ? structuredClone(values[name]) : fallback; },
      async setValue(name: string, value: unknown) {
        const old = values[name]; values[name] = structuredClone(value);
        for (const listener of listeners.values()) if (listener.name === name) queueMicrotask(() => listener.callback(name, old, value, false));
      },
      async deleteValue(name: string) { delete values[name]; },
      async listValues() { return Object.keys(values); },
      addValueChangeListener(name: string, callback: (name: string, old: unknown, value: unknown, remote: boolean) => void) { const id = nextListener++; listeners.set(id, { name, callback }); return id; },
      removeValueChangeListener(id: number) { listeners.delete(id); },
      registerMenuCommand() { return 1; },
      xmlHttpRequest(options: { url: string; method?: string; headers?: Record<string, string>; data?: string | Blob; responseType?: string; onload: (response: unknown) => void; onerror?: (error: unknown) => void; onabort?: () => void }) {
        const controller = new AbortController();
        const entry: BridgeRequest = { url: options.url, state: 'pending' }; requests.push(entry);
        void fetch(options.url, { method: options.method, headers: options.headers, body: options.data, signal: controller.signal }).then(async response => {
          const responseBody = options.responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text();
          entry.state = 'completed';
          options.onload({ status: response.status, response: responseBody, responseText: typeof responseBody === 'string' ? responseBody : '', responseHeaders: [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\r\n') });
        }).catch(error => { if (controller.signal.aborted) { entry.state = 'aborted'; options.onabort?.(); } else { entry.state = 'failed'; options.onerror?.(error); } });
        return { abort() { controller.abort(); entry.state = 'aborted'; } };
      },
    };
    Object.assign(window, { GM: gm, GM_download(options: { onerror?: (error: { error: string }) => void }) {
      queueMicrotask(() => options.onerror?.({ error: 'The GM bridge intentionally does not emulate saving files.' }));
      return { abort() {} };
    } });
  }, suspended);
}

async function startFixture(page: Page, holdA = false, extensionPresent = false) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const generated = await page.evaluate(async () => {
    const images: number[][] = [];
    for (const [index, color] of ['#476f9e', '#db9472', '#6d9675'].entries()) {
      const canvas = new OffscreenCanvas(240, 160), context = canvas.getContext('2d')!;
      context.fillStyle = color; context.fillRect(0, 0, 240, 160);
      context.fillStyle = '#fff'; context.font = 'bold 27px sans-serif'; context.fillText(`GENERATED ${index + 1}`, 13, 85);
      images.push([...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())]);
    }
    return images;
  });
  const images = generated.map(image => Buffer.from(image));
  let releaseA!: () => void;
  const pendingA = new Promise<void>(resolve => { releaseA = resolve; });
  await installBridge(page, !extensionPresent);
  if (extensionPresent) await page.addInitScript({ path: presence });
  await page.route('https://i.pximg.net/**', route => {
    const url = route.request().url();
    return route.fulfill({ contentType: 'image/png', body: images[url.includes('202') ? 2 : url.includes('_p1') ? 1 : 0], headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.route('https://www.pixiv.net/**', async route => {
    const url = new URL(route.request().url());
    const detail = url.pathname.match(/^\/ajax\/illust\/(101|202)$/);
    const pages = url.pathname.match(/^\/ajax\/illust\/(101|202)\/pages$/);
    let body: unknown;
    if (detail) {
      const id = detail[1];
      if (id === '101' && holdA) await pendingA;
      body = { id, title: id === '101' ? '多页作品 A' : '快速作品 B', userId: '501', userName: '生成作者', tags: { tags: [{ tag: '测试' }] }, bookmarkCount: 42, bookmarkData: null, pageCount: id === '101' ? 2 : 1, illustType: 0, width: 240, height: 160, urls: { small: imageURL(id), regular: imageURL(id), original: imageURL(id) } };
    } else if (pages) body = [0, 1].map(index => ({ width: 240, height: 160, urls: { regular: imageURL(pages[1], index), original: imageURL(pages[1], index) } }));
    else if (url.pathname === '/ajax/user/501') body = { isFollowed: false, imageBig: imageURL('202') };
    else if (url.pathname.startsWith('/ajax/')) return route.fulfill({ status: 404, json: { error: true, message: 'Unexpected synthetic endpoint' } });
    else return route.fulfill({ contentType: 'text/html', body: url.pathname === '/' ? '<!doctype html><html><head></head><body>Guest session fixture</body></html>' : fixtureHTML });
    await route.fulfill({ json: { error: false, body } });
  });
  await page.goto('https://www.pixiv.net/tags/fixture/artworks');
  await page.addScriptTag({ path: script });
  if (!extensionPresent) await expect(page.getByRole('button', { name: '作品工作台', exact: true })).toBeVisible();
  return { releaseA };
}

async function moveToCard(page: Page, selector: string, fraction = 0.5) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * fraction, box!.y + box!.height * fraction);
}

test('GM bridge, not Tampermonkey: center hover is immediate, peripheral hover is inert, and saved ratio changes the boundary', async ({ page }, testInfo) => {
  await startFixture(page);
  await moveToCard(page, '#card-a', 0.05);
  await expect(page.locator('.viewer')).toHaveCount(0);
  const immediate = await page.locator('#card-a').evaluate(async anchor => {
    const rect = anchor.getBoundingClientRect();
    anchor.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true, pointerType: 'mouse', clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    await Promise.resolve();
    return !!document.querySelector('#pixiv-toolbox')?.shadowRoot?.querySelector('.viewer');
  });
  expect(immediate).toBe(true);
  await expect(page.locator('.viewer h2')).toHaveText('多页作品 A');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const ratio = page.getByRole('slider', { name: /中央触发区域/ });
  await expect(ratio).toHaveValue('50');
  await ratio.focus(); await ratio.press('End');
  await expect(ratio).toHaveValue('100');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.gmBridge.values.settings as { hoverRatio: number }).hoverRatio)).toBe(100);
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await moveToCard(page, '#card-a', 0.05);
  await expect(page.locator('.viewer h2')).toHaveText('多页作品 A');
  await page.screenshot({ path: testInfo.outputPath('gm-bridge-hover.png') });
});

test('GM bridge, not Tampermonkey: a slow A response cannot replace fast B after pointer movement', async ({ page }, testInfo) => {
  const { releaseA } = await startFixture(page, true);
  try {
    await moveToCard(page, '#card-a');
    await expect(page.locator('.viewer h2')).toHaveText('正在载入作品…');
    await expect.poll(() => page.evaluate(() => window.gmBridge.requests.some(request => /\/ajax\/illust\/101\?/.test(request.url)))).toBe(true);
    await moveToCard(page, '#card-b');
    await expect(page.locator('.viewer h2')).toHaveText('快速作品 B');
    releaseA();
    await expect.poll(() => page.evaluate(() => window.gmBridge.requests.some(request => new URL(request.url).pathname === '/ajax/illust/101/pages' && request.state === 'completed'))).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.viewer h2')).toHaveText('快速作品 B');
    await expect(page.locator('.viewer .stage img')).toHaveAttribute('src', imageURL('202'));
    await page.screenshot({ path: testInfo.outputPath('gm-bridge-latest-target.png') });
  } finally { releaseA(); }
});

test('GM bridge, not Tampermonkey: shipped ShadowRoot viewer flips pages, rotates, and creates a visible queued task', async ({ page }, testInfo) => {
  await startFixture(page);
  await moveToCard(page, '#card-a');
  const viewer = page.locator('.viewer');
  await expect(viewer.locator('h2')).toHaveText('多页作品 A');
  expect(await page.evaluate(() => ({ shadow: !!document.querySelector('#pixiv-toolbox')?.shadowRoot?.querySelector('.viewer'), leaked: !!document.querySelector('.viewer') }))).toEqual({ shadow: true, leaked: false });
  await viewer.getByRole('button', { name: '固定', exact: true }).click();
  await viewer.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(viewer.locator('.stage img')).toHaveAttribute('src', imageURL('101', 1));
  await viewer.getByRole('button', { name: '旋转', exact: true }).click();
  await expect(viewer.locator('.stage img')).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('gm-bridge-viewer.png') });
  await viewer.focus(); await page.keyboard.press('ArrowLeft');
  await expect(viewer.locator('.stage img')).toHaveAttribute('src', imageURL('101', 0));
  await viewer.getByRole('button', { name: '下载作品', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已加入下载队列');
  await page.getByRole('button', { name: /^任务/ }).click();
  await expect(page.getByRole('heading', { name: '下载任务', exact: true })).toBeVisible();
  await expect(page.locator('.task')).toHaveCount(1);
  await expect(page.locator('.task .badge')).toHaveText('排队');
  await page.screenshot({ path: testInfo.outputPath('gm-bridge-task-queue.png') });
});

test('GM bridge, not Tampermonkey: document-start extension presence prevents a second UI and runner', async ({ page }) => {
  await startFixture(page, false, true);
  // Wait beyond the documented 80 ms startup arbitration window. The assertion
  // concerns absence, so it must cover the time at which an incorrect mount occurs.
  await page.waitForTimeout(200);
  await expect(page.locator('#pixiv-toolbox')).toHaveCount(0);
  expect(await page.evaluate(() => window.gmBridge.requests)).toEqual([]);
  expect(await page.evaluate(() => window.gmBridge.values.suspended)).toBe(true);
});
