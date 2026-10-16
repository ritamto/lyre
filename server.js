"use strict";
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT) || 8080;
const BOOT_TIME = new Date();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- database --
// Use DATABASE_URL if it exists, otherwise any env var holding a postgres:// URL.
function findDatabaseUrl() {
  if (process.env.DATABASE_URL) return { name: "DATABASE_URL", url: process.env.DATABASE_URL };
  for (const [name, value] of Object.entries(process.env)) {
    if (/^postgres(ql)?:\/\//.test(value || "")) return { name, url: value };
  }
  return null;
}

const found = findDatabaseUrl();
if (!found) {
  console.error("No Postgres connection string in the environment. Bind the database to this service.");
  process.exit(1);
}
console.log(`database credentials come from ${found.name}`);

const pool = new Pool({
  connectionString: found.url,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ssl: process.env.PGSSL ? { rejectUnauthorized: false } : undefined,
});
pool.on("error", (err) => console.error("idle db client error:", err.message));

// The database may be asleep too, so retry for a while before giving up.
async function initDb() {
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await pool.query(`
        create table if not exists cg_stars (
          id serial primary key,
          name text not null,
          message text not null,
          hue int not null,
          x real not null,
          y real not null,
          created_at timestamptz not null default now()
        );
        create table if not exists cg_visits (
          id serial primary key,
          device text not null,
          ttfb_ms int,
          api_ms int,
          gap_seconds int,
          created_at timestamptz not null default now()
        );
        create table if not exists cg_events (
          id serial primary key,
          kind text not null,
          detail text,
          duration_ms bigint,
          created_at timestamptz not null default now()
        );
      `);
      return;
    } catch (err) {
      console.error(`db init attempt ${attempt} failed: ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error("database never became reachable");
}

async function logEvent(kind, detail, durationMs) {
  try {
    await pool.query(
      "insert into cg_events (kind, detail, duration_ms) values ($1, $2, $3)",
      [kind, detail, durationMs]
    );
  } catch (err) {
    console.error("logEvent failed:", err.message);
  }
}

const ready = initDb().then(() => logEvent("boot", `node ${process.version}`, null));
ready.catch((err) => {
  console.error("startup failed:", err.message);
  process.exit(1);
});

// ------------------------------------------------------- suspend detection --
// A timer that fires every 5s. If it fires much later than expected, the
// process was frozen (suspended) in between, so we log a "resume" event.
// If the VM clock stands still while frozen this may stay quiet; the visits
// table (timed by the database) is the dependable record either way.
const TICK_MS = 5000;
const RESUME_THRESHOLD_MS = 20000;
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;
  if (gap > RESUME_THRESHOLD_MS) {
    console.log(`resumed after being frozen for about ${Math.round(gap / 1000)}s`);
    logEvent("resume", "timers stalled", gap);
  }
}, TICK_MS).unref();

// ------------------------------------------------------------------ helpers --
function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function toInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n < 600000 ? n : null;
}

const hits = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

// -------------------------------------------------------------------- app --
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "4kb" }));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.use("/api", async (_req, res, next) => {
  try {
    await ready;
    next();
  } catch {
    res.status(503).json({ error: "database not ready" });
  }
});

app.get("/api/stars", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "select id, name, message, hue, x, y, created_at from cg_stars order by id desc limit 300"
    );
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "database unavailable" });
  }
});

app.post("/api/stars", async (req, res) => {
  const name = clean(req.body.name, 24) || "anonymous";
  const message = clean(req.body.message, 80);
  const rawHue = Math.round(Number(req.body.hue));
  const hue = Number.isFinite(rawHue) ? Math.max(0, Math.min(360, rawHue)) : Math.floor(Math.random() * 360);
  if (!message) return res.status(400).json({ error: "write something first" });
  if (rateLimited(`star:${req.ip}`, 5, 3600000)) {
    return res.status(429).json({ error: "slow down: 5 stars an hour per visitor" });
  }
  const x = 0.07 + Math.random() * 0.86;
  const y = 0.16 + Math.random() * 0.62;
  try {
    const { rows } = await pool.query(
      `insert into cg_stars (name, message, hue, x, y) values ($1, $2, $3, $4, $5)
       returning id, name, message, hue, x, y, created_at`,
      [name, message, hue, x, y]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "could not save your star" });
  }
});

app.post("/api/visit", async (req, res) => {
  if (rateLimited(`visit:${req.ip}`, 30, 3600000)) return res.status(429).json({ error: "too many visits" });
  const device = clean(req.body.device, 60) || "unknown";
  try {
    await pool.query(
      `insert into cg_visits (device, ttfb_ms, api_ms, gap_seconds)
       values ($1, $2, $3, (select round(extract(epoch from now() - max(created_at)))::int from cg_visits))`,
      [device, toInt(req.body.ttfbMs), toInt(req.body.apiMs)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "could not record visit" });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const [counts, events, visits] = await Promise.all([
      pool.query(`select
        (select count(*) from cg_stars)::int as stars,
        (select count(*) from cg_visits)::int as visits,
        (select count(distinct device) from cg_visits)::int as devices,
        (select count(*) from cg_events where kind = 'boot')::int as boots,
        (select count(*) from cg_events where kind = 'resume')::int as resumes`),
      pool.query("select kind, detail, duration_ms, created_at from cg_events order by id desc limit 8"),
      pool.query("select device, ttfb_ms, api_ms, gap_seconds, created_at from cg_visits order by id desc limit 10"),
    ]);
    res.json({
      ...counts.rows[0],
      bootedAt: BOOT_TIME.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      recentEvents: events.rows,
      recentVisits: visits.rows,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "database unavailable" });
  }
});

// maxAge 0: browsers must ask the server on every visit, so a visit always
// counts as a real request (and wakes a sleeping service).
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: "bad request" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT}`));

process.on("SIGTERM", () => {
  pool.end().finally(() => process.exit(0));
});