/**
 * Click's payment window over the page (its checkout.js, SHOP API's "pay by card without leaving the page"). The window is
 * Click's own: the card number and the SMS code are typed there, so nothing of the card is in our page or on our server.
 * It reports only a status: < 0 error, 0 created, 1 in process, 2 paid.
 */
export interface ClickWindowValues {
  serviceId: string;
  merchantId: string;
  merchantUserId?: string | undefined;
  amount: string;
  transactionParam: string;
}

declare global {
  interface Window {
    createPaymentRequest?: (
      params: Record<string, string | number>,
      done: (result: { status: number }) => void,
    ) => void;
  }
}

const SCRIPT = "https://my.click.uz/pay/checkout.js";
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.createPaymentRequest) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = SCRIPT;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => {
      loading = null;
      reject(new Error("Click's payment window could not be loaded"));
    };
    document.head.append(tag);
  });
  return loading;
}

/** Opens the window; resolves with the status Click reports when it is closed. Rejects when the window cannot be opened. */
export async function openClickWindow(values: ClickWindowValues): Promise<number> {
  await loadScript();
  const open = window.createPaymentRequest;
  if (!open) throw new Error("Click's payment window is not available");
  return new Promise<number>((resolve) => {
    open(
      {
        service_id: values.serviceId,
        merchant_id: values.merchantId,
        ...(values.merchantUserId ? { merchant_user_id: values.merchantUserId } : {}),
        amount: values.amount,
        transaction_param: values.transactionParam,
      },
      (result) => resolve(result.status),
    );
  });
}
