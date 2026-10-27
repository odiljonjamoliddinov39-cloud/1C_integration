/** The few things the page takes from Telegram's own script (telegram-web-app.js). */
interface WebApp {
  initData: string;
  initDataUnsafe?: { user?: { language_code?: string } };
  ready(): void;
  expand(): void;
  colorScheme?: "light" | "dark";
  HapticFeedback?: { notificationOccurred(type: "success" | "error" | "warning"): void };
  openLink?(url: string): void;
}

export const webApp = (): WebApp | undefined =>
  (window as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;

export function startTelegram(): void {
  const app = webApp();
  app?.ready();
  app?.expand();
}

export const insideTelegram = () => Boolean(webApp()?.initData);
export const telegramLanguage = () => webApp()?.initDataUnsafe?.user?.language_code ?? null;
export function haptic(type: "success" | "error" | "warning"): void {
  webApp()?.HapticFeedback?.notificationOccurred(type);
}

/** Saves a file the way the phone allows: the share sheet when it can take files, else a download link. */
export async function deliverFile(blob: Blob, name: string): Promise<void> {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return;
    } catch {
      // Cancelled or refused: fall back to the link below.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
