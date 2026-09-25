import { createRequire } from "node:module";
// Resolve @next/env from Next's own location: with isolated workspace installs it is Next's dependency, not ours,
// and patching the exact instance Next loads is what keeps dotenv files unread.
const fromNext = createRequire(createRequire(import.meta.url).resolve("next/package.json"));
const id = fromNext.resolve("@next/env");
const original = fromNext(id);
const cached = fromNext.cache[id];
if (!cached) throw new Error("Next environment loader was not cached");
cached.exports = new Proxy(original, {
  get(target, key) {
    if (key === "loadEnvConfig") return () => ({ combinedEnv: process.env, parsedEnv: {}, loadedEnvFiles: [] });
    return Reflect.get(target, key);
  },
});
