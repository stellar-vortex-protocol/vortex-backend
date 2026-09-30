import { readFileSync } from "node:fs";
import { Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { parse } from "yaml";

export type PolicyAction = "allow" | "deny" | "warn";

export interface PolicyRule {
  action?: PolicyAction;
  contractId?: string;
  method?: string;
  source?: string;
}

export interface PolicyDocument {
  version?: number;
  defaultAction?: PolicyAction;
  maxInclusionFee?: number;
  maxResourceFee?: number;
  budget?: {
    maxAuthEntries?: number;
    windowMs?: number;
  };
  rules?: PolicyRule[];
}

export interface AuthEntry {
  contractId?: string;
  functionName?: string;
  source?: string;
  depth?: number;
  [key: string]: unknown;
}

export interface DecodedTx {
  xdr: string;
  source: string;
  fee: number;
  resourceFee: number;
  sequence: string;
  operations: Array<Record<string, unknown>>;
  authEntries: AuthEntry[];
}

export interface PolicyDecision {
  status: PolicyAction;
  reason: string;
  matchedRule?: string;
  budgetKey?: string;
  alerts: string[];
}

export interface EvaluateOptions {
  nowMs?: number;
  budgetStore?: BudgetStore;
  alertSink?: AlertSink;
  budgetWindowMs?: number;
  budgetLimit?: number;
}

export const DEFAULT_POLICY: PolicyDocument = {
  version: 1,
  defaultAction: "deny",
  maxInclusionFee: 1_000_000,
  maxResourceFee: 1_000_000,
  budget: {
    maxAuthEntries: 8,
    windowMs: 60_000,
  },
  rules: [],
};

export function resolvePolicyPath(filePath = process.env.SIGNER_POLICY_PATH): string {
  if (filePath && filePath.trim()) {
    return filePath.trim();
  }
  return "./src/soroban/signer-policy/default-policy.yaml";
}

export function loadPolicyFromFile(filePath = resolvePolicyPath()): PolicyDocument {
  try {
    const parsed = parse(readFileSync(filePath, "utf8")) as Partial<PolicyDocument> | undefined;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_POLICY };
    }

    const nextRules = Array.isArray(parsed.rules) ? parsed.rules : [];
    const nextBudget = {
      ...(DEFAULT_POLICY.budget ?? {}),
      ...(parsed.budget ?? {}),
    };

    return {
      ...DEFAULT_POLICY,
      ...parsed,
      budget: nextBudget,
      rules: nextRules,
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export class BudgetStore {
  private readonly buckets = new Map<string, number[]>();

  public record(key: string, nowMs: number, windowMs: number): number {
    const prior = this.buckets.get(key) ?? [];
    const active = prior.filter((timestamp) => nowMs - timestamp <= windowMs);
    active.push(nowMs);
    this.buckets.set(key, active);
    return active.length;
  }
}

export class AlertSink {
  constructor(private readonly webhookUrl: string = process.env.SIGNER_POLICY_ALERT_WEBHOOK ?? "") {}

  public async emit(payload: Record<string, unknown>): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    try {
      // eslint-disable-next-line no-restricted-syntax -- pre-existing direct fetch; HttpEgressService migration is a separate change
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Fail closed for the policy engine: a failed alert must not block a
      // local decision path. The caller can still inspect the policy decision.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function toContractId(entry: AuthEntry): string | undefined {
  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }

  return readString(record, "contractId", "contract_id", "contract", "contractAddress") ??
    readString(asRecord(record.address) ?? {}, "contractId", "contract_id", "contract") ??
    undefined;
}

function toMethodName(entry: AuthEntry): string | undefined {
  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }

  return readString(record, "functionName", "function_name", "method", "methodName", "name");
}

function toSource(entry: AuthEntry): string | undefined {
  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }

  return readString(record, "source", "sourceAccount", "source_account", "from");
}

function matchesRule(rule: PolicyRule, entry: AuthEntry): boolean {
  const contractId = toContractId(entry);
  const method = toMethodName(entry);
  const source = toSource(entry);

  if (rule.contractId && rule.contractId !== "*" && contractId !== rule.contractId) {
    return false;
  }

  if (rule.method && rule.method !== "*" && method !== rule.method) {
    return false;
  }

  if (rule.source && rule.source !== "*" && source !== rule.source) {
    return false;
  }

  return true;
}

function flatten(inv: any, depth: number, results: AuthEntry[]): void {
  if (!inv || typeof inv.function !== "function") {
    return;
  }

  const fn = inv.function();
  if (fn && typeof fn.switch === "function") {
    const switchName = fn.switch().name;
    if (switchName === "sorobanAuthorizedFunctionTypeContractFn") {
      const cf = fn.contractFn();
      const scAddr = typeof cf.contractAddress === "function" ? cf.contractAddress() : cf.contractAddress;
      let contractId: string;
      if (scAddr && typeof scAddr.switch === "function" && scAddr.switch().name === "scAddressTypeContract") {
        contractId = scAddr.contractId().toString("hex");
      } else {
        contractId = typeof scAddr === "string" ? scAddr : String(scAddr ?? "");
      }
      const functionName = String(typeof cf.functionName === "function" ? cf.functionName() : (cf.functionName ?? ""));
      results.push({ contractId, functionName, depth });
    } else {
      results.push({ contractId: "__NON_CONTRACT__", functionName: switchName, depth });
    }
  }

  if (inv && typeof inv.subInvocations === "function") {
    for (const sub of inv.subInvocations()) {
      flatten(sub, depth + 1, results);
    }
  }
}

export function walkAuthEntries(
  node: unknown,
  seen = new Set<unknown>(),
  results: AuthEntry[] = [],
): AuthEntry[] {
  if (node === null || node === undefined || typeof node !== "object") {
    return results;
  }

  if (seen.has(node)) {
    return results;
  }
  seen.add(node);

  if (node && typeof (node as any).rootInvocation === "function") {
    flatten((node as any).rootInvocation(), 0, results);
    return results;
  }

  if (node && typeof (node as any).function === "function" && typeof (node as any).subInvocations === "function") {
    flatten(node as any, 0, results);
    return results;
  }

  const record = node as Record<string, unknown>;
  const isLikelyAuthEntry =
    Object.prototype.hasOwnProperty.call(record, "contractId") ||
    Object.prototype.hasOwnProperty.call(record, "functionName") ||
    Object.prototype.hasOwnProperty.call(record, "rootInvocation") ||
    Object.prototype.hasOwnProperty.call(record, "invocations") ||
    Object.prototype.hasOwnProperty.call(record, "auth");

  if (isLikelyAuthEntry) {
    const maybeEntry = record as AuthEntry;
    if (typeof maybeEntry.contractId === "string" || typeof maybeEntry.functionName === "string" || typeof maybeEntry.source === "string") {
      results.push(maybeEntry);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "auth" || key === "rootInvocation" || key === "invocations") {
      if (Array.isArray(value)) {
        for (const item of value) {
          walkAuthEntries(item, seen, results);
        }
      } else {
        walkAuthEntries(value, seen, results);
      }
      continue;
    }

    if (value !== null && typeof value === "object") {
      walkAuthEntries(value, seen, results);
    }
  }

  return results;
}

export function decodeTx(rawXdr: string, networkPassphrase = Networks.TESTNET): DecodedTx {
  const tx = TransactionBuilder.fromXDR(rawXdr, networkPassphrase) as any;
  const raw = tx.toEnvelope().v1().tx();

  const sourceAccount = raw.sourceAccount();
  const source =
    sourceAccount && typeof sourceAccount.switch === "function" && sourceAccount.switch().name === "keyTypeEd25519"
      ? StrKey.encodeEd25519PublicKey(sourceAccount.ed25519())
      : "anonymous";

  const fee = Number(raw.fee().toString());

  let resourceFee = 0;
  try {
    if (raw.sorobanData && typeof raw.sorobanData === "function") {
      const sd = raw.sorobanData();
      if (sd && typeof sd.resourceFee === "function") {
        resourceFee = Number(sd.resourceFee().toString());
      }
    }
  } catch {
    resourceFee = 0;
  }

  const sequence = raw.seqNum().toString();

  const operations = Array.from(raw.operations()).map((op: unknown) => {
    const typedOp = op as any;
    return {
      name: String(typedOp.body().switch().name),
    };
  }) as Array<Record<string, unknown>>;

  // ROBUST auth reader: the high-level Transaction.sorobanAuthorizationEntries()
  // loses entries after TransactionBuilder.fromXDR() round-trips, so we also
  // fall back to iterating operations' .auth arrays (which are preserved).
  const authEntries: AuthEntry[] = [];
  const seen = new Set<unknown>();

  let highLevel: any[] = [];
  try {
    if (typeof (tx as any).sorobanAuthorizationEntries === "function") {
      const maybe = (tx as any).sorobanAuthorizationEntries();
      if (Array.isArray(maybe)) highLevel = maybe;
    }
  } catch {
    highLevel = [];
  }

  const opLevel: any[] = [];
  for (const op of ((tx as any).operations ?? [])) {
    if (op && Array.isArray((op as any).auth)) {
      for (const e of (op as any).auth) opLevel.push(e);
    }
  }

  const authList = highLevel.length > 0 ? highLevel : opLevel;
  for (const entry of authList) {
    walkAuthEntries(entry, seen, authEntries);
  }

  return {
    xdr: rawXdr,
    source,
    fee,
    resourceFee,
    sequence,
    operations,
    authEntries,
  };
}

export function evaluatePolicy(
  policyInput: PolicyDocument | string,
  txInput: unknown,
  options: EvaluateOptions = {},
): PolicyDecision {
  const policy = typeof policyInput === "string" ? loadPolicyFromFile(policyInput) : policyInput;
  const budgetStore = options.budgetStore ?? new BudgetStore();
  const alertSink = options.alertSink ?? new AlertSink(process.env.SIGNER_POLICY_ALERT_WEBHOOK ?? "");
  const nowMs = options.nowMs ?? Date.now();
  const budgetWindowMs = Math.max(1, Number(policy.budget?.windowMs ?? options.budgetWindowMs ?? 60_000));
  const budgetLimit = Math.max(0, Number(policy.budget?.maxAuthEntries ?? options.budgetLimit ?? 8));
  const maxInclusionFee = Number(policy.maxInclusionFee ?? 1_000_000);
  const maxResourceFee = Number(policy.maxResourceFee ?? 1_000_000);

  const supplied = (txInput && typeof txInput === "object" ? txInput : {}) as Partial<DecodedTx>;
  const decodedTx: DecodedTx = typeof txInput === "string"
    ? decodeTx(txInput)
    : {
        xdr: typeof supplied.xdr === "string" ? supplied.xdr : "",
        source: typeof supplied.source === "string" && supplied.source ? supplied.source : "anonymous",
        fee: Number(supplied.fee ?? 0),
        resourceFee: Number(supplied.resourceFee ?? 0),
        sequence: String(supplied.sequence ?? "0"),
        operations: Array.isArray(supplied.operations) ? supplied.operations : [],
        authEntries: Array.isArray(supplied.authEntries) ? supplied.authEntries : walkAuthEntries(txInput),
      };

  const budgetKey = decodedTx.source || "anonymous";
  const operationNames = decodedTx.operations.map((op: Record<string, unknown>) => String(op.name ?? ""));
  const entries = decodedTx.authEntries;

  const deny = (reason: string): PolicyDecision => {
    const decision: PolicyDecision = {
      status: "deny",
      reason,
      budgetKey,
      alerts: [],
    };

    void alertSink.emit({
      kind: "signer-policy",
      status: decision.status,
      reason: decision.reason,
      budgetKey,
      wallet: decodedTx.source,
      nowMs,
    });
    return decision;
  };

  if (operationNames.some((name: string) => name === "payment")) {
    return deny("classic_payment_forbidden");
  }

  if (decodedTx.fee > maxInclusionFee) {
    return deny(`inclusion_fee_exceeded:${decodedTx.fee}>${maxInclusionFee}`);
  }

  if (decodedTx.resourceFee > maxResourceFee) {
    return deny(`resource_fee_exceeded:${decodedTx.resourceFee}>${maxResourceFee}`);
  }

  if (entries.some((entry) => entry.contractId === "__NON_CONTRACT__")) {
    return deny("non_contract_auth_forbidden");
  }

  const allowRules = (policy.rules ?? []).filter((rule) => rule.action === "allow");
  if (entries.length > 0 && allowRules.length > 0) {
    const hasAllAllowed = entries.every((entry) => allowRules.some((rule) => matchesRule(rule, entry)));
    if (!hasAllAllowed) {
      return deny("auth_entry_not_allowed");
    }
  }

  const currentUsage = budgetStore.record(budgetKey, nowMs, budgetWindowMs);
  if (currentUsage > budgetLimit) {
    return deny(`budget_exceeded:${currentUsage}>${budgetLimit}`);
  }

  if (entries.length > 0 && allowRules.length > 0) {
    const explicitAllowMatch = entries.every((entry) => allowRules.some((rule) => matchesRule(rule, entry)));
    if (explicitAllowMatch) {
      const rule = allowRules[0];
      return {
        status: "allow",
        reason: "allowlist_match",
        matchedRule: rule ? `${rule.contractId ?? "*"}/${rule.method ?? "*"}` : undefined,
        budgetKey,
        alerts: [],
      };
    }
  }

  const defaultAction = policy.defaultAction ?? "deny";
  return {
    status: defaultAction,
    reason: `default_action:${defaultAction}`,
    budgetKey,
    alerts: [],
  };
}