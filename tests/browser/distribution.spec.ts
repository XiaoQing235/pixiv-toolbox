import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

test('both distribution formats include the MPL license and versioned source notice', async () => {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const mediabunny = JSON.parse(await readFile('node_modules/mediabunny/package.json', 'utf8'));
  const files = unzipSync(await readFile(`dist/pixiv-toolbox-${version}-mv3.zip`));
  for (const path of ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'licenses/MPL-2.0.txt']) {
    const expected = await readFile(path);
    expect(files[path], `${path} in MV3 archive`).toEqual(new Uint8Array(expected));
    expect(await readFile(`dist/extension/${path}`), `${path} in unpacked extension`).toEqual(expected);
  }
  const notice = await readFile('THIRD-PARTY-NOTICES.txt', 'utf8');
  expect(notice).toContain(`Mediabunny ${mediabunny.version}.`);
  expect(notice).toContain(`https://github.com/Vanilagy/mediabunny/tree/v${mediabunny.version}`);
  expect(notice).toContain(`mediabunny-${mediabunny.version}.tgz`);
  const script = await readFile('dist/userscript/pixiv-toolbox.user.js', 'utf8');
  expect(script.startsWith('// ==UserScript==')).toBe(true);
  expect(script.indexOf(notice)).toBeGreaterThan(script.indexOf('// ==/UserScript=='));
  expect(script).toContain(await readFile('licenses/MPL-2.0.txt', 'utf8'));
  expect(script).toContain(await readFile('LICENSE', 'utf8'));
});
