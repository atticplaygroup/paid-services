class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }
export function sqlExecutor(config: any, signal?: AbortSignal) {
  async function result(response: Response) {
    const text = await response.text(); let body: any;
    try { body = JSON.parse(text) } catch { throw new ApiError(response.ok ? 502 : response.status, text) }
    if (!response.ok) throw new ApiError(response.status, JSON.stringify(body.errors ?? body));
    return body;
  }
  return async (query: any) => {
    const value = await result(await fetch("https://paid.invalid/sql", { method: "POST", headers: { "content-type": "application/json", "x-paid-retry": "true", "x-paid-functionality": JSON.stringify(config.sql) }, signal, body: JSON.stringify({ sql: query.sql, parameters: query.parameters.map((p: any) => typeof p === "bigint" ? p.toString() : p) }) }))
    return value.rows.map((r: any[]) => Object.fromEntries(value.columns.map((c: string, i: number) => [c, r[i]])))
  }
}
