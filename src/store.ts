// ブラウザに覚えておくもの。
//   設定と編集の履歴：localStorage（文字だけなので軽い）
//   自分で足した画像：IndexedDB（切り抜いたあとの画像を PNG で）
// どれもこのブラウザの中だけに残る。どこにも送らない。使えない環境（プライベートウィンドウなど）では、黙って何もしない。

const LAST = 'anyflage:last', HISTORY = 'anyflage:history';

export function loadText(key: 'last' | 'history'): string | null {
  try { return localStorage.getItem(key === 'last' ? LAST : HISTORY); } catch { return null; }
}
export function saveText(key: 'last' | 'history', value: string): void {
  try { localStorage.setItem(key === 'last' ? LAST : HISTORY, value); } catch { /* 容量切れや禁止のときは覚えないだけ */ }
}

/** 足した画像1枚ぶん。blob は切り抜いたあとの PNG（透明つき） */
export interface OwnRecord { id: string; group: string; label: string; w: number; h: number; blob: Blob; at: number }

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('anyflage', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('own', { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function run<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction('own', mode), req = work(tx.objectStore('own'));
    tx.oncomplete = () => { d.close(); resolve(req.result); };
    tx.onerror = tx.onabort = () => { d.close(); reject(tx.error); };
  }));
}
export async function saveOwn(rec: OwnRecord): Promise<void> { try { await run('readwrite', (s) => s.put(rec)); } catch (e) { console.warn('足した画像を覚えられなかった', e); } }
export async function loadOwn(): Promise<OwnRecord[]> { try { return (await run('readonly', (s) => s.getAll() as IDBRequest<OwnRecord[]>)).sort((a, b) => a.at - b.at); } catch { return []; } }
export async function clearOwn(): Promise<void> { try { await run('readwrite', (s) => s.clear()); } catch (e) { console.warn('足した画像を消せなかった', e); } }
