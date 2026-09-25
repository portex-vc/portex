import { notFound } from "next/navigation";
import { isLocalChain } from "@/lib/env";
import DevPage from "./dev-page";

export default function Page() {
  if (!isLocalChain) notFound();
  return <DevPage />;
}
