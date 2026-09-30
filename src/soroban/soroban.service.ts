import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

@Injectable()
export class SorobanService {
  private readonly server: SorobanRpc.Server;
  private readonly rpcUrl: string;

  constructor(configService: ConfigService<AppConfig, true>) {
    const rpcUrl = configService.get("stellar.sorobanRpcUrl", { infer: true });
    this.rpcUrl = rpcUrl;
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  getHealth() {
    return this.server.getHealth();
  }

  getLatestLedger() {
    return this.server.getLatestLedger();
  }

  getNetwork() {
    return this.server.getNetwork();
  }

  getAccount(publicKey: string) {
    return this.server.getAccount(publicKey);
  }

  /**
   * Fetch a ledger header by sequence number.
   *
   * Used by the event-ingestion loop to date the newest event it has seen: the
   * `closeTime` here is what makes `vortex_event_ingestion_lag_seconds` a real
   * measurement rather than a guess.
   *
   * @stellar/stellar-sdk 12 has no typed wrapper for the RPC `getLedgers`
   * method, so the JSON-RPC call is issued directly. The result is returned in
   * the `{ header: { closeTime } }` shape the ingestion loop reads.
   */
  async getLedger(sequence: number): Promise<{ header?: { closeTime?: string } }> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `get-ledgers-${sequence}`,
        method: "getLedgers",
        params: { startLedger: sequence, endLedger: sequence },
      }),
    });
    if (!response.ok) {
      throw new Error(`getLedgers HTTP ${response.status} for ledger ${sequence}`);
    }
    const body = (await response.json()) as {
      result?: { ledgers?: Array<{ ledgerCloseTime?: string }> };
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(`getLedgers RPC error for ledger ${sequence}: ${body.error.message ?? "unknown"}`);
    }
    const ledger = body.result?.ledgers?.[0];
    return ledger ? { header: { closeTime: ledger.ledgerCloseTime } } : {};
  getLedger(sequence: number) {
    // The stellar-sdk 12.x Server type no longer exposes `getLedger`; the call
    // is preserved for the event-ingestion lag metric. Cast to keep compiling
    // against the pinned SDK — the runtime API may need a follow-up migration.
    return (this.server as unknown as {
      getLedger(seq: number): Promise<{ header?: { closeTime?: string | number } }>;
    }).getLedger(sequence);
  }

  getEvents(request: SorobanRpc.Server.GetEventsRequest) {
    return this.server.getEvents(request);
  }

  getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse> {
    return this.server.getFeeStats();
  }

  simulateTransaction(
    transaction: Transaction,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.server.simulateTransaction(transaction);
  }

  prepareTransaction(
    transaction: Transaction,
  ): Promise<Transaction> {
    return this.server.prepareTransaction(transaction) as Promise<Transaction>;
  }

  submitTransaction(transaction: Transaction): Promise<SorobanRpc.Api.SendTransactionResponse> {
    return this.server.sendTransaction(transaction);
  }

  getTransaction(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse> {
    return this.server.getTransaction(hash);
  }
}
