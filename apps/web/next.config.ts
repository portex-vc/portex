import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { join } from "node:path";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  distDir: process.env.PORTEX_BUILD_DIR ?? ".next",
  // Dev server opened from another machine (e.g. a VM's LAN address): allow its HMR/_next requests.
  allowedDevOrigins: process.env.PORTEX_DEV_ORIGINS?.split(",").filter(Boolean),
  webpack: (config, { webpack }) => {
    // Dev tooling for the local chain (burner wallet, test mnemonic, node time travel) exists only in local builds.
    // Any other chain gets stubs, so none of it can run or be bundled on testnet or mainnet.
    if (process.env.NEXT_PUBLIC_CHAIN_ID !== "31337") {
      const lib = join(__dirname, "src/lib");
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /(^|[\\/])local-(connector|dev)$/,
          (resource: { request: string; context?: string }) => {
            const ours =
              resource.request.startsWith("@/lib/") || (resource.request.startsWith("./") && resource.context === lib);
            if (ours) resource.request = join(lib, `${resource.request.split("/").pop()}.stub.ts`);
          },
        ),
      );
    }
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
