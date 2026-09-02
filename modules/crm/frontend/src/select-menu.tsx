import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  previewImageUrl?: string;
  previewImageAlt?: string;
  previewText?: string;
  previewCard?: boolean;
  plain?: boolean;
  disabled?: boolean;
};

export function FilterMenu({ triggerLabel, active = false, children }: { triggerLabel: string; active?: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, maxHeight: 320 });

  const syncBox = () => {
    const node = trigger.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    const maxH = Math.min(420, window.innerHeight * 0.62);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const openUp = spaceBelow < 180 && rect.top > spaceBelow;
    const maxHeight = Math.max(160, openUp ? Math.min(maxH, rect.top - 8) : Math.min(maxH, spaceBelow));
    setBox({
      top: openUp ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      width,
      maxHeight,
    });
  };

  useEffect(() => {
    if (!open) return;
    syncBox();
    window.requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("input, button")?.focus());
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onMove = () => syncBox();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  return <div className={`crm-filter-menu${open ? " is-open" : ""}`} ref={root}>
    <button
      ref={trigger}
      className={`unified-action-icon-button crm-filter-menu-trigger${active ? " is-active" : ""}`}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={triggerLabel}
      title={triggerLabel}
      onClick={() => setOpen((current) => !current)}
    ><Icon name="filter" /></button>
    {open ? createPortal(<div ref={panel} className="crm-filter-menu-panel" role="dialog" aria-label={triggerLabel} style={{ top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}>{children}</div>, document.body) : null}
  </div>;
}

export function SelectMenu({
  value,
  onChange,
  options,
  placeholder = "请选择",
  searchPlaceholder = "筛选",
  emptyLabel = "没有匹配项",
  disabled = false,
  triggerIcon,
  triggerLabel,
  active = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  triggerIcon?: "filter" | "sort";
  triggerLabel?: string;
  active?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, maxHeight: 240 });
  const selected = options.find((item) => item.value === value);
  const hasPreviewOptions = options.some((item) => item.previewCard || item.previewImageUrl !== undefined || item.previewText !== undefined);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((item) => `${item.label} ${item.hint || ""} ${item.previewText || ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  const syncBox = () => {
    const node = trigger.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const maxH = Math.min(hasPreviewOptions ? 340 : 280, window.innerHeight * 0.46);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const openUp = spaceBelow < 132 && rect.top > spaceBelow;
    const maxHeight = Math.max(120, openUp ? Math.min(maxH, rect.top - 8) : Math.min(maxH, spaceBelow));
    const menuWidth = triggerIcon
      ? Math.min(240, window.innerWidth - 16)
      : Math.min(rect.width, window.innerWidth - 16);
    const left = triggerIcon
      ? Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8))
      : Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    setBox({
      top: openUp ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
      left,
      width: menuWidth,
      maxHeight,
    });
  };

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    syncBox();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onMove = () => syncBox();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  return (
    <div className={`crm-select${triggerIcon ? " crm-select--icon" : ""}${open ? " is-open" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`crm-select-trigger${triggerIcon ? " crm-select-trigger--icon" : ""}${active ? " is-active" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerIcon ? triggerLabel || selected?.label || placeholder : undefined}
        title={selected?.label || placeholder}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerIcon
          ? <Icon name={triggerIcon} />
          : <><span className={selected ? "" : "is-placeholder"}>{selected?.label || placeholder}</span><Icon name="arrow" className="crm-select-caret" /></>}
      </button>
      {open ? createPortal(
        <div
          ref={panel}
          className={`crm-select-panel${hasPreviewOptions ? " crm-select-panel--preview" : ""}`}
          role="listbox"
          style={{ top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}
        >
          {options.length > 8 ? <input className="crm-select-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} autoFocus /> : null}
          <div className="crm-select-list">
            {filtered.length ? filtered.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={item.value === value}
                className={`${item.value === value ? "is-active" : ""}${item.plain ? " crm-select-option--plain" : ""}`}
                disabled={item.disabled}
                key={item.value || "__empty"}
                title={item.label}
                onClick={() => {
                  if (item.disabled) return;
                  onChange(item.value);
                  setOpen(false);
                }}
              >
                {hasPreviewOptions && !item.plain ? <>
                  <span className="crm-select-option-preview" aria-hidden="true">
                    {item.previewImageUrl
                      ? <img src={item.previewImageUrl} alt="" loading="lazy" />
                      : <Icon name="templates" />}
                  </span>
                  <span className="crm-select-option-copy">
                    <strong>{item.label}</strong>
                    {item.hint ? <small>{item.hint}</small> : null}
                    {item.previewText ? <span>{item.previewText}</span> : null}
                  </span>
                </> : <>
                  <strong>{item.label}</strong>
                  {item.hint ? <small>{item.hint}</small> : null}
                </>}
              </button>
            )) : <p className="crm-select-empty">{emptyLabel}</p>}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
