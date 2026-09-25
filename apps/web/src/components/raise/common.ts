import { queryKeys } from "@/lib/hooks";
export function raiseInvalidations(address: string, user?: string): (readonly unknown[])[] {
  return [
    queryKeys.raise(address),
    ["raises"],
    queryKeys.activity(address),
    queryKeys.trades(address),
    queryKeys.priceHistory(address),
    queryKeys.proposals(address),
    ["wallet"],
    ["inbox"],
    ["rollover-sources"],
    ...(user ? [queryKeys.position(address, user)] : []),
  ];
}
