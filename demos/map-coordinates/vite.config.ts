import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  server: {
    port: 5175,
    fs: {
      allow: [rootDir],
    },
  } 
});
