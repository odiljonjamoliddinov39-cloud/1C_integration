import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 900 },
  // Codespaces forwards ports through *.app.github.dev.
  preview: { allowedHosts: [".app.github.dev"] },
  server: {
    allowedHosts: [".app.github.dev"],
    proxy: {
      "/api": "http://localhost:8000",
      "/mcp": "http://localhost:8000",
    },
  },
});
