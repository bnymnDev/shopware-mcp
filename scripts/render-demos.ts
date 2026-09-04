/**
 * Renders the animated terminal recordings in docs/demo/*.svg from their transcripts
 * (docs/demo/*.json). The SVGs animate with SMIL, so they play inside a plain <img>
 * on GitHub and npm without scripts or external assets.
 *
 * Usage: pnpm docs:demos [--check]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEMO_DIR = "docs/demo";
const WIDTH = 940;
const PAD_X = 24;
const BAR_HEIGHT = 40;
const LINE_HEIGHT = 22;
const FONT_SIZE = 14;
const MAX_COLUMNS = 106;
const FONT =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const COLORS = {
  bg: "#0d1117",
  frame: "#30363d",
  title: "#8b949e",
  text: "#e6edf3",
  dim: "#8b949e",
  muted: "#6e7681",
  blue: "#58a6ff",
  cyan: "#39c5cf",
  green: "#3fb950",
  yellow: "#d29922",
  red: "#f85149",
  purple: "#d2a8ff",
  tool: "#79c0ff",
} as const;

type Color = keyof typeof COLORS;

type Line =
  | { kind: "shell"; text: string }
  | { kind: "prompt"; text: string }
  | { kind: "call"; tool: string; args?: string | string[] }
  | { kind: "result"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "note"; text: string }
  | { kind: "blank" }
  | { kind: "pause"; ms: number };

type Transcript = { title: string; lines: Line[] };

type Segment = { text: string; color: Color };

/** Time between events, in milliseconds. */
const TIMING = {
  perChar: 48,
  afterPrompt: 550,
  beforeCall: 250,
  afterCall: 700,
  perResult: 70,
  beforeAgent: 500,
  perAgent: 380,
  shell: 450,
  note: 400,
  holdAtEnd: 5200,
};

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renderers collapse runs of spaces in SVG text; non-breaking spaces keep the indentation. */
function keepSpaces(text: string): string {
  return text.replace(/ /g, "\u00a0");
}

/** Inline markup: `{red:●}` colours one span; everything else keeps the default colour. */
function segments(text: string, base: Color): Segment[] {
  const out: Segment[] = [];
  const pattern = /\{(\w+):([^}]*)\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ text: text.slice(last, index), color: base });
    const color = match[1] as Color;
    if (!(color in COLORS)) throw new Error(`unknown colour "${color}" in: ${text}`);
    out.push({ text: match[2] ?? "", color });
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), color: base });
  return out;
}

function plainLength(text: string): number {
  return text.replace(/\{\w+:([^}]*)\}/g, "$1").length;
}

function visibility(start: number, total: number): string {
  const from = Math.max(start / total, 0.0005).toFixed(4);
  const until = ((total - 40) / total).toFixed(4);
  return (
    `<animate attributeName="opacity" values="0;1;0;0" keyTimes="0;${from};${until};1" ` +
    `calcMode="discrete" dur="${(total / 1000).toFixed(2)}s" repeatCount="indefinite"/>`
  );
}

function typed(text: string, start: number, total: number): string {
  const until = ((total - 40) / total).toFixed(4);
  const dur = (total / 1000).toFixed(2);
  return [...text]
    .map((char, index) => {
      const from = Math.max((start + index * TIMING.perChar) / total, 0.0005).toFixed(4);
      return (
        `<tspan fill-opacity="0">${xml(keepSpaces(char))}<animate attributeName="fill-opacity" ` +
        `values="0;1;0;0" keyTimes="0;${from};${until};1" calcMode="discrete" dur="${dur}s" ` +
        `repeatCount="indefinite"/></tspan>`
      );
    })
    .join("");
}

function spans(parts: Segment[]): string {
  return parts
    .map((part) => `<tspan fill="${COLORS[part.color]}">${xml(keepSpaces(part.text))}</tspan>`)
    .join("");
}

type Placed = { y: number; start: number; body: string; typedText?: string };

function layout(transcript: Transcript): { placed: Placed[]; total: number; rows: number } {
  const placed: Placed[] = [];
  let clock = 400;
  let row = 0;
  let previous: Line["kind"] | undefined;
  const y = () => BAR_HEIGHT + 18 + row * LINE_HEIGHT + FONT_SIZE;

  for (const line of transcript.lines) {
    if (line.kind === "pause") {
      clock += line.ms;
      continue;
    }
    if (line.kind === "blank") {
      row += 1;
      previous = line.kind;
      continue;
    }
    const argLines =
      line.kind === "call" ? (Array.isArray(line.args) ? line.args : [line.args ?? ""]) : [];
    const widths =
      line.kind === "call"
        ? argLines.map((args, index) =>
            index === 0 ? 2 + line.tool.length + 1 + args.length : 4 + args.length,
          )
        : line.kind === "agent"
          ? [plainLength(line.text) + 8]
          : [plainLength(line.text) + 2];
    if (widths.some((width) => width > MAX_COLUMNS)) {
      throw new Error(
        `${transcript.title}: line wider than ${MAX_COLUMNS} columns: ${JSON.stringify(line)}`,
      );
    }

    switch (line.kind) {
      case "shell": {
        placed.push({
          y: y(),
          start: clock,
          body: spans([
            { text: "$ ", color: "muted" },
            { text: line.text, color: "text" },
          ]),
        });
        clock += TIMING.shell;
        break;
      }
      case "prompt": {
        placed.push({ y: y(), start: clock, body: "", typedText: line.text });
        clock += line.text.length * TIMING.perChar + TIMING.afterPrompt;
        break;
      }
      case "call": {
        clock += TIMING.beforeCall;
        const [head = "", ...rest] = argLines;
        placed.push({
          y: y(),
          start: clock,
          body: spans([
            { text: "→ ", color: "purple" },
            { text: line.tool, color: "tool" },
            { text: head ? ` ${head}` : "", color: "dim" },
          ]),
        });
        for (const args of rest) {
          row += 1;
          placed.push({
            y: y(),
            start: clock,
            body: spans([{ text: `    ${args}`, color: "dim" }]),
          });
        }
        clock += TIMING.afterCall;
        break;
      }
      case "result": {
        placed.push({
          y: y(),
          start: clock,
          body: spans([{ text: "  ", color: "dim" }, ...segments(line.text, "dim")]),
        });
        clock += TIMING.perResult;
        break;
      }
      case "agent": {
        const first = previous !== "agent";
        if (first) clock += TIMING.beforeAgent;
        placed.push({
          y: y(),
          start: clock,
          body: spans([
            first ? { text: "agent › ", color: "green" } : { text: "        ", color: "text" },
            ...segments(line.text, "text"),
          ]),
        });
        clock += TIMING.perAgent;
        break;
      }
      case "note": {
        placed.push({
          y: y(),
          start: clock,
          body: spans([{ text: "  ", color: "muted" }, ...segments(line.text, "muted")]),
        });
        clock += TIMING.note;
        break;
      }
    }
    row += 1;
    previous = line.kind;
  }

  // Closing prompt with a blinking cursor: the shop is waiting for the next question.
  placed.push({ y: y(), start: clock + 300, body: "__CURSOR__" });
  row += 1;
  return { placed, total: clock + 300 + TIMING.holdAtEnd, rows: row };
}

function render(transcript: Transcript): string {
  const { placed, total, rows } = layout(transcript);
  const height = BAR_HEIGHT + 18 + rows * LINE_HEIGHT + 14;
  const texts = placed.map((item) => {
    if (item.body === "__CURSOR__") {
      return (
        `<text x="${PAD_X}" y="${item.y}" opacity="0"><tspan fill="${COLORS.blue}">› </tspan>` +
        `<tspan fill="${COLORS.text}">▍<animate attributeName="fill-opacity" values="1;0" keyTimes="0;0.5" ` +
        `calcMode="discrete" dur="1.1s" repeatCount="indefinite"/></tspan>${visibility(item.start, total)}</text>`
      );
    }
    if (item.typedText !== undefined) {
      return (
        `<text x="${PAD_X}" y="${item.y}" opacity="0"><tspan fill="${COLORS.blue}">› </tspan>` +
        `<tspan fill="${COLORS.text}">${typed(item.typedText, item.start, total)}</tspan>` +
        `${visibility(item.start, total)}</text>`
      );
    }
    return `<text x="${PAD_X}" y="${item.y}" opacity="0">${item.body}${visibility(item.start, total)}</text>`;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="${xml(transcript.title)}">`,
    `<title>${xml(transcript.title)}</title>`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="${COLORS.bg}" stroke="${COLORS.frame}"/>`,
    `<line x1="1" y1="${BAR_HEIGHT}" x2="${WIDTH - 1}" y2="${BAR_HEIGHT}" stroke="${COLORS.frame}"/>`,
    `<circle cx="22" cy="20" r="6" fill="#ff5f56"/><circle cx="42" cy="20" r="6" fill="#ffbd2e"/><circle cx="62" cy="20" r="6" fill="#27c93f"/>`,
    `<text x="${WIDTH / 2}" y="25" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${COLORS.title}">${xml(transcript.title)}</text>`,
    `<g font-family="${FONT}" font-size="${FONT_SIZE}">`,
    ...texts,
    "</g>",
    "</svg>",
    "",
  ].join("\n");
}

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const file of readdirSync(DEMO_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const transcript = JSON.parse(readFileSync(join(DEMO_DIR, file), "utf8")) as Transcript;
  const target = join(DEMO_DIR, file.replace(/\.json$/, ".svg"));
  const next = render(transcript);
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (check) {
    if (current !== next) stale.push(target);
  } else {
    writeFileSync(target, next);
    process.stderr.write(`Wrote ${target} (${(next.length / 1024).toFixed(0)} KB)\n`);
  }
}
if (check && stale.length > 0) {
  process.stderr.write(
    `Demo recordings are stale: ${stale.join(", ")}. Run \`pnpm docs:demos\`.\n`,
  );
  process.exit(1);
}
if (check) process.stderr.write("Demo recordings are up to date.\n");
