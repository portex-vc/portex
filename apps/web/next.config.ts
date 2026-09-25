import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  distDir: process.env.PORTEX_BUILD_DIR ?? ".next",
  // Dev server opened from another machine (e.g. a VM's LAN address): allow its HMR/_next requests.
  allowedDevOrigins: process.env.PORTEX_DEV_ORIGINS?.split(",").filter(Boolean),
  webpack: (config) => {
    // wagmi's connectors barrel statically imports optional wallet SDKs we never use.
    // Stub them out so the bundle only includes the connectors we actually register.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@base-org/account": false,
      "@coinbase/cdp-sdk": false,
      "@x402/core/client": false,
      "@x402/svm/exact/client": false,
      "@x402/evm": false,
      "@gemini-wallet/core": false,
      "@metamask/sdk": false,
      "@safe-global/safe-apps-sdk": false,
      "@safe-global/safe-apps-provider": false,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
      porto: false,
    };
    return config;
  },
};

export default withNextIntl(nextConfig);
