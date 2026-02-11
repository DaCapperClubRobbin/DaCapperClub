// 👇 MUST be first
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
// 🔎 Debug: ensure Supabase env vars exist
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ Supabase env vars missing!");
  console.error("SUPABASE_URL:", process.env.SUPABASE_URL);
  console.error(
    "SUPABASE_ANON_KEY:",
    process.env.SUPABASE_ANON_KEY ? "SET" : "MISSING"
  );
} else {
  console.log("✅ Supabase env vars loaded");
}

// 👇 imports
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const rateLimit = require("express-rate-limit");

// 👇 app setup
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ==================================================
// 🛡️ RATE LIMITING
// ==================================================

// General API limiter (GET /picks, etc.)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// Ingest limiter (Discord bot -> POST /picks)
// This prevents loops/spam from flooding your DB
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 posts/min per IP
  standardHeaders: true,
  legacyHeaders: false,

  handler: (req, res) => {
    res.status(429).json({
      error: "Too many incoming picks. Please slow down.",
    });
  },
});

// Mod limiter (POST /admin/hide)
const modLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // 30 actions/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general limiter ONLY to read endpoints
app.use("/picks", generalLimiter);   // GET /picks
app.use("/health", generalLimiter);  // GET /health

// ==================================================
// 🔐 INGEST AUTH (PRODUCTION)
// ==================================================
function requireIngest(req, res, next) {
  const token = String(req.headers["x-ingest-token"] || "").trim();
  const expected = String(process.env.INGEST_TOKEN || "").trim();

  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (token !== expected) {
    return res.status(401).json({ error: "Unauthorized ingest" });
  }

  next();
}

// 👇 Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
// ==================================================
// MOD AUTH (simple token-based moderation access)
// ==================================================
function getModTokens() {
  return (process.env.MOD_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isMod(req) {
  const token = String(req.headers["x-mod-token"] || "").trim();
  return !!token && getModTokens().includes(token);
}

function requireMod(req, res, next) {
  const token = String(req.headers["x-mod-token"] || "").trim();
  const allowed = getModTokens();

  if (!token || !allowed.includes(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// ==================================================
// GET PICKS (mods see hidden + get hidden flag)
// ==================================================
app.get("/picks", async (req, res) => {
  try {
    const mod = isMod(req);

    // 1) fetch hidden pick IDs
    const { data: hiddenRows, error: hiddenErr } = await supabase
      .from("hidden_picks")
      .select("pick_id");

    if (hiddenErr) {
      console.error("❌ hidden_picks error:", hiddenErr);
      return res.status(500).json({ error: "Failed to fetch hidden picks" });
    }

    const hiddenIds = new Set(
      (hiddenRows || []).map((r) => String(r.pick_id))
    );

    // 2) fetch picks
    const { data, error } = await supabase
      .from("picks")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error("❌ picks error:", error);
      return res.status(500).json({ error: "Failed to fetch picks" });
    }

    // 3) attach hidden flag
    let out = (data || []).map((p) => ({
      ...p,
      hidden: hiddenIds.has(String(p.id)),
    }));

    // 4) non-mods never see hidden picks
    if (!mod) {
      out = out.filter((p) => !p.hidden);
    }

    res.json(out);
  } catch (err) {
    console.error("❌ /picks crash:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================================================
// MOD: HIDE A PICK (soft delete)
// ==================================================
app.post("/admin/hide", modLimiter, requireMod, async (req, res) => {
  try {
    const id = req.body?.id;
    const reason = String(req.body?.reason || "").slice(0, 300);

    if (!id) {
      return res.status(400).json({ error: "Missing pick id" });
    }

    const pickId = Number(id);
    if (!Number.isFinite(pickId)) {
      return res.status(400).json({ error: "Invalid pick id" });
    }

    const { error } = await supabase
      .from("hidden_picks")
      .upsert({
        pick_id: pickId,
        hidden_by: "mod",
        reason,
      });

    if (error) {
      console.error("❌ hide error:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /admin/hide crash:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================================================
// MOD: UNHIDE A PICK
// ==================================================
app.post("/admin/unhide", modLimiter, requireMod, async (req, res) => {
  try {
    const id = req.body?.id;
    if (!id) {
      return res.status(400).json({ error: "Missing pick id" });
    }

    const pickId = Number(id);
    if (!Number.isFinite(pickId)) {
      return res.status(400).json({ error: "Invalid pick id" });
    }

    const { error } = await supabase
      .from("hidden_picks")
      .delete()
      .eq("pick_id", pickId);

    if (error) {
      console.error("❌ unhide error:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /admin/unhide crash:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================================================
// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "Capper API running" });
});

// Receive picks from Discord bot
app.post("/picks", ingestLimiter, requireIngest, async (req, res) => {

  const pick = req.body;

  console.log("📥 New pick received:", pick);

  const { error } = await supabase.from("picks").insert({
    channel_id: pick.channelId,
    channel_name: pick.channelName,
    author_id: pick.authorId,
    author_name: pick.authorName,
    content: pick.content,
    attachments: pick.attachments,
    embeds: pick.embeds,
    created_at: pick.createdAt
      ? new Date(pick.createdAt).toISOString()
      : null,
  });

  if (error) {
    console.error("❌ Supabase insert error:", error);
    return res.status(500).json({ success: false });
  }

  res.json({ success: true });
});

app.listen(PORT, () => {

  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
