/**
 * What the page takes from Telegram's own script (telegram-web-app.js), when it is opened inside Telegram: the app is made to fill
 * the screen, haptic feedback, and the language. Nothing here is needed to sign in: that is the person's email and password, so the
 * page works in an ordinary browser too.
 */
interface WebApp {
  initDataUnsafe?: { user?: { language_code?: string } };
  ready(): void;
  expand(): void;
  HapticFeedback?: { notificationOccurred(type: "success" | "error" | "warning"): void };
}

const webApp = (): WebApp | undefined => (window as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;

export function startTelegram(): void {
  const app = webApp();
  app?.ready();
  app?.expand();
}

export const telegramLanguage = () => webApp()?.initDataUnsafe?.user?.language_code ?? null;
export function haptic(type: "success" | "error" | "warning"): void {
  webApp()?.HapticFeedback?.notificationOccurred(type);
}
