import { Intro } from "@/components/brand/intro";
import { INTRO_SCRIPT } from "@/components/brand/intro-script";
import { Footer } from "@/components/shell/footer";
import { Header } from "@/components/shell/header";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";
import { Providers } from "./providers";
import { LanguagePrompt } from "@/components/shell/language-prompt";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");
  return {
    title: { default: "Portex", template: "%s · Portex" },
    description: t("description"),
    applicationName: "Portex",
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: INTRO_SCRIPT }} />
      </head>
      <body className="flex min-h-screen flex-col font-sans">
        <Intro />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            <Header />
            <main className="container flex-1 pb-24 pt-4">{children}</main>
            <Footer />
            <LanguagePrompt />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
