// Use the exact backend handoff seeder with isolated manifests and output paths.
const source = new URL("../../../tools/src/seed-v31.ts", import.meta.url).href;
const { seedV31 } = await import(source);
await seedV31(process.env.RPC_URL, process.env.API_URL);
export {};
