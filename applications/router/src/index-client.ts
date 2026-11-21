import { createClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import { IndexService } from "./proto/gen/es/index/v1/index_pb.js"
import type { Fetch } from "./types.js"

export function createIndexClient(origin: string, fetcher: Fetch = fetch) {
  return createClient(IndexService, createConnectTransport({ baseUrl: origin, useBinaryFormat: false, fetch: fetcher as typeof fetch }))
}
