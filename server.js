"use strict";
const path = require("path");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number(process.env.PORT) || 8080;
const BOOT_TIME = new Date();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ------------------------------------------------------------------ helpers --
function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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

app.get("/api/stars", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("cg_stars")
      .select("id, name, message, hue, x, y, created_at")
      .order("id", { ascending: false })
      .limit(300);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "storage unavailable" });
  }
});

app.post("/api/stars", async (req, res) => {
  const name = clean(req.body.name, 24) || "anonymous";
  const message = clean(req.body.message, 80);
  const rawHue = Math.round(Number(req.body.hue));
  const hue = Number.isFinite(rawHue) ? Math.max(0, Math.min(360, rawHue)) : Math.floor(Math.random() * 360);
  if (!message) return res.status(400).json({ error: "write something first" });
  if (rateLimited(`star:${req.ip}`, 5, 3600000)) {
    return res.status(429).json({ error: "slow down: 5 messages an hour per visitor" });
  }
  const x = 0.07 + Math.random() * 0.86;
  const y = 0.16 + Math.random() * 0.62;
  try {
    const { data, error } = await supabase
      .from("cg_stars")
      .insert({ name, message, hue, x, y })
      .select("id, name, message, hue, x, y, created_at")
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "could not save your message" });
  }
});

app.post("/api/visit", async (req, res) => {
  res.status(410).json({ error: "visit tracking is disabled" });
});

async function countDistinctDevices() {
  const devices = new Set();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("cg_visits")
      .select("device")
      .not("device", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const row of data) devices.add(row.device);
    if (data.length < pageSize) return devices.size;
  }
}

app.get("/api/stats", async (_req, res) => {
  try {
    const [stars, visitsCount, boots, resumes, events, visits, devices] = await Promise.all([
      supabase.from("cg_stars").select("id", { count: "exact", head: true }),
      supabase.from("cg_visits").select("id", { count: "exact", head: true }),
      supabase.from("cg_events").select("id", { count: "exact", head: true }).eq("kind", "boot"),
      supabase.from("cg_events").select("id", { count: "exact", head: true }).eq("kind", "resume"),
      supabase.from("cg_events").select("kind, detail, duration_ms, created_at").order("id", { ascending: false }).limit(8),
      supabase.from("cg_visits").select("device, ttfb_ms, api_ms, gap_seconds, created_at").order("id", { ascending: false }).limit(10),
      countDistinctDevices(),
    ]);
    for (const result of [stars, visitsCount, boots, resumes, events, visits]) {
      if (result.error) throw result.error;
    }
    res.json({
      stars: stars.count,
      visits: visitsCount.count,
      devices,
      boots: boots.count,
      resumes: resumes.count,
      bootedAt: BOOT_TIME.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      recentEvents: events.data,
      recentVisits: visits.data,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "storage unavailable" });
  }
});

// maxAge 0: browsers must ask the server on every visit, so a visit always
// counts as a real request (and wakes a sleeping service).
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: "bad request" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT}`));