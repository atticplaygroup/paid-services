// Configuration is durable application state, rather than an HTTP response.
// In particular, WebKit can discard Cache API writes after an OIDC redirect.
export async function workerConfig(value?: unknown): Promise<any> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("paid-worker-config", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("config")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("config", value === undefined ? "readonly" : "readwrite")
      const store = transaction.objectStore("config")
      const request = value === undefined ? store.get("current") : store.put(value, "current")
      transaction.oncomplete = () => resolve(value === undefined ? request.result : value)
      transaction.onabort = () => reject(transaction.error ?? new Error("Configuration transaction aborted"))
      transaction.onerror = () => reject(transaction.error)
    })
  } finally { db.close() }
}
