import type { BehaviorJson, FunctionalityJson } from "./proto/gen/es/index/v1/index_pb.js"
export type Definition = BehaviorJson
export type Functionality = FunctionalityJson
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function sameFunctionality(a: Functionality, b: Functionality): boolean {
  return ["behavior", "variant"].every(k => ["name", "maintainer", "tag"].every(field => (a as any)?.[k]?.[field] === (b as any)?.[k]?.[field]))
}
