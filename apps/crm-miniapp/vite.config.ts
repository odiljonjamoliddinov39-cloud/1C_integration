import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the API at /crm-app/ (apps/api/Dockerfile copies dist there), so API calls are same-origin.
// In development the Vite server forwards /v1 to a local API: API_URL=http://localhost:3000.
export default defineConfig({
  base: "/crm-app/",
  plugins: [react()],
  server: { proxy: { "/v1": process.env.API_URL ?? "http://localhost:3000" } },
});
