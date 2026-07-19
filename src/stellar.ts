import { 
  rpc, 
  TransactionBuilder, 
  Networks, 
  Contract, 
  scValToNative, 
  nativeToScVal, 
  Address, 
  Transaction,
  Account,
  xdr
} from '@stellar/stellar-sdk';

export const CONTRACT_ID = "CCEKTTQYLZOMTKFBH6ESOGJORLRDFCLCDZQ2YPZMI66KJMQ63LFA7AKW";
export const TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

export const server = new rpc.Server(RPC_URL);
const contract = new Contract(CONTRACT_ID);

export interface CampaignInfo {
  creator: string;
  target: bigint;
  deadline: bigint;
  token: string;
  title: string;
  description: string;
  raised: bigint;
  claimed: boolean;
}

// Helper to decode string values from ScVal
function decodeString(val: any): string {
  if (typeof val === 'string') return val;
  if (val instanceof Uint8Array) {
    return new TextDecoder().decode(val);
  }
  return String(val);
}

export async function getCampaignInfo(): Promise<CampaignInfo> {
  const dummyAccount = new Account(
    "GBVCWIVIH7O3CSFRD6FZGG7CS5JLVCOJ2FSAO5XRZF53HJ7WQ5WMV6ZK", 
    "0"
  );
  
  const tx = new TransactionBuilder(dummyAccount, {
    fee: "1000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_campaign"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error("Failed to get campaign details. The campaign might not be initialized yet.");
  }

  const rawCampaign = scValToNative(sim.result.retval);
  return {
    creator: rawCampaign.creator,
    target: rawCampaign.target,
    deadline: rawCampaign.deadline,
    token: rawCampaign.token,
    title: decodeString(rawCampaign.title),
    description: decodeString(rawCampaign.description),
    raised: rawCampaign.raised,
    claimed: rawCampaign.claimed,
  };
}

export async function getPledge(donorAddress: string): Promise<bigint> {
  const dummyAccount = new Account(donorAddress, "0");
  
  const tx = new TransactionBuilder(dummyAccount, {
    fee: "1000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call("get_pledge", Address.fromString(donorAddress).toScVal())
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    return 0n;
  }
  return scValToNative(sim.result.retval) as bigint;
}

export async function getLatestLedgerSequence(): Promise<number> {
  const latest = await server.getLatestLedger();
  return latest.sequence;
}

// Poll transaction status
export async function pollTransaction(hash: string): Promise<any> {
  const maxAttempts = 30;
  const interval = 1500; // 1.5 seconds

  for (let i = 0; i < maxAttempts; i++) {
    const response = await server.getTransaction(hash);
    if (
      response.status === rpc.Api.GetTransactionStatus.SUCCESS || 
      response.status === rpc.Api.GetTransactionStatus.FAILED
    ) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("Transaction polling timeout exceeded");
}

export interface TxResult {
  hash: string;
  success: boolean;
  error?: string;
}

// Submit signed transaction XDR
export async function submitSignedXdr(signedXdr: string): Promise<TxResult> {
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as Transaction;
  const sendResult = await server.sendTransaction(signedTx);
  
  if (sendResult.status === 'ERROR') {
    const errorMsg = sendResult.errorResult 
      ? sendResult.errorResult.toXDR('base64') 
      : "Transaction rejected by RPC";
    throw new Error(errorMsg);
  }

  const pollResult = await pollTransaction(sendResult.hash);
  if (pollResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return {
      hash: sendResult.hash,
      success: true
    };
  } else {
    return {
      hash: sendResult.hash,
      success: false,
      error: pollResult.resultXdr || "Transaction execution failed"
    };
  }
}

// Prepare transaction with simulation (resource fees and footprints)
export async function buildAndPrepareTx(
  userAddress: string,
  op: xdr.Operation
): Promise<Transaction> {
  let account;
  try {
    account = await server.getAccount(userAddress);
  } catch (err) {
    throw new Error("Your account is not funded on Testnet yet. Please fund it using Freighter wallet or Friendbot.");
  }

  const tx = new TransactionBuilder(account, {
    fee: "100000", // optimized by prepareTransaction
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  return preparedTx as Transaction;
}

// Build Pledge Transaction
export async function preparePledgeTx(donorAddress: string, amountXlm: string): Promise<Transaction> {
  const amountStroops = BigInt(Math.floor(parseFloat(amountXlm) * 10000000));
  
  const op = contract.call(
    "pledge",
    Address.fromString(donorAddress).toScVal(),
    nativeToScVal(amountStroops, { type: "i128" })
  );
  
  return buildAndPrepareTx(donorAddress, op);
}

// Build Withdraw Transaction
export async function prepareWithdrawTx(creatorAddress: string): Promise<Transaction> {
  const op = contract.call("withdraw");
  return buildAndPrepareTx(creatorAddress, op);
}

// Build Refund Transaction
export async function prepareRefundTx(donorAddress: string): Promise<Transaction> {
  const op = contract.call(
    "refund",
    Address.fromString(donorAddress).toScVal()
  );
  return buildAndPrepareTx(donorAddress, op);
}

// Build Initialize Campaign Transaction (Allows setting up campaign if needed)
export async function prepareInitializeTx(
  creatorAddress: string,
  targetXlm: string,
  deadlineSec: number,
  title: string,
  description: string
): Promise<Transaction> {
  const targetStroops = BigInt(Math.floor(parseFloat(targetXlm) * 10000000));
  
  const op = contract.call(
    "initialize",
    Address.fromString(creatorAddress).toScVal(),
    nativeToScVal(targetStroops, { type: "i128" }),
    nativeToScVal(BigInt(deadlineSec), { type: "u64" }),
    Address.fromString(TOKEN_ID).toScVal(),
    nativeToScVal(title),
    nativeToScVal(description)
  );

  return buildAndPrepareTx(creatorAddress, op);
}

// Decoded Event Interface
export interface CampaignEvent {
  id: string;
  ledger: number;
  type: 'pledge' | 'withdraw' | 'refund' | 'unknown';
  actor: string;
  amount: number; // in XLM
}

// Get recent events emitted by our contract
export async function getCampaignEvents(startLedger: number): Promise<CampaignEvent[]> {
  try {
    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [CONTRACT_ID]
        }
      ],
      limit: 100
    });

    if (!response.events) return [];

    return response.events.map((event: any) => {
      let type: 'pledge' | 'withdraw' | 'refund' | 'unknown' = 'unknown';
      let actor = 'unknown';
      let amount = 0;

      try {
        const topics = event.topic.map((t: any) => scValToNative(t));
        const rawData = scValToNative(event.value);

        const topicName = topics[0];
        if (topicName === 'pledge') {
          type = 'pledge';
          actor = topics[1]?.toString() || 'unknown';
          amount = Number(rawData) / 10000000;
        } else if (topicName === 'withdraw') {
          type = 'withdraw';
          actor = topics[1]?.toString() || 'unknown';
          amount = Number(rawData) / 10000000;
        } else if (topicName === 'refund') {
          type = 'refund';
          actor = topics[1]?.toString() || 'unknown';
          amount = Number(rawData) / 10000000;
        }
      } catch (err) {
        console.error("Failed to parse event", event, err);
      }

      return {
        id: event.id,
        ledger: event.ledger,
        type,
        actor,
        amount
      };
    });
  } catch (err) {
    console.error("Failed to fetch events", err);
    return [];
  }
}
