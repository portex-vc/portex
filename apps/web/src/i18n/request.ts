import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "./config";

/**
 * Locale without URL routing: read from a cookie so every route keeps its address
 * (the e2e flows and shared links stay stable) and the user's choice persists.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(raw) ? raw : defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: "UTC",
  };
});
