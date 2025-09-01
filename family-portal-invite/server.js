// server.js - Family Portal backend (Express + SQLite + OpenAI)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import { OpenAI } from "openai";

import db from "./db.js";
import { signToken, verifyToken, setAuthCookie, clearAuthCookie } from "./auth.js";

dotenv.config();
const {
  PORT = 3000,
  OPENAI_API_KEY = "",
  OPENAI_MODEL = "gpt-4o-mini",
  SYSTEM_PROMPT = "你是“家人小助手”，用简洁友善的中文回答。",
  ALLOW_REGISTRATION = "true",
  MAX_REQUESTS_PER_DAY = "200",
  MAX_TOKENS_PER_DAY = "50000"
} = process.env;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static("public"));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

// ---- Rate limit by IP (coarse) ----
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 req/min/IP
  standardHeaders: true,
  legacyHeaders: false,
}));

// ---- Helpers ----
function now() { return Math.floor(Date.now() / 1000); }
function todayKey() { return new Date().toISOString().slice(0,10); }

function authRequired(req, res, next) {
  const token = req.cookies?.token;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.id);
  if (!user || user.disabled) return res.status(401).json({ error: "Unauthorized" });
  req.user = { id: user.id, role: user.role, name: user.name, email: user.email };
  next();
}

function adminRequired(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  next();
}

function upsertDailyUsage(userId, addReq, addPrompt, addCompletion, addTotal) {
  const dateKey = todayKey();
  const existing = db.prepare("SELECT * FROM usage_logs WHERE user_id=? AND date_key=?").get(userId, dateKey);
  if (!existing) {
    db.prepare("INSERT INTO usage_logs (user_id, date_key, requests, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(userId, dateKey, addReq, addPrompt, addCompletion, addTotal, now());
  } else {
    db.prepare("UPDATE usage_logs SET requests = requests + ?, prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, total_tokens = total_tokens + ? WHERE user_id = ? AND date_key = ?")
      .run(addReq, addPrompt, addCompletion, addTotal, userId, dateKey);
  }
}

function getDailyUsage(userId) {
  const dateKey = todayKey();
  const row = db.prepare("SELECT * FROM usage_logs WHERE user_id=? AND date_key=?").get(userId, dateKey);
  return row || { requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
}

// ---- Invite helpers ----
function validInvite(code) {
  if (!code) return { ok:false, reason: "缺少邀请码" };
  const row = db.prepare("SELECT * FROM invites WHERE code=?").get(code);
  if (!row) return { ok:false, reason: "邀请码不存在" };
  if (!row.active) return { ok:false, reason: "邀请码已被吊销" };
  if (row.expires_at && row.expires_at < Math.floor(Date.now()/1000)) return { ok:false, reason: "邀请码已过期" };
  if (row.used_count >= row.max_uses) return { ok:false, reason: "邀请码使用次数已用尽" };
  return { ok:true, invite: row };
}
function consumeInvite(code) {
  db.prepare("UPDATE invites SET used_count = used_count + 1 WHERE code=?").run(code);
}
// ---- Auth routes ----
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, name, password, invite } = req.body || {};
    if (!email || !name || !password) return res.status(400).json({ error: "缺少字段" });

    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) return res.status(400).json({ error: "邮箱已存在" });

    const hash = await bcrypt.hash(password, 10);
    const isFirstUser = db.prepare("SELECT COUNT(*) as c FROM users").get().c === 0;
    const role = isFirstUser ? "admin" : "member";
    if (!isFirstUser && ALLOW_REGISTRATION !== "true") {
      return res.status(403).json({ error: "当前不允许自行注册" });
    }

    const info = db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(email, name, hash, role, now());
        if (!isFirstUser && invite) { consumeInvite(invite); }

    const user = { id: info.lastInsertRowid, email, name, role };

    const token = signToken({ id: user.id, role: user.role });
    setAuthCookie(res, token);
    res.json({ user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "注册失败" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "缺少字段" });
    const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if (!user || user.disabled) return res.status(401).json({ error: "账号不存在或已禁用" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "密码错误" });
    const token = signToken({ id: user.id, role: user.role });
    setAuthCookie(res, token);
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "登录失败" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: req.user, usage: getDailyUsage(req.user.id) });
});

// ---- Admin ----
app.get("/api/users", authRequired, adminRequired, (req, res) => {
  const list = db.prepare("SELECT id, email, name, role, disabled, created_at FROM users ORDER BY id DESC").all();
  res.json({ users: list });
});

app.patch("/api/users/:id", authRequired, adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  const { role, disabled, resetPassword } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!u) return res.status(404).json({ error: "用户不存在" });

  if (typeof role === "string") {
    db.prepare("UPDATE users SET role=? WHERE id=?").run(role, id);
  }
  if (typeof disabled === "boolean") {
    db.prepare("UPDATE users SET disabled=? WHERE id=?").run(disabled ? 1 : 0, id);
  }
  if (resetPassword) {
    const hash = await bcrypt.hash(resetPassword, 10);
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, id);
  }
  res.json({ ok: true });
});

// ---- Chats ----
app.get("/api/history", authRequired, (req, res) => {
  const chats = db.prepare("SELECT id, title, created_at FROM chats WHERE user_id=? ORDER BY created_at DESC").all(req.user.id);
  res.json({ chats });
});

app.get("/api/history/:id", authRequired, (req, res) => {
  const chatId = req.params.id;
  const chat = db.prepare("SELECT * FROM chats WHERE id=? AND user_id=?").get(chatId, req.user.id);
  if (!chat) return res.status(404).json({ error: "未找到会话" });
  const messages = db.prepare("SELECT role, content, created_at FROM messages WHERE chat_id=? ORDER BY id ASC").all(chatId);
  res.json({ chat: { id: chat.id, title: chat.title, created_at: chat.created_at }, messages });
});

app.post("/api/history/:id/rename", authRequired, (req, res) => {
  const chatId = req.params.id;
  const { title } = req.body || {};
  const chat = db.prepare("SELECT * FROM chats WHERE id=? AND user_id=?").get(chatId, req.user.id);
  if (!chat) return res.status(404).json({ error: "未找到会话" });
  db.prepare("UPDATE chats SET title=? WHERE id=?").run(title || "未命名会话", chatId);
  res.json({ ok: true });
});

app.delete("/api/history/:id", authRequired, (req, res) => {
  const chatId = req.params.id;
  db.prepare("DELETE FROM chats WHERE id=? AND user_id=?").run(chatId, req.user.id);
  res.json({ ok: true });
});

// ---- Chat endpoint (non-stream) ----
app.post("/api/chat", authRequired, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "后端未配置 OPENAI_API_KEY" });
    const { messages, chatId, model } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages 必须是数组" });

    // Quota check
    const usage = getDailyUsage(req.user.id);
    if (usage.requests >= Number(MAX_REQUESTS_PER_DAY)) {
      return res.status(429).json({ error: "已达今日请求上限，请明日再试" });
    }
    if (usage.total_tokens >= Number(MAX_TOKENS_PER_DAY)) {
      return res.status(429).json({ error: "已达今日 token 上限，请明日再试" });
    }

    // Ensure chat row
    let cid = chatId;
    if (!cid) {
      cid = nanoid();
      db.prepare("INSERT INTO chats (id, user_id, title, created_at) VALUES (?, ?, ?, ?)")
        .run(cid, req.user.id, (messages[0]?.content || "新会话").slice(0, 30), now());
    }

    // Persist user messages
    const insertMsg = db.prepare("INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)");
    for (const m of messages) {
      if (m.role === "user") {
        insertMsg.run(cid, "user", String(m.content).slice(0, 8000), now());
      }
    }

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: model || OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
      ],
      temperature: 0.6
    });
    const text = completion.choices?.[0]?.message?.content || "";

    // Save assistant message
    insertMsg.run(cid, "assistant", text, now());

    // Log usage
    const u = completion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    upsertDailyUsage(req.user.id, 1, u.prompt_tokens||0, u.completion_tokens||0, u.total_tokens||0);

    res.json({ reply: text, chatId: cid, usage: u });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "对话失败：" + (e?.message || e) });
  }
});


// ---- Invite admin ----
app.get("/api/invites", authRequired, adminRequired, (req, res) => {
  const list = db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all();
  res.json({ invites: list });
});

app.post("/api/invites", authRequired, adminRequired, (req, res) => {
  const { note, maxUses = 1, expiresInDays = 7 } = req.body || {};
  const id = nanoid();
  const code = nanoid();
  const created_at = now();
  const expires_at = expiresInDays ? (created_at + expiresInDays*24*3600) : null;
  db.prepare("INSERT INTO invites (id, code, note, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, code, note || null, req.user.id, created_at, expires_at, Number(maxUses));
  res.json({ id, code });
});

app.post("/api/invites/:code/revoke", authRequired, adminRequired, (req, res) => {
  const code = req.params.code;
  const row = db.prepare("SELECT * FROM invites WHERE code=?").get(code);
  if (!row) return res.status(404).json({ error: "邀请码不存在" });
  db.prepare("UPDATE invites SET active=0 WHERE code=?").run(code);
  res.json({ ok: true });
});


// ---- Start ----
app.listen(Number(PORT), () => {
  console.log(`✅ Family Portal running at http://localhost:${PORT}`);
});
