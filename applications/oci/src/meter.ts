import { createClient } from "@connectrpc/connect"
import type { Client, Transport } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import {
  DeductionService,
  Usage_MeterType,
} from "./proto/gen/es/account/v1/meter_pb.js"
import { StorageBackend } from "./proto/gen/es/kvstore/v1/kvstore_pb.js"

export interface MeterConfig {
  deductionAddress: string
  defaultAmount: number
  disabled: boolean
}

export class MeterClient {
  private client: Client<typeof DeductionService> | null = null
  private defaultAmount: number

  constructor(config: MeterConfig) {
    this.defaultAmount = config.defaultAmount
    if (!config.disabled) {
      const transport: Transport = createConnectTransport({
        baseUrl: config.deductionAddress,
        useBinaryFormat: true,
      })
      this.client = createClient(DeductionService, transport)
    }
  }

  async reportUsage(requestId: string, userId: string): Promise<boolean> {
    if (!this.client) {
      return true
    }
    try {
      await this.client.reportUsage({
        requestId,
        userId,
        usage: [{
          meterType: Usage_MeterType.DURATION_MS,
          storageBackend: StorageBackend.BLOB_STORAGE,
          unitCount: BigInt(this.defaultAmount),
        }],
      })
      return true
    } catch {
      return false
    }
  }
}
