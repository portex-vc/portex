"use client";

import Router from "@/generated/abi/PortexSwapRouterV31.json";
import { useQuery } from "@tanstack/react-query";
import type { Abi } from "viem";
import { ApiError, type BuilderProfile } from "./api";
import { env } from "./env";
import type { Candle, Interval } from "./market-math";

export * from "./market-math";

/** Secondary market (Stage 3 · Open market): API shapes, queries and the pure swap arithmetic. */

export const swapRouterAbi = Router as Abi;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface MarketRow {
  address: string;
  name: string;
  symbol: string;
  token: string;
  profile: BuilderProfile;
  poolId: string | null;
  tokenIsCurrency0: boolean;
  fee: number;
  tickSpacing: number;
  /** USDG per whole token, decimal string. */
  price: string;
  listingPrice: string;
  change24hBps: number;
  /** USDG, decimal strings. */
  volume24h: string;
  liquidity: string;
  reserves: { quote: string; token: string };
  totalSupply: string;
  fdv: string;
  tradeCount: number;
  listedAt: number | null;
  lastTradeAt: number | null;
  /** 48 samples of the price over the last 30 days (or since listing). */
  spark: string[];
}
interface Venue {
  router: string | null;
  poolManager: string | null;
  quote: string | null;
  chainTime: number;
  blockNumber: number;
}
export interface MarketsResponse extends Venue {
  markets: MarketRow[];
}
export interface MarketResponse extends Venue {
  market: MarketRow;
}
export interface CandlesResponse {
  raise: string;
  interval: Interval;
  seconds: number;
  listing: { time: number; price: string; txHash: string; poolId: string | null } | null;
  candles: Candle[];
}
export interface PoolTrade {
  time: number;
  side: "buy" | "sell";
  /** Average fill (fee included) and the pool price after the trade, USDG per token. */
  price: string;
  spotPrice: string;
  amountQuote: string;
  amountToken: string;
  amountQuoteRaw: string;
  amountTokenRaw: string;
  trader: string;
  sender: string;
  recipient: string | null;
  viaRouter: boolean;
  txHash: string;
  blockNumber: number;
  logIndex: number;
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`);
  } catch {
    throw new ApiError("unreachable", `Backend unreachable at ${env.apiUrl}`, 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(body?.error?.code ?? "http_error", body?.error?.message ?? `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export const marketApi = {
  markets: () => get<MarketsResponse>("/v2/markets"),
  market: (address: string) => get<MarketResponse>(`/v2/markets/${address}`),
  candles: (address: string, interval: Interval) =>
    get<CandlesResponse>(`/v2/raises/${address}/candles?interval=${interval}`),
  trades: (address: string, limit = 60) => get<PoolTrade[]>(`/v2/raises/${address}/pool-trades?limit=${limit}`),
};

export const marketKeys = {
  all: ["markets"] as const,
  market: (address: string) => ["markets", "detail", address.toLowerCase()] as const,
  candles: (address: string, interval: Interval) => ["markets", "candles", address.toLowerCase(), interval] as const,
  trades: (address: string) => ["markets", "trades", address.toLowerCase()] as const,
};

export function useMarkets() {
  return useQuery({ queryKey: marketKeys.all, queryFn: marketApi.markets, refetchInterval: 15_000, retry: 1 });
}
export function useMarket(address: string) {
  return useQuery({
    queryKey: marketKeys.market(address),
    queryFn: () => marketApi.market(address),
    refetchInterval: 10_000,
    retry: 1,
  });
}
export function useCandles(address: string, interval: Interval) {
  return useQuery({
    queryKey: marketKeys.candles(address, interval),
    queryFn: () => marketApi.candles(address, interval),
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });
}
export function usePoolTrades(address: string) {
  return useQuery({
    queryKey: marketKeys.trades(address),
    queryFn: () => marketApi.trades(address),
    refetchInterval: 10_000,
    retry: 1,
  });
}

/** A deployed router, or null when trading is not enabled on this network. */
export function liveRouter(router: string | null | undefined): `0x${string}` | null {
  return router && /^0x[0-9a-fA-F]{40}$/.test(router) && router.toLowerCase() !== ZERO_ADDRESS
    ? (router as `0x${string}`)
    : null;
}
