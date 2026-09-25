/**
 * viem clients plus a careful transaction sender: per-wallet serialization, local nonce tracking with resync,
 * transient-error retries with backoff, a gas-price cap, revert-name decoding, and a dry-run mode that only logs.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  formatGwei,
  http,
  parseAbi,
  parseGwei,
  type Abi,
  type Address,
  type Chain as ViemChain,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { errorText, log } from './log';

/** Errors every Portex module can raise (library errors are missing from some module ABIs). */
export const PROTOCOL_ERRORS = parseAbi([
  'error Unauthorized()',
  'error InvalidConfig()',
  'error InvalidPhase()',
  'error InvalidAmount()',
  'error InvalidPosition()',
  'error StaleNonce()',
  'error Expired()',
  'error Slippage()',
  'error InvariantFailure()',
  'error WrongAssetDelta()',
  'error Reentrancy()',
  'error VenueFailure()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
]);

export function withErrors(abi: Abi): Abi {
  const names = new Set(abi.filter((x) => x.type === 'error').map((x) => (x as { name: string }).name));
  return [...abi, ...PROTOCOL_ERRORS.filter((e) => !names.has(e.name))] as Abi;
}

/** The custom error name of a revert (e.g. 'StaleNonce'), 'reverted' for an unnamed revert, or null. */
export function revertName(error: unknown): string | null {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? 'reverted';
  }
  if (error instanceof TxRevertedError) return 'reverted';
  const text = String((error as { message?: string })?.message ?? error);
  return /execution reverted|reverted/i.test(text) ? 'reverted' : null;
}

export const isNonceError = (error: unknown) =>
  /nonce too low|nonce too high|already known|replacement transaction underpriced|invalid nonce|nonce has already been used/i.test(
    String((error as { message?: string })?.message ?? error),
  );
export const isFundsError = (error: unknown) =>
  /insufficient funds/i.test(String((error as { message?: string })?.message ?? error));
/**
 * Errors worth retrying. Load-balanced public RPCs (X Layer testnet) have nodes that briefly disagree about the
 * head, so "block not found" / "out of range" / "header not found" are transient too.
 */
export function isTransient(error: unknown): boolean {
  if (revertName(error)) return false;
  if (error instanceof BaseError && error.walk((e) => (e as Error)?.name === 'BlockNotFoundError')) return true;
  const text = String((error as { message?: string })?.message ?? error);
  return /fetch failed|timeout|timed out|econnreset|econnrefused|socket|network|rate limit|too many requests|429|502|503|504|header not found|block could not be found|block not found|block is out of range|unknown block|temporarily unavailable|request failed|unexpected end|missing trie node|load balancer/i.test(
    text,
  );
}

/** A log query refused for its block range (e.g. "block range greater than 100 max"): shrink, don't retry. */
export const isRangeError = (error: unknown) =>
  /block range|range (is )?too (large|wide)|greater than \d+ max|exceeds? .*range|too many blocks|query returned more than/i.test(
    String((error as { message?: string })?.message ?? error),
  );

export class GasCapError extends Error {
  constructor(
    readonly price: bigint,
    readonly cap: bigint,
  ) {
    super(`gas price ${formatGwei(price)} gwei is above the cap of ${formatGwei(cap)} gwei`);
  }
}
export class TxRevertedError extends Error {
  constructor(
    readonly hash: string,
    readonly label: string,
  ) {
    super(`${label} reverted on-chain: ${hash}`);
  }
}
export class TxPendingError extends Error {
  constructor(
    readonly hash: string,
    readonly label: string,
  ) {
    super(`${label} not confirmed in time: ${hash}`);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reverts that usually mean the simulating node has not seen our previous transaction yet. */
const STALE_READ_REVERTS = ['ERC20InsufficientAllowance', 'ERC20InsufficientBalance'];

export interface ChainOptions {
  rpcUrl: string;
  chainId: number;
  maxGasPriceGwei: number;
  gasPriceMultiplier: number;
  dryRun: boolean;
  receiptTimeoutMs?: number;
  pollingIntervalMs?: number;
}

export interface Call {
  address: Address | string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export class Chain {
  readonly client: PublicClient;
  readonly chain: ViemChain;
  readonly isLocal: boolean;
  private wallets = new Map<string, WalletClient>();
  private nonces = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();
  private gasCache: { at: number; price: bigint } | null = null;
  stats = { sent: 0, reverted: 0, retried: 0, gasUsed: 0n, fees: 0n };

  constructor(readonly opts: ChainOptions) {
    this.isLocal = opts.chainId === 31337;
    this.chain = defineChain({
      id: opts.chainId,
      name: this.isLocal ? 'Portex Local' : opts.chainId === 1952 ? 'X Layer Testnet' : `Chain ${opts.chainId}`,
      nativeCurrency: this.isLocal
        ? { name: 'Ether', symbol: 'ETH', decimals: 18 }
        : { name: 'OKB', symbol: 'OKB', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    });
    const pollingInterval = opts.pollingIntervalMs ?? (this.isLocal ? 100 : 1000);
    this.client = createPublicClient({
      chain: this.chain,
      transport: http(opts.rpcUrl, { timeout: 30_000, retryCount: 0 }),
      pollingInterval,
    }) as PublicClient;
  }

  /** Retry transient RPC failures with exponential backoff (1s, 2s, 4s, ... capped at 30s). */
  async retry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!isTransient(error) || attempt >= attempts) throw error;
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() / 2);
        this.stats.retried++;
        log.warn('rpc-retry', { label, attempt, waitMs: Math.round(wait), error: errorText(error) });
        await sleep(wait);
      }
    }
  }

  read<T = any>(address: Address | string, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.retry(
      `read ${functionName}`,
      () =>
        this.client.readContract({
          address: address as Address,
          abi: withErrors(abi),
          functionName,
          args,
        } as never) as Promise<T>,
    );
  }

  /** eth_call a non-view function (e.g. a quoter) and return its result. */
  async simulate<T = any>(account: Address, call: Call): Promise<T> {
    const { result } = await this.retry(`simulate ${call.functionName}`, () =>
      this.client.simulateContract({
        address: call.address as Address,
        abi: withErrors(call.abi),
        functionName: call.functionName,
        args: call.args ?? [],
        account,
        value: call.value,
      } as never),
    );
    return result as T;
  }

  async head(): Promise<{ number: bigint; timestamp: number }> {
    const block = await this.retry('head', () => this.client.getBlock({ blockTag: 'latest' }));
    return { number: block.number, timestamp: Number(block.timestamp) };
  }

  async balance(address: Address | string): Promise<bigint> {
    return this.retry('balance', () => this.client.getBalance({ address: address as Address }));
  }

  /** Network gas price (cached for 10s). */
  async networkGasPrice(): Promise<bigint> {
    if (this.gasCache && Date.now() - this.gasCache.at < 10_000) return this.gasCache.price;
    const price = await this.retry('gasPrice', () => this.client.getGasPrice());
    this.gasCache = { at: Date.now(), price };
    return price;
  }

  /** The legacy gas price to use: network price times the multiplier, never above the cap. Throws above the cap. */
  async gasPrice(): Promise<bigint> {
    const net = await this.networkGasPrice();
    const cap = parseGwei(String(this.opts.maxGasPriceGwei));
    if (net > cap) throw new GasCapError(net, cap);
    const bumped = (net * BigInt(Math.round(this.opts.gasPriceMultiplier * 100))) / 100n;
    return bumped > cap ? cap : bumped;
  }

  private wallet(account: PrivateKeyAccount): WalletClient {
    let wallet = this.wallets.get(account.address);
    if (!wallet) {
      wallet = createWalletClient({
        account,
        chain: this.chain,
        transport: http(this.opts.rpcUrl, { timeout: 30_000, retryCount: 0 }),
      });
      this.wallets.set(account.address, wallet);
    }
    return wallet;
  }

  /** Serialize everything one wallet sends, so nonces never race. */
  private async locked<T>(address: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(address) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(address, chained);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(address) === chained) this.locks.delete(address);
    }
  }

  private async nonce(address: Address): Promise<number> {
    const cached = this.nonces.get(address);
    if (cached !== undefined) return cached;
    const fresh = await this.retry('nonce', () => this.client.getTransactionCount({ address, blockTag: 'pending' }));
    this.nonces.set(address, fresh);
    return fresh;
  }

  private async confirm(hash: `0x${string}`, label: string): Promise<TransactionReceipt> {
    const timeout = this.opts.receiptTimeoutMs ?? (this.isLocal ? 30_000 : 120_000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.client.waitForTransactionReceipt({ hash, timeout });
      } catch (error) {
        if (attempt === 3) throw new TxPendingError(hash, label);
        log.warn('receipt-wait', { label, hash, attempt, error: errorText(error) });
      }
    }
    throw new TxPendingError(hash, label);
  }

  private account(address: string, fields: Record<string, unknown>) {
    return { from: address, ...fields };
  }

  /**
   * Simulate, sign with an explicit nonce and capped gas price, broadcast, and wait for the receipt.
   * Returns null in dry-run mode. A reverted simulation throws immediately (no broadcast); transient
   * failures before broadcast are retried; a broadcast transaction is never re-sent.
   */
  async send(
    account: PrivateKeyAccount,
    call: Call,
    label: string,
    fields: Record<string, unknown> = {},
  ): Promise<TransactionReceipt | null> {
    if (this.opts.dryRun) {
      log.info('plan-tx', { label, ...this.account(account.address, fields), to: call.address, fn: call.functionName });
      return null;
    }
    return this.locked(account.address, async () => {
      const abi = withErrors(call.abi);
      for (let attempt = 1; ; attempt++) {
        let hash: `0x${string}` | undefined;
        try {
          const gasPrice = await this.gasPrice();
          const { request } = await this.retry(`simulate ${call.functionName}`, () =>
            this.client.simulateContract({
              address: call.address as Address,
              abi,
              functionName: call.functionName,
              args: call.args ?? [],
              account,
              value: call.value,
            } as never),
          );
          // Gas use can depend on block time (lazy decay), so estimates get a 30% buffer.
          const estimate = await this.retry(`estimate ${call.functionName}`, () =>
            this.client.estimateContractGas({
              address: call.address as Address,
              abi,
              functionName: call.functionName,
              args: call.args ?? [],
              account,
              value: call.value,
            } as never),
          );
          const nonce = await this.nonce(account.address);
          hash = await this.wallet(account).writeContract({
            ...(request as object),
            account,
            chain: this.chain,
            nonce,
            gasPrice,
            gas: (estimate * 130n) / 100n,
          } as never);
          this.nonces.set(account.address, nonce + 1);
          this.stats.sent++;
        } catch (error) {
          if (isNonceError(error) && attempt < 4) {
            this.nonces.delete(account.address);
            continue;
          }
          if (isTransient(error) && attempt < 5) {
            this.stats.retried++;
            await sleep(Math.min(20_000, 1000 * 2 ** attempt));
            continue;
          }
          // Read-after-write lag on load-balanced RPCs: a node may not see a just-confirmed approve or mint yet.
          if (hash === undefined && attempt === 1 && STALE_READ_REVERTS.includes(revertName(error) ?? '')) {
            this.stats.retried++;
            await sleep(2000);
            continue;
          }
          // Any failure after signing may have consumed the nonce; resync on the next send.
          this.nonces.delete(account.address);
          throw error;
        }
        const receipt = await this.confirm(hash, label);
        this.stats.gasUsed += receipt.gasUsed;
        this.stats.fees += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
        if (receipt.status !== 'success') {
          this.stats.reverted++;
          throw new TxRevertedError(hash, label);
        }
        log.info('tx', {
          label,
          ...this.account(account.address, fields),
          hash,
          gas: receipt.gasUsed,
          block: receipt.blockNumber,
        });
        await this.caughtUp(receipt.blockNumber);
        return receipt;
      }
    });
  }

  /** Native transfer (gas top-ups). */
  async sendValue(
    account: PrivateKeyAccount,
    to: Address,
    value: bigint,
    label: string,
    fields: Record<string, unknown> = {},
  ): Promise<TransactionReceipt | null> {
    if (this.opts.dryRun) {
      log.info('plan-tx', { label, from: account.address, to, value, ...fields });
      return null;
    }
    return this.locked(account.address, async () => {
      for (let attempt = 1; ; attempt++) {
        let hash: `0x${string}`;
        try {
          const gasPrice = await this.gasPrice();
          const nonce = await this.nonce(account.address);
          hash = await this.wallet(account).sendTransaction({
            account,
            chain: this.chain,
            to,
            value,
            nonce,
            gasPrice,
            gas: 21_000n,
          } as never);
          this.nonces.set(account.address, nonce + 1);
          this.stats.sent++;
        } catch (error) {
          if (isNonceError(error) && attempt < 4) {
            this.nonces.delete(account.address);
            continue;
          }
          if (isTransient(error) && attempt < 5) {
            await sleep(Math.min(20_000, 1000 * 2 ** attempt));
            continue;
          }
          this.nonces.delete(account.address);
          throw error;
        }
        const receipt = await this.confirm(hash, label);
        this.stats.fees += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
        log.info('tx', { label, from: account.address, to, value, hash, ...fields });
        return receipt;
      }
    });
  }

  /**
   * After a confirmed receipt, wait (briefly) until the RPC reports that block, so the next dependent simulation
   * does not land on a node that is still behind. Never throws.
   */
  private async caughtUp(block: bigint): Promise<void> {
    if (this.isLocal) return;
    for (let i = 0; i < 12; i++) {
      try {
        if ((await this.client.getBlockNumber({ cacheTime: 0 })) >= block) return;
      } catch {
        /* transient; keep polling */
      }
      await sleep(250);
    }
  }

  /** Local anvil only: advance chain time and mine a block. */
  async warp(seconds: number): Promise<void> {
    if (!this.isLocal) throw new Error('warp is available on the local chain (31337) only');
    await this.client.request({ method: 'evm_increaseTime', params: [Math.max(1, Math.floor(seconds))] } as never);
    await this.client.request({ method: 'evm_mine', params: [] } as never);
  }

  /** Mine one block without advancing time much (local only). */
  async mine(): Promise<void> {
    if (!this.isLocal) return;
    await this.client.request({ method: 'evm_mine', params: [] } as never);
  }
}
