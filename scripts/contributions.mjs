#!/usr/bin/env node
// Generates static contribution heatmaps (light + dark) from a committed daily-count
// snapshot. Merging with Math.max() keeps days green even after GitHub stops
// attributing them (left org, repo went private, private contributions disabled).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DAY = 86_400_000;
const CELL = 11;
const GAP = 3;
const PITCH = CELL + GAP;
const WEEKS = 53;

const PALETTES = {
  light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  dark: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};
const LABEL_COLORS = { light: "#57606a", dark: "#8b949e" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const login = args.login || process.env.GH_LOGIN || "rifkykurniawan";
const snapshotPath = args.snapshot || process.env.SNAPSHOT || join("data", "contributions.json");
const outDir = args["out-dir"] || process.env.OUT_DIR || "assets";
const token = process.env.CONTRIBUTIONS_TOKEN || "";

const toMs = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);

async function loadSnapshot() {
  try {
    const raw = JSON.parse(await readFile(snapshotPath, "utf8"));
    return raw.days && typeof raw.days === "object" ? raw.days : {};
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

async function fetchGraphQL() {
  const to = new Date();
  const from = new Date(to.getTime() - 366 * DAY);
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
    user(login:$login){
      contributionsCollection(from:$from,to:$to){
        contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
      }
    }
  }`;
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `${login}-contributions-generator`,
    },
    body: JSON.stringify({ query, variables: { login, from: from.toISOString(), to: to.toISOString() } }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(payload.errors ?? payload).slice(0, 300)}`);
  }
  const days = {};
  const weeks = payload.data?.user?.contributionsCollection?.contributionCalendar?.weeks ?? [];
  for (const week of weeks) {
    for (const day of week.contributionDays) days[day.date] = day.contributionCount;
  }
  if (Object.keys(days).length === 0) throw new Error("GraphQL returned no contribution days");
  return days;
}

// Public page: only counts public contributions, but needs no credentials.
async function fetchPublicHtml() {
  const response = await fetch(`https://github.com/users/${login}/contributions`, {
    headers: { "User-Agent": `${login}-contributions-generator` },
  });
  if (!response.ok) throw new Error(`Public contributions page returned ${response.status}`);
  const html = await response.text();

  const dates = new Map();
  for (const match of html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"[^>]*id="(contribution-day-component-[\d-]+)"/g)) {
    dates.set(match[2], match[1]);
  }
  const counts = new Map();
  for (const match of html.matchAll(/for="(contribution-day-component-[\d-]+)"[^>]*>(\d+|No) contributions?/g)) {
    counts.set(match[1], match[2] === "No" ? 0 : Number(match[2]));
  }

  const days = {};
  for (const [id, date] of dates) {
    if (counts.has(id)) days[date] = counts.get(id);
  }
  if (Object.keys(days).length === 0) throw new Error("Could not parse the public contributions page");
  return days;
}

async function fetchFresh() {
  if (token) {
    try {
      return { days: await fetchGraphQL(), source: "graphql" };
    } catch (error) {
      console.warn(`[warn] ${error.message}`);
      console.warn("[warn] Falling back to public contributions (private data will not be refreshed).");
    }
  } else {
    console.warn("[warn] CONTRIBUTIONS_TOKEN is not set; using public contributions only.");
  }
  try {
    return { days: await fetchPublicHtml(), source: "public-html" };
  } catch (error) {
    console.warn(`[warn] ${error.message}`);
    console.warn("[warn] Rendering from the committed snapshot only.");
    return { days: {}, source: "snapshot-only" };
  }
}

function levelThresholds(days) {
  const values = Object.values(days)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return [1, 1, 1];
  const at = (q) => values[Math.min(values.length - 1, Math.floor(values.length * q))];
  return [at(0.25), at(0.5), at(0.75)];
}

function levelFor(count, thresholds) {
  if (count <= 0) return 0;
  if (count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

function render(days, paletteName) {
  const palette = PALETTES[paletteName];
  const labelColor = LABEL_COLORS[paletteName];
  const thresholds = levelThresholds(days);
  const todayMs = toMs(new Date().toISOString().slice(0, 10));
  const endMs = todayMs + (6 - new Date(todayMs).getUTCDay()) * DAY;
  const startMs = endMs - (WEEKS * 7 - 1) * DAY;

  const pad = 8;
  const gridTop = pad + 18;
  const gridHeight = 7 * PITCH - GAP;
  const legendTop = gridTop + gridHeight + 14;
  const width = pad * 2 + WEEKS * PITCH - GAP;
  const height = legendTop + CELL + pad;

  const cells = [];
  const labels = [];
  let total = 0;
  let previousMonth = -1;
  let lastLabelColumn = -Infinity;

  for (let index = 0; index < WEEKS * 7; index++) {
    const ms = startMs + index * DAY;
    const date = toDate(ms);
    const column = Math.floor(index / 7);
    const row = index % 7;
    const count = days[date] ?? 0;
    if (ms <= todayMs) total += count;
    const x = pad + column * PITCH;
    const y = gridTop + row * PITCH;

    cells.push(
      `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${palette[levelFor(count, thresholds)]}">` +
        `<title>${count} contribution${count === 1 ? "" : "s"} on ${date}</title></rect>`,
    );

    const month = new Date(ms).getUTCMonth();
    if (row === 0 && month !== previousMonth && column < WEEKS - 1 && column - lastLabelColumn >= 3) {
      labels.push(`<text x="${x}" y="${pad + 11}">${MONTHS[month]}</text>`);
      lastLabelColumn = column;
    }
    if (row === 0) previousMonth = month;
  }

  const legendX = width - pad - 26 - (5 * PITCH - GAP);
  const legend = palette
    .map(
      (color, level) =>
        `<rect x="${legendX + level * PITCH}" y="${legendTop}" width="${CELL}" height="${CELL}" rx="2" fill="${color}"/>`,
    )
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
    ` role="img" aria-label="${total} contributions in the last year" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="9">`,
    `<title>${login} contribution activity</title>`,
    `<g fill="${labelColor}">${labels.join("")}</g>`,
    `<g>${cells.join("")}</g>`,
    `<g>${legend}</g>`,
    `<text x="${legendX - 6}" y="${legendTop + CELL - 2}" fill="${labelColor}" text-anchor="end">Less</text>`,
    `<text x="${width - pad}" y="${legendTop + CELL - 2}" fill="${labelColor}" text-anchor="end">More</text>`,
    `</svg>`,
    ``,
  ].join("\n");
}

async function main() {
  const snapshot = await loadSnapshot();
  const { days: fresh, source } = await fetchFresh();

  const merged = { ...snapshot };
  let added = 0;
  let raised = 0;
  for (const [date, count] of Object.entries(fresh)) {
    const previous = merged[date] ?? 0;
    if (count > previous) {
      merged[date] = count;
      if (previous === 0) added++;
      else raised++;
    }
  }

  const days = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(days).reduce((sum, count) => sum + count, 0);

  await mkdir(outDir, { recursive: true });
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(join(outDir, "contributions.svg"), render(days, "light"));
  await writeFile(join(outDir, "contributions-dark.svg"), render(days, "dark"));
  await writeFile(
    snapshotPath,
    `${JSON.stringify({ login, updatedAt: new Date().toISOString(), source, days }, null, 2)}\n`,
  );

  console.log(
    `source=${source} snapshotDays=${Object.keys(snapshot).length} -> ${Object.keys(days).length} ` +
      `(new=${added}, raised=${raised}) totalContributions=${total}`,
  );
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(1);
});
