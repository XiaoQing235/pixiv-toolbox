import type { Store } from './types';

export function database(): Store {
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('pixiv-toolbox', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function transaction<T>(write: boolean, action: (table: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', write ? 'readwrite' : 'readonly');
      const request = action(tx.objectStore('records'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('数据保存失败'));
    });
  }
  return {
    get: <T>(id: string) => transaction<T | undefined>(false, table => table.get(id)),
    set: async (id, value) => { await transaction(true, table => table.put(value, id)); },
    remove: async id => { await transaction(true, table => table.delete(id)); },
    list: async <T>(prefix: string) => {
      const db = await opened;
      return new Promise<{ id: string; value: T }[]>((resolve, reject) => {
        const found: { id: string; value: T }[] = [];
        const tx = db.transaction('records');
        const cursor = tx.objectStore('records').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (row) { found.push({ id: String(row.key), value: row.value }); row.continue(); }
        };
        tx.oncomplete = () => resolve(found);
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

export function privateStore(): Store {
  return {
    get: async <T>(id: string) => GM.getValue<T | undefined>(id, undefined),
    set: async (id, value) => { await GM.setValue(id, value); },
    remove: async id => { await GM.deleteValue(id); },
    list: async <T>(prefix: string) => {
      const ids = (await GM.listValues()).filter(id => id.startsWith(prefix));
      const rows = [];
      for (const id of ids) rows.push({ id, value: await GM.getValue<T>(id) });
      return rows;
    },
  };
}
