"use strict";

require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const path = require("path");

// ─── Validate required env vars ───────────────────────────────────────────────
const required = [
  "DATABASE_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "NOTIFY_EMAIL",
  "ADMIN_TOKEN",
];
for (const key of required) {
  if (!process.env[key]) {
    console.error(
      `[FATAL] Missing env var: ${key}. Copy .env.example to .env and fill it in.`,
    );
    process.exit(1);
  }
}

// ─── DB ───────────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on("error", (err) => {
  console.error("[DB] Unexpected error on idle client:", err.message);
});

// ─── Mailer ───────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((err) => {
  if (err) console.error("[MAIL] SMTP connection failed:", err.message);
  else console.log("[MAIL] SMTP ready ✓");
});

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Validation helpers ────────────────────────────────────────────────────────
function isValidEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) &&
    email.length <= 254
  );
}

function isValidPhone(phone) {
  return (
    typeof phone === "string" && /^\+?[\d\s\-().]{7,30}$/.test(phone.trim())
  );
}

// ─── POST /api/signup ─────────────────────────────────────────────────────────
app.post("/api/signup", async (req, res) => {
  const { name, phone, email } = req.body;

  // Name is required
  const sanitizedName = name ? String(name).slice(0, 100).trim() : "";
  if (!sanitizedName) {
    return res.status(400).json({ error: "Name is required." });
  }

  // Phone is required
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({ error: "A valid phone number is required." });
  }
  const sanitizedPhone = String(phone).slice(0, 30).trim();

  // Email is optional — validate only if provided
  let sanitizedEmail = null;
  if (email) {
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    sanitizedEmail = email.toLowerCase().trim();
  }

  try {
    // Deduplicate by phone to avoid double-signups
    const result = await pool.query(
      `INSERT INTO signups (name, phone, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO NOTHING
       RETURNING id`,
      [sanitizedName, sanitizedPhone, sanitizedEmail],
    );

    // Already registered — silently succeed (don't leak existence)
    if (result.rowCount === 0) {
      return res.json({ success: true });
    }

    // Fetch running total for the notification
    let totalCount = "?";
    try {
      const c = await pool.query("SELECT COUNT(*) AS n FROM signups");
      totalCount = c.rows[0].n;
    } catch (_) {}

    const now = new Date();
    const dateStr = now.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    const timeStr = now.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const appUrl =
      process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

    // Send notification — non-blocking: never fail the user request because of mail
    transporter
      .sendMail({
        from: `"CornRoad" <${process.env.SMTP_USER}>`,
        to: process.env.NOTIFY_EMAIL,
        subject: `🪢 New signup — ${sanitizedName} (#${totalCount})`,
        text: [
          `New CornRoad waitlist signup`,
          ``,
          `Name  : ${sanitizedName}`,
          `Phone : ${sanitizedPhone}`,
          `Email : ${sanitizedEmail || "(not provided)"}`,
          `Date  : ${dateStr} at ${timeStr}`,
          `Total : ${totalCount} signups`,
          ``,
          `Admin : ${appUrl}/admin.html`,
        ].join("\n"),
        html: `
          <div style="font-family:sans-serif;max-width:480px;color:#0d0d0b;">
            <h2 style="font-family:Georgia,serif;color:#c4622d;margin-bottom:4px;">
              🪢 New CornRoad signup
            </h2>
            <p style="color:#7a7a72;font-size:12px;margin-top:0;">${dateStr} &bull; ${timeStr}</p>
            <table style="border-collapse:collapse;width:100%;margin-top:16px;">
              <tr><td style="padding:8px 12px;background:#f2eee8;font-weight:600;width:80px;">Name</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #e0d8cc;">${sanitizedName}</td></tr>
              <tr><td style="padding:8px 12px;background:#f2eee8;font-weight:600;">Phone</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #e0d8cc;">${sanitizedPhone}</td></tr>
              <tr><td style="padding:8px 12px;background:#f2eee8;font-weight:600;">Email</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #e0d8cc;">${sanitizedEmail || "<em>not provided</em>"}</td></tr>
            </table>
            <p style="margin-top:16px;color:#7a7a72;font-size:12px;">
              Total signups: <strong>${totalCount}</strong> &bull;
              <a href="${appUrl}/admin.html" style="color:#c4622d;">View admin panel</a>
            </p>
          </div>`,
      })
      .catch((err) =>
        console.error("[MAIL] Notification failed:", err.message),
      );

    return res.json({ success: true });
  } catch (err) {
    console.error("[DB] Signup error:", err.message);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
});

// ─── GET /api/admin/signups ────────────────────────────────────────────────────
app.get("/api/admin/signups", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const result = await pool.query(
      "SELECT id, name, phone, email, source, created_at FROM signups ORDER BY created_at DESC",
    );
    return res.json({ signups: result.rows });
  } catch (err) {
    console.error("[DB] List error:", err.message);
    return res.status(500).json({ error: "Server error." });
  }
});

// ─── DELETE /api/admin/signups/:id ────────────────────────────────────────────
app.delete("/api/admin/signups/:id", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid ID." });
  }

  try {
    await pool.query("DELETE FROM signups WHERE id = $1", [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("[DB] Delete error:", err.message);
    return res.status(500).json({ error: "Server error." });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[CornRoad] Server running → http://localhost:${PORT}`);
  console.log(`[CornRoad] Admin panel   → http://localhost:${PORT}/admin.html`);
});
