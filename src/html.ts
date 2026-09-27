import { describeItem } from "./format.js";
import type { runAudit } from "./tools/audit.js";
import type { Pulse } from "./tools/pulse.js";
import type { buildSalesReport } from "./tools/reports.js";

type AuditReport = Awaited<ReturnType<typeof runAudit>>;
type SalesReport = Awaited<ReturnType<typeof buildSalesReport>>;

/* ------------------------------------------------------------------------------------------
 * Text: everything from the shop is data, never markup.
 * ---------------------------------------------------------------------------------------- */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function money(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined) return "–";
  if (!currency) return integer.format(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    }).format(value);
  } catch {
    return `${integer.format(value)} ${currency}`;
  }
}

/** 12.9K / 4.2M for axis ticks and tight labels. */
function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** "about 1 in 100" for a probability, rounded to two significant digits. */
export function odds(chance: number): string {
  if (chance <= 0) return "practically never";
  const oneIn = 1 / chance;
  if (oneIn < 2) return "more often than not";
  const rounded = Number(oneIn.toPrecision(oneIn >= 100 ? 1 : 2));
  return `about 1 in ${integer.format(rounded)}`;
}

function delta(percent: number | null | undefined, upIsGood = true): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "";
  const sign = percent > 0 ? "+" : percent < 0 ? "−" : "±";
  const good = percent === 0 ? null : percent > 0 === upIsGood;
  const tone = good === null ? "flat" : good ? "up" : "down";
  const arrow = percent > 0 ? "▲" : percent < 0 ? "▼" : "";
  return `<span class="delta ${tone}">${arrow} ${sign}${decimal.format(Math.abs(percent))} %</span>`;
}

/* ------------------------------------------------------------------------------------------
 * Column chart: thin columns, 4px rounded tops, one baseline, hairline grid, table twin.
 * ---------------------------------------------------------------------------------------- */

export interface Column {
  label: string;
  value: number;
  /** Tooltip and table text beyond label and value. */
  detail?: string;
  /** Drawn in the accent; everything else is context gray. */
  emphasis?: boolean;
  /** A period still running, drawn lighter and labelled "so far". */
  partial?: boolean;
  /** Show the value on the cap; kept for the few columns the story is about. */
  labelled?: boolean;
}

export interface ColumnChartOptions {
  caption: string;
  columns: Column[];
  format: (value: number) => string;
  reference?: { value: number; label: string };
  /** Every column in the accent (a single series) instead of emphasis on some. */
  single?: boolean;
  valueHeader: string;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

export function columnChart(options: ColumnChartOptions): string {
  const { columns, format } = options;
  // Drawn for a ~480px column: text stays near its CSS size wherever the chart sits.
  const width = 480;
  const height = 210;
  const left = 40;
  const right = options.reference ? 78 : 10;
  const top = 20;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const peak = Math.max(...columns.map((column) => column.value), options.reference?.value ?? 0);
  const max = niceMax(peak * 1.1);
  const y = (value: number) => top + plotHeight - (value / max) * plotHeight;
  const band = plotWidth / Math.max(1, columns.length);
  const barWidth = Math.min(24, band * 0.56);
  const ticks = [0, max / 2, max];

  const grid = ticks
    .map(
      (tick) =>
        `<line class="grid" x1="${left}" x2="${left + plotWidth}" y1="${y(tick)}" y2="${y(tick)}"/>` +
        `<text class="tick" x="${left - 8}" y="${y(tick) + 4}" text-anchor="end">${esc(compact(tick))}</text>`,
    )
    .join("");

  const bars = columns
    .map((column, index) => {
      const cx = left + band * index + band / 2;
      const x = cx - barWidth / 2;
      const top = y(column.value);
      const h = Math.max(0, y(0) - top);
      const r = Math.min(4, h, barWidth / 2);
      const tone = options.single || column.emphasis ? "accent" : "context";
      const cls = `bar ${tone}${column.partial ? " partial" : ""}`;
      const tip = [
        column.label,
        `${options.valueHeader}: ${format(column.value)}${column.partial ? " so far" : ""}`,
        column.detail ?? "",
      ]
        .filter(Boolean)
        .join("\n");
      // Rounded data end, square at the baseline.
      const path =
        h <= 0
          ? ""
          : `<path class="${cls}" d="M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + barWidth - r} Q${x + barWidth},${top} ${x + barWidth},${top + r} V${y(0)} Z"/>`;
      const zero =
        h <= 0
          ? `<line class="zero ${tone}" x1="${x}" x2="${x + barWidth}" y1="${y(0) - 1}" y2="${y(0) - 1}"/>`
          : "";
      const label = column.labelled
        ? `<text class="cap" x="${cx}" y="${top - 6}" text-anchor="middle">${esc(format(column.value))}${column.partial ? " so far" : ""}</text>`
        : "";
      const hit = `<rect class="hit" x="${cx - band / 2}" y="${top - 2}" width="${band}" height="${plotHeight + 4}" fill="transparent" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ", "))}"><title>${esc(tip)}</title></rect>`;
      const axis = `<text class="xlabel" x="${cx}" y="${height - 10}" text-anchor="middle">${esc(column.label)}</text>`;
      return `<g>${path}${zero}${label}${axis}${hit}</g>`;
    })
    .join("");

  const reference = options.reference
    ? `<line class="reference" x1="${left}" x2="${left + plotWidth}" y1="${y(options.reference.value)}" y2="${y(options.reference.value)}"/>` +
      `<text class="refLabel" x="${left + plotWidth + 6}" y="${y(options.reference.value) + 4}">${esc(options.reference.label)}</text>`
    : "";

  const rows = columns
    .map(
      (column) =>
        `<tr><td>${esc(column.label)}</td><td class="num">${esc(format(column.value))}${column.partial ? " (so far)" : ""}</td><td>${esc(column.detail ?? "")}</td></tr>`,
    )
    .join("");

  return `<figure class="chart">
<figcaption>${esc(options.caption)}</figcaption>
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options.caption)}">
${grid}<line class="baseline" x1="${left}" x2="${left + plotWidth}" y1="${y(0)}" y2="${y(0)}"/>${reference}${bars}
</svg>
<details><summary>Table</summary><table><thead><tr><th></th><th class="num">${esc(options.valueHeader)}</th><th></th></tr></thead><tbody>${rows}</tbody></table></details>
</figure>`;
}

/* ------------------------------------------------------------------------------------------
 * Pieces
 * ---------------------------------------------------------------------------------------- */

type Status = "critical" | "warning" | "good" | "info";
const ICONS: Record<Status, string> = { critical: "✕", warning: "!", good: "✓", info: "i" };

function status(kind: Status, label: string): string {
  return `<span class="status ${kind}"><span class="icon" aria-hidden="true">${ICONS[kind]}</span>${esc(label)}</span>`;
}

function tile(label: string, value: string, sub: string): string {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

const weekday = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(new Date(iso));
const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
/** "Aug 2, 9, 16, 23, 30, Sep 6": the month only where it changes, so labels never collide. */
export function dayLabels(dates: string[]): string[] {
  let month = "";
  return dates.map((date) => {
    if (!date) return "";
    const current = date.slice(0, 7);
    const label = shortDate(date);
    if (current === month) return label.replace(/^\D+/, "");
    month = current;
    return label;
  });
}

const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );

/* ------------------------------------------------------------------------------------------
 * Sections
 * ---------------------------------------------------------------------------------------- */

export function pulseSection(pulse: Pulse, currency: string | null): string {
  const tz = pulse.timeZone;
  const now = clock(pulse.now, tz);
  const day = weekday(pulse.now, tz);
  const silence = pulse.silence;
  const verdict = silence?.verdict ?? "normal";
  const weeks = pulse.typical.weeks;

  let banner = "";
  if (silence && pulse.lastOrder && verdict !== "normal") {
    const since = clock(pulse.lastOrder.at, tz);
    const kind: Status = verdict === "unusual" ? "critical" : "warning";
    const counts = silence.sameGapInPreviousWeeks;
    const withOrders = counts.filter((count) => count > 0).length;
    const how =
      withOrders === counts.length
        ? "orders came in every time"
        : `${withOrders} of ${counts.length} brought orders`;
    banner = `<div class="banner ${kind}">${status(kind, verdict === "unusual" ? "Unusual silence" : "Quieter than usual")}
<p>No order for <strong>${esc(duration(silence.minutes))}</strong>, since ${esc(since)}. Between ${esc(since)} and ${esc(now)} on the last ${counts.length} ${esc(day)}s, ${how}, <strong>${esc(decimal.format(silence.expectedOrders))}</strong> on average. A gap like this happens by chance ${esc(odds(silence.chance))} times. Check the checkout: maintenance mode, payment provider, error log.</p></div>`;
  } else if (pulse.payments.verdict !== "normal") {
    const kind: Status = pulse.payments.verdict === "unusual" ? "critical" : "warning";
    banner = `<div class="banner ${kind}">${status(kind, "Payments failing")}
<p>${pulse.payments.today.failedOrCancelled} of ${pulse.payments.today.total} payments today failed or were cancelled; usually ${Math.round(pulse.payments.typicalFailedShare * 100)} %. Check the payment provider.</p></div>`;
  } else {
    banner = `<div class="banner good">${status("good", "Orders arriving as usual")}</div>`;
  }

  const tiles = [
    tile(
      `Orders by ${now}`,
      esc(integer.format(pulse.today.orders)),
      `${delta(pulse.change.orders)} <span class="muted">vs ${esc(decimal.format(pulse.typical.orders))} on a typical ${esc(day)}</span>`,
    ),
    tile(
      `Revenue by ${now}`,
      esc(money(pulse.today.revenue, currency)),
      `${delta(pulse.change.revenue)} <span class="muted">vs ${esc(money(pulse.typical.revenue, currency))}</span>`,
    ),
    tile(
      "Last order",
      pulse.lastOrder ? esc(duration(pulse.lastOrder.minutesAgo ?? 0)) : "–",
      pulse.lastOrder
        ? `<span class="muted">ago · #${esc(pulse.lastOrder.orderNumber)} at ${esc(clock(pulse.lastOrder.at, tz))}</span>`
        : `<span class="muted">no orders yet</span>`,
    ),
    tile(
      "Failed payments today",
      `${esc(pulse.payments.today.failedOrCancelled)} <span class="unit">of ${esc(pulse.payments.today.total)}</span>`,
      `<span class="muted">usually ${Math.round(pulse.payments.typicalFailedShare * 100)} %</span>`,
    ),
  ].join("");

  const history = [...pulse.history].reverse();
  const historyLabels = dayLabels(history.map((week) => week.date));
  const byTime = columnChart({
    caption: `Orders by ${now} on the last ${weeks} ${day}s and today`,
    valueHeader: "Orders",
    format: (value) => integer.format(value),
    reference: {
      value: pulse.typical.orders,
      label: `typical ${decimal.format(pulse.typical.orders)}`,
    },
    columns: history.map((week, index) => ({
      label: week.weeksAgo === 0 ? "Today" : (historyLabels[index] ?? ""),
      value: week.orders,
      detail: money(week.revenue, currency),
      emphasis: week.weeksAgo === 0,
      labelled: week.weeksAgo === 0,
    })),
  });

  const gap =
    silence && pulse.lastOrder && silence.sameGapInPreviousWeeks.length > 0
      ? columnChart({
          caption: `Orders between ${clock(pulse.lastOrder.at, tz)} and ${now} on the same weekday`,
          valueHeader: "Orders",
          format: (value) => integer.format(value),
          reference: {
            value: silence.expectedOrders,
            label: `average ${decimal.format(silence.expectedOrders)}`,
          },
          columns: [
            ...silence.sameGapInPreviousWeeks
              .map((count, index) => ({ date: pulse.history[index + 1]?.date ?? "", value: count }))
              .reverse()
              .map((entry, index, all) => ({
                label: dayLabels(all.map((item) => item.date))[index] ?? "",
                value: entry.value,
              })),
            { label: "Today", value: 0, emphasis: true, labelled: true },
          ],
        })
      : "";

  return `<section>
<h2>Right now</h2>
<p class="lede">${esc(day)}, ${esc(now)} (${esc(tz)}). Today against the same hours of the last ${weeks} ${esc(day)}s.</p>
${banner}
<div class="tiles">${tiles}</div>
<div class="charts">${byTime}${gap}</div>
</section>`;
}

export function salesSection(report: SalesReport, title = "Last 7 days"): string {
  const currency = report.revenueByCurrency[0]?.currency ?? null;
  const totals = report.totals;
  const change = report.change;
  const tiles = [
    tile(
      "Revenue",
      esc(money(totals.revenueGross, currency)),
      `${delta(change?.revenueGross.percent)} <span class="muted">vs the period before</span>`,
    ),
    tile(
      "Orders",
      esc(integer.format(totals.orders)),
      `${delta(change?.orders.percent)} <span class="muted">vs ${esc(integer.format(report.previousPeriod?.orders ?? 0))}</span>`,
    ),
    tile(
      "Average order",
      esc(money(totals.averageOrderValue, currency)),
      `${delta(change?.averageOrderValue.percent)}`,
    ),
  ].join("");
  const lastBucket = report.timeline.at(-1)?.bucket ?? "";
  const running = Date.parse(report.period.to) > Date.now();
  const chart = columnChart({
    caption: `Revenue per ${report.period.interval}${running ? ", today so far in light blue" : ""}`,
    valueHeader: "Revenue",
    single: true,
    format: (value) => money(value, currency),
    columns: report.timeline.map((bucket, index, all) => ({
      label: dayLabels(all.map((entry) => (entry.bucket ?? "").slice(0, 10)))[index] ?? "",
      value: bucket.revenue,
      detail: `${integer.format(bucket.orders)} orders`,
      partial: running && bucket.bucket === lastBucket,
    })),
  });
  const products = report.topProducts
    .slice(0, 5)
    .map(
      (product, index) =>
        `<tr><td class="num">${index + 1}</td><td>${esc(product.productNumber)}</td><td>${esc(product.name)}</td><td class="num">${esc(integer.format(product.quantity))}</td><td class="num">${esc(money(product.revenue, currency))}</td></tr>`,
    )
    .join("");
  const channels = report.revenueBySalesChannel
    .map(
      (channel) =>
        `<tr><td>${esc(channel.salesChannel)}</td><td class="num">${esc(integer.format(channel.orders))}</td><td class="num">${esc(money(channel.revenue, currency))}</td></tr>`,
    )
    .join("");
  return `<section>
<h2>${esc(title)}</h2>
<p class="lede">${esc(report.period.from.slice(0, 10))} to ${esc(report.period.to.slice(0, 10))}, cancelled orders excluded.</p>
<div class="tiles">${tiles}</div>
<div class="charts">${chart}
<table class="card"><caption>Sales channels</caption><thead><tr><th>Channel</th><th class="num">Orders</th><th class="num">Revenue</th></tr></thead><tbody>${channels || '<tr><td colspan="3" class="muted">No sales</td></tr>'}</tbody></table>
</div>
<div class="tables">
<table class="card"><caption>Top products</caption><thead><tr><th class="num">#</th><th>Number</th><th>Product</th><th class="num">Qty</th><th class="num">Revenue</th></tr></thead><tbody>${products || '<tr><td colspan="5" class="muted">No sales</td></tr>'}</tbody></table>
</div>
</section>`;
}

const SEVERITY: Record<string, Status> = { critical: "critical", warning: "warning", info: "info" };

export function auditSection(
  report: AuditReport,
  sampleSize = 3,
  options: { foldInfo?: boolean } = {},
): string {
  const summary = report.summary;
  const chips = [
    status("critical", `${summary.critical} critical`),
    status("warning", `${summary.warning} warning`),
    status("info", `${summary.info} info`),
  ].join(" ");
  const card = (finding: AuditReport["findings"][number]) => {
    const kind = SEVERITY[finding.severity] ?? "info";
    const items = finding.items
      .slice(0, sampleSize)
      .map((item) => `<li>${esc(describeItem(item).replace(/\\\|/g, "|"))}</li>`)
      .join("");
    const more =
      finding.count > sampleSize
        ? `<li class="muted">and ${finding.count - sampleSize} more</li>`
        : "";
    return `<article class="finding ${kind}">
<header>${status(kind, finding.severity)}<h3>${esc(finding.title)} <span class="count">${esc(finding.count)}</span></h3></header>
<ul>${items}${more}</ul>
<p class="hint">${esc(finding.hint)}</p>
</article>`;
  };
  const folded = options.foldInfo ? report.findings.filter((f) => f.severity === "info") : [];
  const cards =
    report.findings
      .filter((finding) => !folded.includes(finding))
      .map(card)
      .join("") +
    (folded.length > 0
      ? `<details class="more"><summary>${folded.length} info ${folded.length === 1 ? "finding" : "findings"}</summary>${folded.map(card).join("")}</details>`
      : "");
  const skipped = report.warnings?.length
    ? `<p class="muted">Skipped: ${report.warnings.map((warning) => esc(warning)).join("; ")}</p>`
    : "";
  return `<section>
<h2>Audit</h2>
<p class="lede">${esc(summary.checksRun)} checks. ${chips}</p>
${cards || `<div class="banner good">${status("good", "Nothing to report")}</div>`}
${skipped}
</section>`;
}

/* ------------------------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------------------------- */

const STYLE = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--base:#c3c2b7;--ring:rgba(11,11,11,.10);--accent:#2a78d6;--accentSoft:#86b6ef;--context:#c3c2b7;--good:#0ca30c;--goodText:#006300;--warning:#fab219;--critical:#d03b3b;--badText:#b42c2c}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--base:#383835;--ring:rgba(255,255,255,.10);--accent:#3987e5;--accentSoft:#184f95;--context:#5a5955;--goodText:#0ca30c;--badText:#e66767}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--base:#383835;--ring:rgba(255,255,255,.10);--accent:#3987e5;--accentSoft:#184f95;--context:#5a5955;--goodText:#0ca30c;--badText:#e66767}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 20px 48px}
header.top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;align-items:baseline;border-bottom:1px solid var(--grid);padding-bottom:16px;margin-bottom:8px}
header.top h1{font-size:26px;margin:0;font-weight:650;letter-spacing:-.01em}
header.top .meta{color:var(--ink2);font-size:13px}
section{margin-top:32px}
h2{font-size:18px;margin:0 0 4px;font-weight:650}
h3{font-size:15px;margin:0;font-weight:600}
.lede{color:var(--ink2);margin:0 0 16px}
.muted{color:var(--muted)}
.banner{background:var(--surface);border:1px solid var(--ring);border-left:4px solid var(--good);border-radius:10px;padding:12px 16px;margin-bottom:16px}
.banner.critical{border-left-color:var(--critical)}.banner.warning{border-left-color:var(--warning)}
.banner p{margin:6px 0 0;color:var(--ink2)}.banner p strong{color:var(--ink)}
.status{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px;white-space:nowrap}
.status .icon{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;font-size:11px;font-weight:700;color:#fff}
.status.critical .icon{background:var(--critical)}.status.warning .icon{background:var(--warning);color:#0b0b0b}.status.good .icon{background:var(--good)}.status.info .icon{background:var(--muted)}
.lede .status{margin-left:10px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px 16px}
.tile .label{color:var(--ink2);font-size:13px}
.tile .value{font-size:28px;font-weight:600;line-height:1.25;margin-top:2px}
.tile .unit{font-size:15px;font-weight:400;color:var(--ink2)}
.tile .sub{font-size:13px;margin-top:4px}
.delta{font-weight:600}.delta.up{color:var(--goodText)}.delta.down{color:var(--badText)}.delta.flat{color:var(--ink2)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
figure.chart{margin:0;background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px 16px}
figcaption{font-weight:600;font-size:14px;margin-bottom:6px}
svg{display:block;width:100%;max-width:560px;height:auto;overflow:visible}
.grid{stroke:var(--grid);stroke-width:1}.baseline{stroke:var(--base);stroke-width:1}
.reference{stroke:var(--ink2);stroke-width:1}
.tick,.xlabel,.refLabel{fill:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums}
.refLabel{fill:var(--ink2)}
.cap{fill:var(--ink);font-size:13px;font-weight:600}
.bar.accent{fill:var(--accent)}.bar.context{fill:var(--context)}.bar.partial{fill:var(--accentSoft)}
.zero{stroke-width:2}.zero.accent{stroke:var(--accent)}.zero.context{stroke:var(--context)}
.hit{cursor:default;outline:none}
g:hover .bar,g:focus-within .bar{opacity:.8}
details{margin-top:8px;font-size:13px}summary{cursor:pointer;color:var(--ink2)}
details.more{font-size:15px}details.more>summary{margin:6px 0 10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--grid)}
th{color:var(--ink2);font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}
.tables{margin-top:12px}
table.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;align-self:start}
caption{text-align:left;font-weight:600;font-size:14px;padding:12px 8px 4px}
.finding{background:var(--surface);border:1px solid var(--ring);border-left:4px solid var(--muted);border-radius:10px;padding:12px 16px;margin-bottom:10px}
.finding.critical{border-left-color:var(--critical)}.finding.warning{border-left-color:var(--warning)}
.finding header{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}
.finding .count{color:var(--ink2);font-weight:400}
.finding ul{margin:8px 0 0;padding-left:18px;color:var(--ink2);font-size:14px}
.finding .hint{margin:8px 0 0;font-size:13px;color:var(--muted)}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--grid);color:var(--muted);font-size:12px}
#tip{position:fixed;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--ring);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);white-space:pre-line;z-index:10}
#tip strong{display:block;font-size:14px}
@media print{body{background:#fff}.tile,.finding,figure.chart,.banner{break-inside:avoid}details{display:none}}
`;

/** Tooltips enhance, never gate: values sit in the table views and native titles too. */
const SCRIPT = `
(() => {
  const tip = document.createElement("div");
  tip.id = "tip"; tip.hidden = true; document.body.appendChild(tip);
  const show = (el, x, y) => {
    const [head, value, ...rest] = (el.getAttribute("data-tip") || "").split("\\n");
    tip.textContent = "";
    const strong = document.createElement("strong"); strong.textContent = value || "";
    tip.appendChild(strong);
    tip.appendChild(document.createTextNode([head, ...rest].filter(Boolean).join("\\n")));
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, x + 14) + "px";
    tip.style.top = Math.max(8, y - h - 12) + "px";
  };
  document.querySelectorAll("[data-tip]").forEach((el) => {
    el.querySelector("title")?.remove();
    el.addEventListener("pointermove", (e) => show(el, e.clientX, e.clientY));
    el.addEventListener("pointerleave", () => { tip.hidden = true; });
    el.addEventListener("focus", () => { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); });
    el.addEventListener("blur", () => { tip.hidden = true; });
  });
})();
`;

export interface PageOptions {
  title: string;
  shop: string;
  generatedAt: string;
  sections: string[];
}

export function renderPage(options: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)} · ${esc(options.shop)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="top"><h1>${esc(options.title)}</h1><div class="meta">${esc(options.shop)} · ${esc(options.generatedAt)}</div></header>
${options.sections.join("\n")}
<footer>Generated by shopware-mcp from the shop's Admin API, read-only. The page loads nothing from anywhere.</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
