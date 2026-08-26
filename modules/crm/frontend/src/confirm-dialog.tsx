import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ConfirmRequest = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

type ConfirmState = ConfirmRequest & { resolve: (ok: boolean) => void };

let openConfirm: ((request: ConfirmRequest) => Promise<boolean>) | null = null;

export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  if (!openConfirm) return Promise.resolve(false);
  return openConfirm(request);
}

export function ConfirmHost({
  titleLabel,
  okLabel,
  cancelLabel,
}: {
  titleLabel: string;
  okLabel: string;
  cancelLabel: string;
}) {
  const [state, setState] = useState<ConfirmState | null>(null);
  useEffect(() => {
    openConfirm = (request) => new Promise((resolve) => {
      setState((current) => {
        current?.resolve(false);
        return { ...request, resolve };
      });
    });
    return () => {
      openConfirm = null;
    };
  }, []);
  if (!state) return null;
  const close = (ok: boolean) => {
    state.resolve(ok);
    setState(null);
  };
  return (
    <ConsoleModal
      title={state.title || titleLabel}
      labelledBy="crm-public-confirm-title"
      onClose={() => close(false)}
      actions={
        <>
          <button type="button" className={state.danger ? "danger" : "primary"} onClick={() => close(true)}>
            {state.confirmText || okLabel}
          </button>
          <button type="button" data-console-modal-cancel="true" onClick={() => close(false)}>
            {state.cancelText || cancelLabel}
          </button>
        </>
      }
    >
      <p>{state.message}</p>
    </ConsoleModal>
  );
}

export function ConsoleModal({
  title,
  labelledBy,
  onClose,
  children,
  actions,
  wide = false,
  dialogRef,
}: {
  title: ReactNode;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  dialogRef?: MutableRefObject<HTMLElement | null>;
}) {
  const localRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = localRef.current;
    node?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = original;
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div className="console-modal" role="presentation">
      <div className="console-modal-backdrop" onMouseDown={onClose} />
      <section
        ref={(node) => {
          localRef.current = node;
          if (dialogRef) dialogRef.current = node;
        }}
        className={`console-modal-dialog${wide ? " console-modal-dialog--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <div className="console-modal-head">
          <strong id={labelledBy}>{title}</strong>
          <button type="button" className="console-modal-close" onClick={onClose} aria-label="关闭">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12" /><path d="m18 6-12 12" /></svg>
          </button>
        </div>
        <div className="console-modal-content">{children}</div>
        {actions ? <div className="console-modal-actions">{actions}</div> : null}
      </section>
    </div>,
    document.body,
  );
}
