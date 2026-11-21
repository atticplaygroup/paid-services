import { toJson } from "@bufbuild/protobuf"
import { FunctionalitySchema, type Provider } from "./proto/gen/es/index/v1/index_pb.js"
import { sameFunctionality, type Functionality } from "./types.js"

/** A sorting policy: return a preferred subset/order of the supplied candidates.
 * Discovery, validation, expiry checks, and deduplication belong to the router.
 */
export interface ProviderRanker {
  readonly providerScorings: readonly Functionality[]
  rank(providers: readonly Provider[]): Provider[]
}

export interface AverageScoreRankerConfig {
  providerScorings: Functionality[]
}

export function createAverageScoreRanker(config: AverageScoreRankerConfig): ProviderRanker {
  const providerScorings = config.providerScorings.filter((f, i, all) => all.findIndex(other => sameFunctionality(f, other)) === i)
  return {
    providerScorings,
    rank(providers) {
      const scored: { provider: Provider; score: number }[] = []
      for (const provider of providers) {
        const scores = providerScorings.flatMap(functionality => {
          const score = provider.scores.find(s => s.scoringFunctionality && sameFunctionality(toJson(FunctionalitySchema, s.scoringFunctionality), functionality))
          return score ? [score.score] : []
        })
        if (!scores.length || scores.some(score => !Number.isFinite(score))) continue
        const score = scores.reduce((sum, value) => sum + value / scores.length, 0)
        if (Number.isFinite(score)) scored.push({ provider, score })
      }
      scored.sort((a, b) => b.score - a.score || a.provider.origin.localeCompare(b.provider.origin))
      return scored.map(candidate => candidate.provider)
    },
  }
}
