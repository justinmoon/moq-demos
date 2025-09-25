import { defineConfig } from "vite";

export default defineConfig(() => ({
  base: process.env.APP_BASE ?? "/",
  server: {
    port: 5175,
  },
}));
