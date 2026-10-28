import type { CloudConfig, Runtime } from './types';

function headers(config: CloudConfig): Record<string, string> {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  return { Authorization: `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}` };
}
export async function uploadFile(runtime: Runtime, config: CloudConfig, name: string, data: Blob | string, signal?: AbortSignal): Promise<void> {
  const root = config.url.replace(/\/?$/, '/');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '..' || part === '.')) throw new Error('上传文件名不正确');
  for (let index = 1; index < parts.length; index++) {
    const response = await runtime.request(root + parts.slice(0, index).map(encodeURIComponent).join('/') + '/', { method: 'MKCOL', headers: headers(config), signal });
    if (![201, 405].includes(response.status)) throw new Error(`云目录创建失败 (${response.status})`);
  }
  if (typeof data === 'string') {
    const response = await runtime.request(data, { bytes: true, signal });
    if (response.status !== 200) throw new Error(`上传原文件读取失败 (${response.status})`);
    data = new Blob([new Uint8Array(response.body as Uint8Array)]);
  }
  const response = await runtime.request(root + parts.map(encodeURIComponent).join('/'), { method: 'PUT', headers: { ...headers(config), 'If-None-Match': '*' }, body: new Uint8Array(await data.arrayBuffer()), signal });
  if (![200, 201, 204].includes(response.status)) throw new Error(response.status === 412 ? '云端存在同名文件，请核实后调整目录或文件名' : `上传失败 (${response.status})`);
}
interface Snapshot { schema: 1; records: Record<string, unknown> }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function mergeSnapshots(local: Snapshot, remote: Snapshot, base?: Snapshot, choice?: 'local' | 'remote'): Snapshot {
  const records: Record<string, unknown> = {};
  for (const id of new Set([...Object.keys(local.records), ...Object.keys(remote.records)])) {
    const a = local.records[id], b = remote.records[id], previous = base?.records[id];
    if (same(a, b) || same(b, previous)) records[id] = a;
    else if (same(a, previous)) records[id] = b;
    else if (id.startsWith('read:')) records[id] = Number((a as { at?: number })?.at || 0) >= Number((b as { at?: number })?.at || 0) ? a : b;
    else if (choice) records[id] = choice === 'local' ? a : b;
    else throw new Error('同步设置存在冲突。请明确选择使用本机或云端设置，再次同步。');
  }
  return { schema: 1, records };
}
export async function syncData(runtime: Runtime, choice?: 'local' | 'remote'): Promise<void> {
  const config = await runtime.store.get<CloudConfig>('cloud');
  if (!config?.url) throw new Error('请先配置 WebDAV 连接');
  const endpoint = `${config.url.replace(/\/?$/, '/')}pixiv-toolbox.json`;
  const response = await runtime.request(endpoint, { headers: headers(config) });
  if (![200, 404].includes(response.status)) throw new Error(`读取云端数据失败 (${response.status})`);
  const remote: Snapshot = response.status === 404 ? { schema: 1, records: {} } : JSON.parse(response.body as string);
  if (remote.schema !== 1 || !remote.records || typeof remote.records !== 'object') throw new Error('云端数据版本不支持');
  const records: Record<string, unknown> = {};
  const settings = await runtime.store.get<Record<string, unknown>>('settings') || {};
  for (const [name, value] of Object.entries(settings)) if (name !== 'directory') records[`setting:${name}`] = value;
  for (const row of await runtime.store.list('read:')) records[row.id] = row.value;
  const base = await runtime.store.get<Snapshot>('sync-base');
  const merged = mergeSnapshots({ schema: 1, records }, remote, base, choice);
  const etag = response.headers.etag;
  if (response.status === 200 && !etag) throw new Error('此服务未提供 ETag，不能安全进行双向同步；可使用本地备份');
  const result = await runtime.request(endpoint, { method: 'PUT', headers: { ...headers(config), 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }, body: JSON.stringify(merged) });
  if (![200, 201, 204].includes(result.status)) throw new Error(result.status === 412 ? '云端刚被其他设备更新，请重新同步' : `同步写入失败 (${result.status})`);
  await runtime.store.set('sync-recovery', { records });
  for (const [id, value] of Object.entries(merged.records)) {
    if (id.startsWith('read:') && value && typeof value === 'object') await runtime.store.set(id, value);
    if (id.startsWith('setting:') && id.slice(8) in settings) settings[id.slice(8)] = value;
  }
  await runtime.store.set('settings', settings);
  await runtime.store.set('sync-base', merged);
}
