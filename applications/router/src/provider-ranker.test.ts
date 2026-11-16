import { test, expect } from "bun:test"
import { fromJson } from "@bufbuild/protobuf"
import { createAverageScoreRanker } from "./provider-ranker.ts"
import { ProviderSchema } from "./proto/gen/es/index/v1/index_pb.js"
import type { Functionality } from "./types.ts"

const service: Functionality = { behavior: { name: "api", maintainer: "owner", tag: "v1" }, variant: { name: "echo", maintainer: "owner", tag: "v1" } }
const latency: Functionality = { ...service, variant: { ...service.variant, name: "latency" } }
const throughput: Functionality = { ...service, variant: { ...service.variant, name: "throughput" } }
const unconfigured: Functionality = { ...service, variant: { ...service.variant, name: "unconfigured" } }
function provider(origin: string, scores: [Functionality, number][]) {
  return fromJson(ProviderSchema, { origin, scores: scores.map(([scoringFunctionality, score]) => ({ scoringFunctionality, score })) })
}

test("average rule orders by configured scores, independent of config and response order", () => {
  const providers = [
    provider("https://spiky", [[latency, 100], [throughput, 0], [unconfigured, 10000]]),
    provider("https://balanced", [[throughput, 60], [latency, 60]]),
    provider("https://partial", [[throughput, 70]]),
    provider("https://unscored", [[unconfigured, 100000]]),
  ]
  for (const providerScorings of [[latency, throughput], [throughput, latency], [latency, latency, throughput]]) {
    const ranker = createAverageScoreRanker({ providerScorings })
    expect(ranker.providerScorings).toEqual(providerScorings.length === 3 ? [latency, throughput] : providerScorings)
    expect(ranker.rank(providers).map(p => p.origin)).toEqual(["https://partial", "https://balanced", "https://spiky"])
  }
  expect(providers[0].origin).toBe("https://spiky")
})

test("average rule breaks equal means by origin and rejects nonfinite configured scores", () => {
  const ranker = createAverageScoreRanker({ providerScorings: [latency, throughput] })
  const invalid = provider("https://invalid", [[latency, 1]])
  invalid.scores[0].score = NaN
  expect(ranker.rank([invalid, provider("https://b", [[latency, 90], [throughput, 10]]), provider("https://a", [[latency, 20], [throughput, 80]])]).map(p => p.origin)).toEqual(["https://a", "https://b"])
})
