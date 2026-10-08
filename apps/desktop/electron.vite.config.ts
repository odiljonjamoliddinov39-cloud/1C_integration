import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

// Workspace packages ship TypeScript source, so they are bundled; winax (native COM bridge) stays external.
const bundled = ["@platform/shared", "@platform/onec-client", "zod", "jose"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    // The control system this build talks to, and the key that signs its licenses.
    define: {
      __DEFAULT_SERVER_URL__: JSON.stringify(process.env.PLATFORM_API_URL ?? "http://localhost:3000"),
      __LICENSE_PUBLIC_KEY__: JSON.stringify(
        (process.env.PLATFORM_LICENSE_PUBLIC_KEY ?? "").replaceAll("\\n", "\n"),
      ),
    },
    build: { rollupOptions: { external: ["winax"] } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    // The window is sandboxed, and sandboxed preload scripts must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: "src/renderer",
    resolve: { alias: { "@": resolve(__dirname, "src/renderer/src") } },
    plugins: [react(), tailwindcss()],
  },
});
