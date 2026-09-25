import { env } from "./env";
import { signedRequestHeaders, type RequestSigner } from "./signed-request";

export type Uint = string;
export type Phase = "Stage1" | "Stage2" | "ListingPending" | "Stage3" | "Dissolved";
export type PositionClassV2 = "Backer" | "Buyer" | "BuilderPurchase";
export type ReasonV2 =
  | "None"
  | "PhaseClosed"
  | "InvalidPosition"
  | "InvalidQuantity"
  | "StaleNonce"
  | "EmptyBook"
  | "Insolvent"
  | "PriceInvalid"
  | "VenueUnavailable"
  | "Migrating"
  | "Unauthorized";
export interface ValidityV2 {
  available: boolean;
  reason: ReasonV2;
  phase: Phase;
  stateNonce: Uint;
}
export interface Health {
  ok: boolean;
  chainId: number;
  head: number | null;
  headTimestamp: number | null;
  indexedBlock: number;
  deploymentV31: boolean;
  error: string | null;
}
export interface ApiConfig {
  chainId: number;
  isLocal: boolean;
  protocol: "3.1";
  addresses: {
    factory: string;
    registry: string;
    quote: string;
    adapter: string;
    attester: string;
    council: string;
    rolloverRouter: string | null;
    /** Secondary-market swap router; the zero address when none is deployed. */
    router?: string | null;
    poolManager?: string | null;
  };
  /** Lowercase API admin addresses (ADMIN_ADDRESSES): may run analyses without the rate limit. */
  admins?: string[];
  stageBounds?: {
    stage1Min: Uint | number;
    stage1Max: Uint | number;
    stage2Min: Uint | number;
    stage2Max: Uint | number;
  };
  quote: { address: string; symbol: string; decimals: 6; quoteFrozen: boolean; testToken?: boolean };
  templates: {
    id: string;
    name: "ESCROW_LAUNCH" | "BUDGET_LAUNCH";
    version: Uint;
    implementations: {
      raise: string;
      token: string;
      vesting: string;
      governor: string;
      claims: string;
      adapter: string;
      quote: string;
      attester: string;
      council: string;
      treasury: string;
    };
    parameters: ParametersV2;
    /** Base-layer treasury rules pinned in the version's implementations. */
    treasury: { spendCapBps: number; vestingDuration: Uint };
    bundleHash: string;
    publishedAt: Uint;
    deprecated: boolean;
  }[];
}
export interface ParametersV2 {
  kappaMax: Uint;
  budgetCeilingMax: Uint;
  vetoMax: Uint;
  vetoTotal: Uint;
  vetoCooldown: Uint;
  voting: Uint;
  dispute: Uint;
  execution: Uint;
  proposalInterval: Uint;
  minimumBackers: number;
  tradeFeeBps: number;
  surchargeBps: number;
  /** Governed stage timings pinned into the template version (seconds). Absent on older deployments. */
  stage1Min?: Uint | number;
  stage1Max?: Uint | number;
  stage2Min?: Uint | number;
  stage2Max?: Uint | number;
  treasuryVesting?: Uint | number;
}
export interface RaiseSummary {
  address: string;
  name: string;
  symbol: string;
  token: string;
  builder: string;
  template: "ESCROW_LAUNCH" | "BUDGET_LAUNCH";
  templateId: string;
  templateVersion: Uint;
  phase: Phase;
  deadlines: {
    start: number;
    stage1End: number;
    vetoUntil: number;
    stage2Start: number;
    stage2End: number;
    listedAt: number;
  };
  E: Uint;
  R: Uint;
  V: Uint;
  T: Uint;
  O: Uint;
  bookPrice: Uint | null;
  curvePrice: Uint;
  targetPrice: Uint;
  sold: Uint;
  allocation: Uint;
  backers: number;
  quote: { address: string; symbol: "USDG"; decimals: 6 };
  metadata: BuilderProfile;
  profile: BuilderProfile;
  description: string;
  createdAt: number;
  riskScoreBps: number | null;
  vetoActive: boolean;
  /** Chain time the project dissolved (Dissolved only). Earlier than stage1End means the team dissolved it. */
  dissolvedAt: number | null;
  /** Who dissolved it: the team (after the Stage 1 minimum) or the Stage 1 deadline. */
  dissolvedBy: "builder" | "deadline" | null;
  stateNonce: Uint;
  blockNumber: number;
  chainTime: number;
}
export interface ReserveStateV2 {
  validity: ValidityV2;
  E: Uint;
  R: Uint;
  V: Uint;
  T: Uint;
  O: Uint;
  X0: Uint;
  lastT: Uint;
  H: Uint;
  J: Uint;
  claimCount: Uint;
  stateNonce: Uint;
}
export interface LaunchApiConfig {
  quote: string;
  treasury: string;
  supply: Uint;
  targetPrice: Uint;
  budgetCeiling: Uint;
  stage1Length: Uint;
  stage2Length: Uint;
  builders: string[];
}
export interface ListingStatusV2 {
  validity: ValidityV2;
  liveCostEligible: boolean;
  basis: Uint;
  liquidTokens: Uint;
  vestedTokens: Uint;
  destination: string;
}
export interface ListingPreviewV2 {
  validity: ValidityV2;
  branch: 0 | 1 | 2 | 3; // Positive | QuoteWithoutTokens | ZeroQuote | Empty
  price: Uint;
  sqrtPriceX96: Uint;
  escrowRolled: Uint;
  desiredQuote: Uint;
  desiredToken: Uint;
  usedQuote: Uint;
  usedToken: Uint;
  minQuote: Uint;
  minToken: Uint;
  liquidity: Uint;
  bookBurn: Uint;
  liquidityReserveBurn: Uint;
  depthBurn: Uint;
  quoteDust: Uint;
  backerDelivery: Uint;
  buyerDelivery: Uint;
  builderDelivery: Uint;
  ordinaryDestination: string;
  builderDestination: string;
  claimLiabilities: Uint;
  claimsEndOnSuccess: boolean;
}
export interface ListingRecordV2 {
  poolId: string;
  positionId: string;
  owner: string;
  sqrtPriceX96: Uint;
  liquidity: Uint;
  usedQuote: Uint;
  usedToken: Uint;
}
export interface StreamV2 {
  allocation: Uint;
  released: Uint;
  accumulator: Uint;
  carry: Uint;
  remaining: Uint;
  credited: Uint;
}
export interface RaiseDetail extends RaiseSummary {
  config: LaunchApiConfig;
  modules: {
    token: string;
    vesting: string;
    governor: string;
    claims: string;
    adapter: string;
    attester: string;
    council: string;
  };
  reserveState: ReserveStateV2;
  feeAccruals: { reserveRetained: Uint; rewards: Uint; treasury: Uint };
  governance: {
    config: { builder: string; parameters: ParametersV2; enabled: boolean };
    state: { end: Uint; escrow: Uint; remainingCeiling: Uint };
  };
  listingPreview: ListingPreviewV2 | { validity: ValidityV2 } | null;
  listingStatus: (ListingStatusV2 & { id: Uint })[] | null;
  listingRecord: ListingRecordV2 | null;
  tokenStream: { tokens: StreamV2; quote: StreamV2; totalQuota: Uint; rewardNonce: Uint };
  treasury: TreasuryState;
  latestReport: Report | null;
}
/** Governed treasury: every fee plus the 10% allocation; spent only by an executed proposal. */
export interface TreasuryState {
  address: string;
  allocation: Uint;
  lockedTokens: Uint;
  spendableTokens: Uint;
  tokenBalance: Uint;
  quoteBalance: Uint;
  availableQuote: Uint;
  vestingDuration: Uint;
  spentQuote: Uint;
  spentTokens: Uint;
  spendCapBps: number;
}
export type RolloverKind = "CostExit" | "ProtectedExit" | "DissolutionClaim";
export interface RolloverSource {
  raise: string;
  name: string;
  symbol: string;
  phase: Phase;
  stateNonce: Uint;
  positions: {
    id: Uint;
    kind: RolloverKind;
    amount: Uint;
    tokens: Uint;
    minPayout: Uint;
    cost?: Uint;
    profit?: Uint;
  }[];
}
export interface PositionStateV2 {
  validity: ValidityV2;
  owner: string;
  class: PositionClassV2;
  tokens: Uint;
  basis: Uint;
  shares: Uint;
  quota: Uint;
  phase: Phase;
}
export interface GuaranteedClaimV2 {
  validity: ValidityV2;
  amount: Uint;
  validUntil: Uint;
  phase: Phase;
  stateNonce: Uint;
}
export interface ExitResultV2 {
  cost: Uint;
  value: Uint;
  premium: Uint;
  cap: Uint;
  profit: Uint;
  qSold: Uint;
  burn: Uint;
  payout: Uint;
}
export type ExitQuoteV2 =
  | { validity: ValidityV2 }
  | {
      validity: ValidityV2;
      result: ExitResultV2;
      bookBurn: Uint;
      depthBurn: Uint;
    };
export type TradeQuoteV2 =
  | { validity: ValidityV2 }
  | {
      validity: ValidityV2;
      gross: Uint;
      ammAmount: Uint;
      tokens: Uint;
      net: Uint;
      fees: { total: Uint; reserve: Uint; reward: Uint; treasury: Uint };
      priceBefore: Uint;
      priceAfter: Uint;
      priceImpactBps: Uint;
      depthBurn: Uint;
    };
export interface Position {
  user: string;
  raise: string;
  phase: Phase;
  stateNonce: Uint;
  blockNumber: number;
  chainTime: number;
  positions: {
    id: Uint;
    positionState: PositionStateV2;
    guaranteedClaim: GuaranteedClaimV2;
    redeemQuote: ExitQuoteV2;
    protectedExitQuote: ExitQuoteV2 | null;
    listingStatus: ListingStatusV2;
    atRiskBasis: Uint;
  }[];
  buyerLedger: { tokens: Uint; marketExitQuote: TradeQuoteV2 };
  delivery: { tokens: Uint; originalQuota: Uint; frozenRecord: true };
  quota: Uint;
  pendingRewards: { tokens: Uint; quote: Uint };
  walletTokenBalance: Uint;
  walletQuoteBalance: Uint;
  vesting: { grant: Uint; vested: Uint; claimed: Uint; claimable: Uint };
}
export interface Trade {
  raiseAddr: string;
  type: "deposit" | "costExit" | "protectedExit" | "buy" | "sell";
  trader: string;
  positionId: Uint;
  quote: Uint;
  tokens: Uint;
  price: Uint | null;
  data: Record<string, unknown>; // Complete ABI-decoded event, including balances/result/trade
  timestamp: number;
  txHash: string;
  blockNumber: number;
  logIndex: number;
}
export interface PricePoint {
  raiseAddr: string;
  kind: "curve" | "book";
  price: Uint | null;
  curvePrice: Uint;
  balances: {
    E: Uint;
    R: Uint;
    V: Uint;
    T: Uint;
    O: Uint;
    sold: Uint;
    phase: number;
    stateNonce?: Uint;
    stage2Start?: number;
    stage2End?: number;
    vetoUntil?: number;
    J?: Uint;
    H?: Uint;
    listingPrice?: Uint;
  };
  event: string;
  timestamp: number;
  txHash: string;
  blockNumber: number;
  logIndex: number;
}
export interface Activity {
  kind: string;
  contract: "factory" | "raise" | "token" | "governor" | "vesting" | "claims" | "offchain";
  actor: string | null;
  summary: string;
  data: Record<string, unknown>;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
}
export interface Proposal {
  id: Uint;
  amount: Uint;
  capitalSnapshot: Uint;
  yesWeight: Uint;
  noWeight: Uint;
  votingEnds: Uint;
  disputeEnds: Uint;
  executeEnds: Uint;
  uri: string;
  /** Draw: Budget Launch draw on Stage 2 escrow. Spend: payment from the treasury. */
  kind: "Draw" | "Spend";
  /** Capital: Stage 2 vote by contributed capital. Token: Stage 3 vote by token holders. */
  mode: "Capital" | "Token";
  recipient: string;
  tokenAmount: Uint;
  snapshotId: Uint;
  status: "None" | "Active" | "Passed" | "Defeated" | "Executed" | "Cancelled" | "Expired";
  state:
    | "Voting"
    | "AwaitingFinalization"
    | "Dispute"
    | "Executable"
    | "None"
    | "Defeated"
    | "Executed"
    | "Cancelled"
    | "Expired";
  quorumBps: number;
  approvalBps: number;
  cap: Uint;
  executedTx: string | null;
}
export interface Inbox {
  user: string;
  now: number;
  items: {
    type:
      | "dissolution_claim"
      | "listing_ready"
      | "listing_scheduled"
      | "stage1_ready"
      | "rewards_available"
      | "vesting_available"
      | "vote_open"
      | "dispute_exit";
    severity: "action" | "upcoming";
    raise: string;
    raiseName: string;
    symbol: string;
    title: string;
    dueAt: number | null;
    data: Record<string, unknown>;
  }[];
}
interface Report {
  raise: string;
  createdAt: number;
  riskScoreBps: number;
  veto: boolean;
  findings: {
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
  }[];
  metrics: Record<string, number | string>;
  panel: {
    scorer: string;
    riskScoreBps: number;
    veto: boolean;
    rationale: string;
  }[];
  reportHash: string;
  uri: string;
  postedTx: string | null;
  builderResponse: { text: string; createdAt: number } | null;
}

interface Feedback {
  id: number;
  raise: string;
  author: string;
  createdAt: number;
  rating: 1 | 2 | 3 | 4 | 5;
  text: string;
  isBacker: boolean;
}

export interface BuilderProfile {
  name: string | null;
  tagline: string;
  description: string;
  website: string;
  twitter: string;
  github: string;
  docs: string;
  logoUrl: string | null;
  /** Uploaded project image reference (ipfs://…, https://… or this API's /v2/uploads/ URL). */
  image?: string | null;
  /** `image` resolved to an http(s) URL (gateway applied), or null. Read-only. */
  imageUrl?: string | null;
}

/** The fields PUT /v2/raises/:address/profile accepts; `image` only when it changed (absent keeps the stored one). */
export function profileBody(profile: BuilderProfile, image?: string | null): Record<string, string | null> {
  const body: Record<string, string | null> = {
    name: profile.name,
    tagline: profile.tagline,
    description: profile.description,
    website: profile.website,
    twitter: profile.twitter,
    github: profile.github,
    docs: profile.docs,
    logoUrl: profile.logoUrl,
  };
  if (image !== undefined) body.image = image;
  return body;
}

export interface UploadResult {
  uri: string;
  url: string;
  cid: string | null;
  contentType: string;
  bytes: number;
}

export interface BuilderUpdate {
  id: number;
  raise: string;
  author: string;
  createdAt: number;
  title: string;
  body: string;
  kind: "milestone" | "update" | "incident";
}

export type InboxItem = Inbox["items"][number];
export type LocalAccountRole = "deployer" | "attester" | "council" | "builder" | "backer" | "buyer" | "whale";
export interface DevAccount {
  index: number;
  address: string;
  privateKey: string;
  /** Stable role key; the display name comes from messages (localAccounts.names). */
  role: LocalAccountRole;
  /** Backer ordinal (1–10) for role "backer". */
  ordinal?: number;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("unreachable", `Backend unreachable at ${env.apiUrl}`, 0);
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* keep defaults */
    }
    throw new ApiError(code, message, res.status, Number(res.headers.get("Retry-After")) || undefined);
  }
  return (await res.json()) as T;
}

async function signedRequest<T>(method: "POST" | "PUT", path: string, body: object, signer: RequestSigner) {
  const raw = JSON.stringify(body);
  return request<T>(path, { method, body: raw, headers: await signedRequestHeaders(signer, method, path, raw) });
}

export const api = {
  inbox: (user: string) => request<{ user: string; now: number; items: InboxItem[] }>(`/v2/users/${user}/inbox`),
  updates: (raise: string) => request<BuilderUpdate[]>(`/v2/raises/${raise}/updates`),
  saveProfile: (raise: string, body: Record<string, string | null>, signer: RequestSigner) =>
    signedRequest<{ ok: boolean; profile: BuilderProfile }>("PUT", `/v2/raises/${raise}/profile`, body, signer),
  upload: (body: { contentType: string; data: string }, signer: RequestSigner) =>
    signedRequest<UploadResult>("POST", "/v2/uploads", body, signer),
  postUpdate: (raise: string, body: Pick<BuilderUpdate, "title" | "body" | "kind">, signer: RequestSigner) =>
    signedRequest<BuilderUpdate>("POST", `/v2/raises/${raise}/updates`, body, signer),
  respond: (raise: string, hash: string, body: { text: string }, signer: RequestSigner) =>
    signedRequest<Report>("POST", `/v2/raises/${raise}/reports/${hash}/response`, body, signer),
  health: () => request<Health>("/v2/health"),
  config: () => request<ApiConfig>("/v2/config"),
  raises: (state?: Phase) => request<RaiseSummary[]>(`/v2/raises${state ? `?phase=${state}` : ""}`),
  raise: (address: string) => request<RaiseDetail>(`/v2/raises/${address}`),
  position: (raise: string, user: string) => request<Position>(`/v2/raises/${raise}/positions/${user}`),
  trades: (raise: string, limit = 100) => request<Trade[]>(`/v2/raises/${raise}/trades?limit=${limit}`),
  priceHistory: (raise: string) => request<PricePoint[]>(`/v2/raises/${raise}/price-history`),
  activity: (raise: string, limit = 100) => request<Activity[]>(`/v2/raises/${raise}/activity?limit=${limit}`),
  report: (raise: string) => request<Report | null>(`/v2/raises/${raise}/report`),
  reports: (raise: string) => request<Report[]>(`/v2/raises/${raise}/reports`),
  feedback: (raise: string) => request<Feedback[]>(`/v2/raises/${raise}/feedback`),
  proposals: (raise: string) => request<Proposal[]>(`/v2/raises/${raise}/proposals`),
  rolloverSources: (user: string) =>
    request<{ user: string; now: number; router: string | null; sources: RolloverSource[] }>(
      `/v2/users/${user}/rollover-sources`,
    ),
  postFeedback: (raise: string, body: { author: string; rating: number; text: string; signature: string }) =>
    request<Feedback>(`/v2/raises/${raise}/feedback`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  postMetadata: async (raise: string, body: { description: string; website?: string }, signer: RequestSigner) => {
    const path = `/v2/raises/${raise}/metadata`;
    const raw = JSON.stringify(body);
    return request<{ ok: boolean }>(path, {
      method: "POST",
      body: raw,
      headers: await signedRequestHeaders(signer, "POST", path, raw),
    });
  },
  analyze: async (raise: string, signer: RequestSigner) => {
    const path = `/v2/raises/${raise}/analyze`;
    return request<Report>(path, {
      method: "POST",
      body: "{}",
      headers: await signedRequestHeaders(signer, "POST", path, "{}"),
    });
  },
};
