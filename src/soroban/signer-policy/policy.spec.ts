import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import {
  AlertSink,
  BudgetStore,
  DEFAULT_POLICY,
  decodeTx,
  evaluatePolicy,
  loadPolicyFromFile,
  resolvePolicyPath,
  walkAuthEntries,
} from "./policy";

const CONTRACT_A_HEX = Buffer.alloc(32, 0x01).toString("hex");
const CONTRACT_B_HEX = Buffer.alloc(32, 0x02).toString("hex");

function contractAddress(seed: number): Address {
  return Address.fromString(StrKey.encodeContract(Buffer.alloc(32, seed)));
}

// FIX 2: functionName is a STRING (SCSymbol typedef), not an ScVal.
function makeContractFn(contract: Address, method: string) {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: contract.toScAddress(),
      functionName: method,
      args: [],
    })
  );
}

function makeAuthEntry(contract: Address, nestedContract?: Address, nestedMethod?: string) {
  const rootFn = makeContractFn(contract, "approve");
  const nestedFn =
    nestedContract && nestedMethod
      ? makeContractFn(nestedContract, nestedMethod)
      : undefined;
  const top = new xdr.SorobanAuthorizedInvocation({
    function: rootFn,
    subInvocations: nestedFn
      ? [new xdr.SorobanAuthorizedInvocation({ function: nestedFn, subInvocations: [] })]
      : [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: contract.toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: top,
  });
}

function authEntryCreateContract(contract: Address) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: contract.toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
          new xdr.CreateContractArgs({
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
              new xdr.ContractIdPreimageFromAddress({
                address: contract.toScAddress(),
                salt: Buffer.alloc(32, 0x00),
              })
            ),
            executable: xdr.ContractExecutable.contractExecutableWasm(
              Buffer.alloc(32, 0x99)
            ),
          })
        ),
      subInvocations: [],
    }),
  });
}

// FIX 1: func is a CONSTRUCTED xdr.HostFunction union (not the enum + args tuple).
function buildSorobanTx({
  auth = [],
  fee = "100",
  resourceFee = 0,
  sourceKey = Keypair.random(),
  includePayment = false,
}: {
  auth?: any[];
  fee?: string;
  resourceFee?: number;
  sourceKey?: any;
  includePayment?: boolean;
} = {}) {
  const account = new Account(sourceKey.publicKey(), "0");
  const builder = new TransactionBuilder(account, {
    fee,
    networkPassphrase: Networks.TESTNET,
  });

  let op;
  if (includePayment) {
    op = Operation.payment({
      destination: sourceKey.publicKey(),
      asset: Asset.native(),
      amount: "10",
    });
  } else {
    const dummy = xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32, 0x01));
    const invokeArgs = new xdr.InvokeContractArgs({
      contractAddress: dummy,
      functionName: "dummy",
      args: [],
    });
    op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs),
      auth,
    });
  }

  let txBuilder = builder.addOperation(op).setTimeout(30);
  if (resourceFee > 0) {
    txBuilder = txBuilder.setSorobanData(
      new SorobanDataBuilder().setResourceFee(BigInt(resourceFee)).build()
    );
  }

  return { xdrStr: txBuilder.build().toXDR(), sourceKey };
}

// Plain decoded object -> exercises evaluatePolicy's object branch with zero SDK envelope.
function decoded(overrides = {}) {
  return {
    xdr: "",
    source: "GA",
    fee: 100,
    resourceFee: 0,
    sequence: "0",
    operations: [{ name: "invokeHostFunction" }],
    authEntries: [{ contractId: CONTRACT_A_HEX, functionName: "approve", depth: 0 }],
    ...overrides,
  };
}

const allowBoth = {
  ...DEFAULT_POLICY,
  defaultAction: "deny" as const,
  rules: [
    { action: "allow" as const, contractId: CONTRACT_A_HEX, method: "approve" },
    { action: "allow" as const, contractId: CONTRACT_B_HEX, method: "transfer" },
  ],
};

describe("signer-policy", () => {
  it("benign accept: explicit allow rule with matching nested auth passes", () => {
    const tx = decoded({
      authEntries: [
        { contractId: CONTRACT_A_HEX, functionName: "approve", depth: 0 },
        { contractId: CONTRACT_B_HEX, functionName: "transfer", depth: 1 },
      ],
    });
    expect(evaluatePolicy(allowBoth, tx, { nowMs: 1_000 }).status).toBe("allow");
  });

  it("nested sub-invocation to a non-allowlisted contract is denied", () => {
    const tx = decoded({
      authEntries: [
        { contractId: CONTRACT_A_HEX, functionName: "approve", depth: 0 },
        { contractId: CONTRACT_B_HEX, functionName: "transfer", depth: 1 },
      ],
    });
    const policy = {
      ...DEFAULT_POLICY,
      defaultAction: "deny" as const,
      rules: [{ action: "allow" as const, contractId: CONTRACT_A_HEX, method: "approve" }],
    };
    const result = evaluatePolicy(policy, tx, { nowMs: 1_000 });
    expect(result.status).toBe("deny");
    expect(result.reason).toContain("auth_entry_not_allowed");
  });

  it("classic payment op is denied", () => {
    const tx = decoded({ operations: [{ name: "payment" }] });
    const result = evaluatePolicy({ ...DEFAULT_POLICY, defaultAction: "allow" as const }, tx, {
      nowMs: 1_000,
    });
    expect(result.status).toBe("deny");
    expect(result.reason).toContain("classic_payment_forbidden");
  });

  it("inclusion fee over limit is denied", () => {
    const tx = decoded({ fee: 5_000_000 });
    const policy = {
      ...DEFAULT_POLICY,
      defaultAction: "allow" as const,
      rules: [{ action: "allow" as const, contractId: CONTRACT_A_HEX, method: "approve" }],
      maxInclusionFee: 1_000,
    };
    const result = evaluatePolicy(policy, tx, { nowMs: 1_000 });
    expect(result.status).toBe("deny");
    expect(result.reason).toContain("inclusion_fee_exceeded");
  });

  it("resource fee over limit is denied distinctly from inclusion fee", () => {
    const tx = decoded({ resourceFee: 2_000_000 });
    const policy = {
      ...DEFAULT_POLICY,
      defaultAction: "allow" as const,
      rules: [{ action: "allow" as const, contractId: CONTRACT_A_HEX, method: "approve" }],
      maxResourceFee: 1_000,
    };
    const result = evaluatePolicy(policy, tx, { nowMs: 1_000 });
    expect(result.status).toBe("deny");
    expect(result.reason).toContain("resource_fee_exceeded");
  });

  it("over the rolling budget is denied", () => {
    const tx = decoded();
    const policy = {
      ...DEFAULT_POLICY,
      defaultAction: "allow" as const,
      rules: [{ action: "allow" as const, contractId: CONTRACT_A_HEX, method: "approve" }],
      budget: { maxAuthEntries: 0, windowMs: 60_000 },
    };
    const result = evaluatePolicy(policy, tx, {
      budgetStore: new BudgetStore(),
      nowMs: 1_000,
    });
    expect(result.status).toBe("deny");
    expect(result.reason).toContain("budget_exceeded");
  });

  it("non-contract auth arm such as createContract is denied", () => {
    const tx = decoded({
      authEntries: [
        {
          contractId: "__NON_CONTRACT__",
          functionName: "sorobanAuthorizedFunctionTypeCreateContractHostFn",
          depth: 0,
        },
      ],
    });
    const policy = {
      ...DEFAULT_POLICY,
      defaultAction: "allow" as const,
      rules: [{ action: "allow" as const, contractId: CONTRACT_A_HEX, method: "approve" }],
    };
    const result = evaluatePolicy(policy, tx, { nowMs: 1_000 });
    expect(result.status).toBe("deny");
    expect(result.reason).toContain("non_contract_auth_forbidden");
  });

  it("missing or malformed policy file fails closed deny (string policy + object tx)", () => {
    const tx = decoded();
    const result = evaluatePolicy("./src/soroban/signer-policy/does-not-exist.yaml", tx, {
      nowMs: 1_000,
    });
    expect(result.status).toBe("deny");
  });

  it("loads the on-disk default policy and resolves the no-env path", () => {
    const loaded = loadPolicyFromFile("./src/soroban/signer-policy/default-policy.yaml");
    expect(loaded.defaultAction).toBe("deny");
    expect(resolvePolicyPath()).toBe("./src/soroban/signer-policy/default-policy.yaml");
    const { xdrStr } = buildSorobanTx({ auth: [makeAuthEntry(contractAddress(0x01))] });
    const result = evaluatePolicy("./src/soroban/signer-policy/default-policy.yaml", xdrStr, {
      nowMs: 1_000,
    });
    expect(result.status).toBe("deny"); // default-policy.yaml has empty rules -> default deny
  });

  it("decodeTx round-trips fee, ops, and nested auth entries (real envelope)", () => {
    const { xdrStr, sourceKey } = buildSorobanTx({
      auth: [makeAuthEntry(contractAddress(0x01), contractAddress(0x02), "transfer")],
      fee: "150",
    });
    const d = decodeTx(xdrStr, Networks.TESTNET);
    expect(d.source).toBe(sourceKey.publicKey());
    expect(d.fee).toBe(150);
    expect(d.operations).toHaveLength(1);
    expect(d.operations[0].name).toBe("invokeHostFunction");
    expect(
      d.authEntries.some((e) => e.contractId === CONTRACT_A_HEX && e.functionName === "approve")
    ).toBe(true);
    expect(
      d.authEntries.some((e) => e.contractId === CONTRACT_B_HEX && e.functionName === "transfer")
    ).toBe(true);
    expect(evaluatePolicy(allowBoth, xdrStr, { nowMs: 1_000 }).status).toBe("allow");
  });

  it("alert fires on deny", async () => {
    const emitSpy = jest.spyOn(AlertSink.prototype, "emit").mockResolvedValue(undefined);
    const tx = decoded({ operations: [{ name: "payment" }] });
    evaluatePolicy({ ...DEFAULT_POLICY, defaultAction: "allow" as const }, tx, {
      nowMs: 1_000,
      alertSink: new AlertSink("https://example.invalid/wh"),
    });
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "deny" }));
    emitSpy.mockRestore();
  });

  it("walkAuthEntries includes the depth-1 sub-invocation contract id from the real nested auth tree", () => {
    const entry = makeAuthEntry(contractAddress(0x01), contractAddress(0x02), "transfer");
    const flattened = walkAuthEntries(entry);
    expect(flattened.some((item) => item.contractId === CONTRACT_B_HEX && item.depth === 1)).toBe(
      true
    );
  });
});