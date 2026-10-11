import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "path";

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    strictPort: true,
    allowedHosts: ["iuvma2p8v3g3fbo0uf3jb.preview.studio.arc.io"],
  },
});
