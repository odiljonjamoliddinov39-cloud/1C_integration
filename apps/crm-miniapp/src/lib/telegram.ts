/** The few things the page takes from Telegram's own script (telegram-web-app.js). */
interface WebApp {
  initData: string;
  initDataUnsafe?: { user?: { language_code?: string } };
  ready(): void;
  expand(): void;
  HapticFeedback?: { notificationOccurred(type: "success" | "error" | "warning"): void };
}

export const webApp = (): WebApp | undefined =>
  (window as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;

export function startTelegram(): void {
  const app = webApp();
  app?.ready();
  app?.expand();
}

export const initData = (): string => webApp()?.initData ?? "";
export const insideTelegram = () => Boolean(webApp()?.initData);
export const telegramLanguage = () => webApp()?.initDataUnsafe?.user?.language_code ?? null;
export function haptic(type: "success" | "error" | "warning"): void {
  webApp()?.HapticFeedback?.notificationOccurred(type);
}
