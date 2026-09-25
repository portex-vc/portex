import { AdminConsole } from "@/components/admin/admin-console";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Role-gated console; every section checks the connected account's on-chain or API role. */
export default function AdminPage() {
  return <AdminConsole />;
}
