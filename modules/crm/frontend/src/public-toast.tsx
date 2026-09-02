import { useCallback, useEffect, useRef, useState } from "react";

export type PublicToastStatus = "queued" | "running" | "progress" | "success" | "failed" | "error" | "warning" | "warn" | "cancelled" | "need_manual";

type PublicToastOptions = {
  status?: PublicToastStatus;
  onClick?: () => void;
};

type PublicToastDetail = PublicToastOptions & {
  message: string;
};

type ToastRecord = PublicToastDetail & {
  id: number;
  leaving: boolean;
};

const PUBLIC_TOAST_EVENT = "vecto:public-toast";
const PUBLIC_TOAST_DURATION = 5_000;

export function publicToast(message: string, options: PublicToastOptions = {}) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) return;
  window.dispatchEvent(new CustomEvent<PublicToastDetail>(PUBLIC_TOAST_EVENT, {
    detail: { message: cleanMessage, status: options.status || "success", onClick: options.onClick },
  }));
}

function StatusIcon({ status }: { status: PublicToastStatus }) {
  if (status === "running" || status === "progress") return <svg className="toast-status-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" /></svg>;
  if (status === "queued") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5" /><path d="M12 7.5V12l3 2" /></svg>;
  if (status === "failed" || status === "error") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 8.5 7 7m0-7-7 7" /></svg>;
  if (status === "warning" || status === "warn" || status === "need_manual") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.5v5.25" /><path d="M12 16.5h.01" /></svg>;
  if (status === "cancelled") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12h8" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7.5 12.25 3 3 6-6.5" /></svg>;
}

export function PublicToastHost() {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const sequence = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const expiry = timers.current.get(id);
    if (expiry) window.clearTimeout(expiry);
    timers.current.delete(id);
    setToasts((current) => current.map((toast) => toast.id === id ? { ...toast, leaving: true } : toast));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 180);
  }, []);

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<PublicToastDetail>).detail;
      if (!detail?.message) return;
      const id = ++sequence.current;
      const status = detail.status || "success";
      setToasts((current) => [...current.slice(-2), { ...detail, id, status, leaving: false }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), PUBLIC_TOAST_DURATION));
    };
    window.addEventListener(PUBLIC_TOAST_EVENT, onToast);
    const activeTimers = timers.current;
    return () => {
      window.removeEventListener(PUBLIC_TOAST_EVENT, onToast);
      activeTimers.forEach((timer) => window.clearTimeout(timer));
      activeTimers.clear();
    };
  }, [dismiss]);

  return <div id="toastHost" className="toast-host" aria-live="polite" aria-atomic="false">
    {toasts.map((toast) => <div
      key={toast.id}
      className={`toast-message is-status-${toast.status}${toast.leaving ? " is-leaving" : ""}${toast.onClick ? " is-clickable" : ""}`}
      role={toast.onClick ? "button" : toast.status === "failed" || toast.status === "error" ? "alert" : "status"}
      tabIndex={toast.onClick ? 0 : undefined}
      onClick={() => toast.onClick?.()}
      onKeyDown={(event) => { if (toast.onClick && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toast.onClick(); } }}
    >
      <span className="toast-message-status-icon" aria-hidden="true"><StatusIcon status={toast.status || "success"} /></span>
      <span className="toast-message-body"><span className="toast-message-text">{toast.message}</span></span>
      <button type="button" className="toast-message-close" aria-label="关闭提示" onClick={(event) => { event.stopPropagation(); dismiss(toast.id); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7.5 7.5 9 9m0-9-9 9" /></svg>
      </button>
    </div>)}
  </div>;
}
