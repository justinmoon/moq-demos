import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const moqDir = path.resolve(rootDir, "../../../moq");

export default defineConfig({
  server: {
    port: 5175,
    fs: {
      allow: [rootDir, moqDir],
    },
  },
  resolve: {
    alias: {
      "@kixelated/moq": path.resolve(rootDir, "../../../moq/js/moq/src/index.ts"),
      "@kixelated/moq/": path.resolve(rootDir, "../../../moq/js/moq/src") + "/",
      "@kixelated/signals": path.resolve(rootDir, "../../../moq/js/signals/src/index.ts"),
      "@kixelated/signals/": path.resolve(rootDir, "../../../moq/js/signals/src") + "/",
    },
  },
});
