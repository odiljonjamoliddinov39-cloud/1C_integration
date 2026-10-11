/** The control system. Vercel forwards /api/* there (vercel.json), so the browser stays same-origin. */
export const API_BASE = "/api";

/** The installer, published on the server by the "Desktop app (Windows .exe)" workflow. */
export const DOWNLOAD_URL =
  import.meta.env.PUBLIC_DOWNLOAD_URL ??
  "https://104-248-18-86.sslip.io/download/AI-Accounting-Assistant-Setup.exe";
