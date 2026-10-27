import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the API at /app/ (apps/api/Dockerfile copies dist there), so API calls are same-origin.
// In development the Vite server forwards /remote to a local API: API_URL=http://localhost:3000.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: { proxy: { "/remote": process.env.API_URL ?? "http://localhost:3000" } },
});
