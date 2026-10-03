import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

// Workspace packages ship TypeScript source, so they are bundled; winax (native COM bridge) stays external.
const bundled = ["@platform/shared", "@platform/onec-client", "zod"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
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
