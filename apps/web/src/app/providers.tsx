"use client";

import { TransactionDrawer } from "@/components/transaction-drawer";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { wagmiConfig } from "@/lib/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={200} skipDelayDuration={400}>
            {children}
            <Toaster />
            <TransactionDrawer />
          </TooltipProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
