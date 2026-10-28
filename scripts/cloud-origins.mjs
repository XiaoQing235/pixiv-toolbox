import { existsSync, readFileSync } from 'node:fs';
const file = new URL('../.local/allowed-origins.json', import.meta.url);
/** @type {string[]} */
export const cloudOrigins = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
if (!Array.isArray(cloudOrigins) || cloudOrigins.some(origin => {
  try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin || origin.includes('*') || url.username || url.password; } catch { return true; }
})) throw new Error('云端主机必须是明确的 HTTPS origin，不允许通配地址');
