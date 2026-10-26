import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve("src/client"),
  publicDir: path.resolve("public"),
  build: {
    outDir: path.resolve("dist/client"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "^/api/": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
    fs: {
      allow: [path.resolve(".")],
    },
  },
});
