import type { SVGProps } from "react";
import type { ViewId } from "./types";

type IconName = ViewId | "menu" | "close" | "back" | "arrow" | "warning" | "refresh" | "check" | "external" | "signal" | "trash";

const paths: Record<IconName, React.ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/></>,
  collect: <><circle cx="10" cy="10" r="6"/><path d="m14.5 14.5 5 5M10 7v6M7 10h6"/></>,
  pools: <><path d="M4 7.5 12 3l8 4.5-8 4.5z"/><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5"/></>,
  public: <><path d="M5 5h14v10H9l-4 4z"/><path d="M8 9h8M8 12h5"/></>,
  outreach: <><path d="m3 11 18-8-7 18-3.5-7z"/><path d="M10.5 14 21 3"/></>,
  groups: <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20c.5-4 2.5-6 6-6s5.5 2 6 6M15 15c3.5 0 5.5 1.7 6 5"/></>,
  relationships: <><path d="M8.5 14.5 6 17a3 3 0 0 1-4-4l3.5-3.5a3 3 0 0 1 4 0"/><path d="m15.5 9.5 2.5-2.5a3 3 0 0 1 4 4l-3.5 3.5a3 3 0 0 1-4 0M8 12h8"/></>,
  tasks: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
  analytics: <><rect x="4" y="13" width="4" height="7" rx="1"/><rect x="10" y="8" width="4" height="12" rx="1"/><rect x="16" y="4" width="4" height="16" rx="1"/></>,
  schedules: <><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M8 2v3M16 2v3"/></>,
  templates: <><path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 11h6M9 15h6"/></>,
  destinations: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1.4-1.4"/></>,
  accounts: <><circle cx="12" cy="8" r="4"/><path d="M4 21c.7-5 3.4-7 8-7s7.3 2 8 7"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.5 3h-5l-.3 3.1a8 8 0 0 0-1.8 1l-2.4-1-2 3.4L5.1 11a7 7 0 0 0 0 2L3 14.5l2 3.4 2.4-1a8 8 0 0 0 1.8 1l.3 3.1h5l.3-3.1a8 8 0 0 0 1.8-1l2.4 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1z"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  back: <path d="m15 19-7-7 7-7"/>,
  arrow: <path d="m9 5 7 7-7 7"/>,
  warning: <><path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17h.01"/></>,
  refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>,
  signal: <><path d="M5 18v-3M10 18v-6M15 18V9M20 18V5"/></>,
  trash: <><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6"/><path d="M14 11v6"/></>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" {...props}>{paths[name]}</svg>;
}
