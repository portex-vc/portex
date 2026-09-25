"use client";

import { ErrorState } from "@/components/states";
import { useEffect } from "react";

/** Route-level error boundary: a clear message and a retry instead of a blank page. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.warn(error);
  }, [error]);
  return (
    <div className="pt-6 lg:pt-12">
      <ErrorState error={error} retry={reset} />
    </div>
  );
}
