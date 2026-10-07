// Base de datos local (IndexedDB): todo se guarda en el teléfono y funciona sin señal.
const DB = (() => {
  const STORES = ['sitios', 'areas', 'sistemas', 'equipos', 'fotos', 'blobs', 'meta'];
  let abierta;

  function abrir() {
    if (!abierta) {
      abierta = new Promise((res, rej) => {
        const r = indexedDB.open('levantamientos', 1);
        r.onupgradeneeded = () => {
          STORES.forEach((s) => {
            if (!r.result.objectStoreNames.contains(s)) {
              r.result.createObjectStore(s, { keyPath: s === 'meta' ? 'k' : 'id' });
            }
          });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return abierta;
  }

  async function tx(store, modo, fn) {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction(store, modo);
      const salida = fn(t.objectStore(store));
      t.oncomplete = () => res(salida instanceof IDBRequest ? salida.result : salida);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  return {
    get: (st, id) => tx(st, 'readonly', (s) => s.get(id)),
    all: (st) => tx(st, 'readonly', (s) => s.getAll()),
    put: (st, obj) => tx(st, 'readwrite', (s) => s.put(obj)),
    putMany: (st, arr) => tx(st, 'readwrite', (s) => { arr.forEach((o) => s.put(o)); }),
    del: (st, id) => tx(st, 'readwrite', (s) => s.delete(id)),
    clear: (st) => tx(st, 'readwrite', (s) => s.clear()),
    async meta(k, def = null) {
      const r = await tx('meta', 'readonly', (s) => s.get(k));
      return r ? r.v : def;
    },
    setMeta: (k, v) => tx('meta', 'readwrite', (s) => s.put({ k, v })),
    async borrarTodo() { for (const s of STORES) await tx(s, 'readwrite', (x) => x.clear()); },
  };
})();
