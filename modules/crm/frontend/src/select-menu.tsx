import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export function SelectMenu({
  value,
  onChange,
  options,
  placeholder = "请选择",
  searchPlaceholder = "筛选",
  emptyLabel = "没有匹配项",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, maxHeight: 240 });
  const selected = options.find((item) => item.value === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((item) => `${item.label} ${item.hint || ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  const syncBox = () => {
    const node = trigger.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const maxH = Math.min(280, window.innerHeight * 0.46);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const openUp = spaceBelow < 132 && rect.top > spaceBelow;
    const maxHeight = Math.max(120, openUp ? Math.min(maxH, rect.top - 8) : Math.min(maxH, spaceBelow));
    setBox({
      top: openUp ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
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
    <div className={`crm-select${open ? " is-open" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="crm-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.label || placeholder}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selected ? "" : "is-placeholder"}>{selected?.label || placeholder}</span>
        <Icon name="arrow" className="crm-select-caret" />
      </button>
      {open ? createPortal(
        <div
          ref={panel}
          className="crm-select-panel"
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
                className={item.value === value ? "is-active" : ""}
                disabled={item.disabled}
                key={item.value || "__empty"}
                title={item.label}
                onClick={() => {
                  if (item.disabled) return;
                  onChange(item.value);
                  setOpen(false);
                }}
              >
                <strong>{item.label}</strong>
                {item.hint ? <small>{item.hint}</small> : null}
              </button>
            )) : <p className="crm-select-empty">{emptyLabel}</p>}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
