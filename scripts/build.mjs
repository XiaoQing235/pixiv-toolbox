import { build } from 'vite';
import { mkdir, readFile, writeFile, rm, readdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);
const output = resolve(projectRoot, 'dist');
if (dirname(output) !== projectRoot) throw new Error('无效构建输出目录');

function scan() {
  const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
  if (files.status) throw new Error('无法列出工作树扫描范围');
  const paths = [...new Set(files.stdout.split('\0').filter(Boolean))];
  const engine = process.platform === 'win32' ? ['--regex-engine', 'stdlib'] : [];
  const result = spawnSync('betterleaks', ['dir', '--redact', '--no-banner', ...engine, ...paths], { encoding: 'utf8' });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0) throw new Error('BetterLeaks 未通过；停止发布');
}
await rm(output, { recursive: true, force: true });
for (const mode of ['background', 'presence', 'content', 'pages']) { await build({ configFile: 'vite.extension.config.ts', mode }); scan(); }
await build({ configFile: 'vite.userscript.config.ts' }); scan();
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const mediabunny = JSON.parse(await readFile('node_modules/mediabunny/package.json', 'utf8'));
const notice = await readFile('THIRD-PARTY-NOTICES.txt', 'utf8');
const mpl = await readFile('licenses/MPL-2.0.txt', 'utf8');
const mit = await readFile('LICENSE', 'utf8');
const upstreamMpl = await readFile('node_modules/mediabunny/LICENSE', 'utf8');
if (mediabunny.license !== 'MPL-2.0' || !notice.includes(`Mediabunny ${mediabunny.version}.`)
  || !notice.includes(`mediabunny/tree/v${mediabunny.version}`)
  || !notice.includes(`mediabunny-${mediabunny.version}.tgz`)
  || mpl.replaceAll('\r\n', '\n') !== upstreamMpl.replaceAll('\r\n', '\n')) throw new Error('请更新 Mediabunny 许可证和源码说明');
await mkdir('dist/extension', { recursive: true });
await mkdir('dist/extension/licenses', { recursive: true });
await copyFile('LICENSE', 'dist/extension/LICENSE');
await copyFile('THIRD-PARTY-NOTICES.txt', 'dist/extension/THIRD-PARTY-NOTICES.txt');
await copyFile('licenses/MPL-2.0.txt', 'dist/extension/licenses/MPL-2.0.txt');
const scriptPath = 'dist/userscript/pixiv-toolbox.user.js';
const script = await readFile(scriptPath, 'utf8');
const marker = '// ==/UserScript==';
const parts = script.split(marker);
const legalText = `${notice}\n${mpl}\n${mit}`;
if (parts.length !== 2 || legalText.includes('*/')) throw new Error('无法安全地嵌入用户脚本许可信息');
await writeFile(scriptPath, `${parts[0]}${marker}\n\n/*\n${legalText}\n*/${parts[1]}`);
await writeFile('dist/extension/manifest.json', JSON.stringify({
  manifest_version: 3, name: 'Pixiv Toolbox', version,
  description: '预览、阅读、整理和下载 Pixiv 作品', minimum_chrome_version: '120',
  permissions: ['storage', 'downloads', 'alarms', 'offscreen', 'declarativeNetRequestWithHostAccess'],
  host_permissions: ['https://www.pixiv.net/*', 'https://*.pximg.net/*'],
  // User-configured WebDAV hosts are requested individually in setCloud().
  // Declaring optional origins does not grant them at installation.
  optional_host_permissions: ['https://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [
    { matches: ['https://www.pixiv.net/*'], js: ['presence.js'], run_at: 'document_start' },
    { matches: ['https://www.pixiv.net/*'], js: ['content.js'], run_at: 'document_idle' },
  ],
  options_page: 'options.html', action: { default_title: 'Pixiv Toolbox' },
  declarative_net_request: { rule_resources: [{ id: 'images', enabled: true, path: 'rules.json' }] },
}, null, 2));
await writeFile('dist/extension/rules.json', JSON.stringify([{ id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.pixiv.net/' }] }, condition: { requestDomains: ['pximg.net'], resourceTypes: ['xmlhttprequest', 'image', 'media', 'other'] } }]));
async function entries(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(files, await entries(join(directory, entry.name), prefix + entry.name + '/'));
    else {
      const bytes = new Uint8Array(await readFile(join(directory, entry.name)));
      if (entry.name.endsWith('.js')) {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        for (const char of source) {
          const code = char.codePointAt(0);
          if ((code & 0xffff) >= 0xfffe || code >= 0xfdd0 && code <= 0xfdef) throw new Error(`Chromium 不支持产物中的 Unicode 非字符：${entry.name}`);
        }
      }
      files[prefix + entry.name] = bytes;
    }
  }
  return files;
}
await writeFile(`dist/pixiv-toolbox-${version}-mv3.zip`, zipSync(await entries('dist/extension')));
await entries('dist/userscript');
if (/^\/\/ @require\s+https?:/m.test(await readFile('dist/userscript/pixiv-toolbox.user.js', 'utf8'))) throw new Error('用户脚本不能依赖远程执行代码');
console.log('两种产物已生成，工作树 BetterLeaks 扫描通过。');
