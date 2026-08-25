import { chartColor, mixTone, type MixPart } from "./present";

function ChartHead({ title, hint }: { title: string; hint?: string }) {
  return <div className="crm-chart-head"><h3>{title}</h3>{hint ? <span>{hint}</span> : null}</div>;
}

function ChartPlaceholder({ kind, message }: { kind: "donut" | "line" | "bars"; message: string }) {
  const shape = kind === "donut"
    ? <div className="crm-chart-placeholder-donut" aria-hidden="true"><span>0</span></div>
    : kind === "line"
      ? <svg className="crm-chart-placeholder-line" viewBox="0 0 240 76" aria-hidden="true" focusable="false"><path d="M8 60 L54 44 L96 50 L142 24 L188 38 L232 12" /></svg>
      : <div className="crm-chart-placeholder-bars" aria-hidden="true"><i /><i /><i /><i /><i /></div>;
  return <div className={`crm-chart-placeholder crm-chart-placeholder--${kind}`} role="img" aria-label={message}>{shape}<span>{message}</span></div>;
}

export function DonutChart({ title, hint, parts, totalLabel, empty }: { title: string; hint?: string; parts: MixPart[]; totalLabel: string; empty?: string }) {
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  if (!total) {
    return <article className="crm-chart-panel">
      <ChartHead title={title} hint={hint} />
      <ChartPlaceholder kind="donut" message={empty || totalLabel} />
    </article>;
  }
  let cursor = 0;
  const segments = parts.map((part, index) => {
    const start = cursor;
    cursor += (part.count / total) * 100;
    return `${chartColor(index, mixTone(part.key))} ${start}% ${cursor}%`;
  }).join(", ");
  return <article className="crm-chart-panel">
    <ChartHead title={title} hint={hint} />
    <div className="crm-donut-wrap">
      <div className="crm-donut" style={{ background: `conic-gradient(${segments})` }} role="img" aria-label={title}>
        <div><strong>{new Intl.NumberFormat("zh-Hans").format(total)}</strong><span>{totalLabel}</span></div>
      </div>
      <div className="crm-donut-legend">
        {parts.map((part, index) => <div key={part.key}><i style={{ background: chartColor(index, mixTone(part.key)) }} /><em>{part.label}</em><b>{part.count}</b></div>)}
      </div>
    </div>
  </article>;
}

export function LineChart({
  title, hint, labels, series, empty,
}: {
  title: string;
  hint?: string;
  labels: string[];
  series: Array<{ key: string; label: string; color: string; values: number[] }>;
  empty: string;
}) {
  const width = 720;
  const height = 240;
  const pad = { top: 18, right: 16, bottom: 36, left: 44 };
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const x = (index: number) => pad.left + (labels.length <= 1 ? (width - pad.left - pad.right) / 2 : (index / (labels.length - 1)) * (width - pad.left - pad.right));
  const y = (value: number) => height - pad.bottom - (value / max) * (height - pad.top - pad.bottom);
  const hasData = series.some((item) => item.values.some((value) => value > 0));
  const labelStep = Math.max(1, Math.ceil(labels.length / 6));
  const pathFor = (values: number[]) => values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  return <article className="crm-chart-panel crm-chart-panel-wide">
    <ChartHead title={title} hint={hint} />
    {!hasData ? <ChartPlaceholder kind="line" message={empty} /> : <svg className="crm-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      {[0, 0.5, 1].map((ratio) => {
        const gridY = y(max * ratio);
        return <g key={ratio}>
          <line x1={pad.left} y1={gridY} x2={width - pad.right} y2={gridY} className="crm-chart-grid-line" />
          <text x={pad.left - 8} y={gridY + 4} textAnchor="end">{Math.round(max * ratio)}</text>
        </g>;
      })}
      <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} className="crm-chart-axis" />
      {series.map((item) => <g key={item.key}>
        <path d={pathFor(item.values)} fill="none" stroke={item.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {item.values.map((value, index) => <circle key={`${item.key}-${index}`} cx={x(index)} cy={y(value)} r="3.5" fill={item.color} />)}
      </g>)}
      {labels.map((label, index) => (index % labelStep === 0 || index === labels.length - 1) ? <text key={label} x={x(index)} y={height - 10} textAnchor="middle">{label.slice(5)}</text> : null)}
    </svg>}
    <div className="crm-line-legend">{series.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div>
  </article>;
}

export function BarChart({ title, hint, parts, empty }: { title: string; hint?: string; parts: MixPart[]; empty: string }) {
  const max = Math.max(...parts.map((part) => part.count), 1);
  return <article className="crm-chart-panel crm-chart-panel-wide">
    <ChartHead title={title} hint={hint} />
    {!parts.length ? <ChartPlaceholder kind="bars" message={empty} /> : <div className="crm-analytics-bars">{parts.slice(0, 8).map((part, index) => <div key={part.key}><span><strong>{part.label}</strong><b>{part.count}</b></span><i><span style={{ width: `${(part.count / max) * 100}%`, background: chartColor(index, mixTone(part.key)) }} /></i></div>)}</div>}
  </article>;
}
