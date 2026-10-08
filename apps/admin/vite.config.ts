import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Served by the API at /admin/ (apps/api/Dockerfile copies dist there), so API calls are same-origin.
// In development the Vite server forwards /v1 to a local API: API_URL=http://localhost:3000.
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { proxy: { "/v1": process.env.API_URL ?? "http://localhost:3000" } },
});
