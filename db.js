const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ─── JADVALLAR (Schema'lar) ────────────────────────────────
const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS admin_chats (
    chat_id     TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    type        TEXT DEFAULT 'unknown',
    owner_id    BIGINT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS users (
    user_id       BIGINT PRIMARY KEY,
    first_name    TEXT DEFAULT '',
    username      TEXT,
    last_activity TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS posts (
    id            SERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL,
    text          TEXT,
    photo_file_id TEXT,
    video_file_id TEXT,
    buttons       JSONB DEFAULT '[]'::jsonb,
    target_chat   TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );
`;

// ─── ULANISH ───────────────────────────────────────────────
async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL .env faylda topilmadi!");
  }
  await pool.query(CREATE_TABLES);
  console.log("✔ PostgreSQL ulanishi muvaffaqiyatli!");
  console.log("🗄 PostgreSQL jadvallar tayyor!");
}

// ─── ADMIN CHATS ───────────────────────────────────────────
async function getAllAdminChats(ownerId) {
  const query = ownerId
    ? "SELECT chat_id, title, type, owner_id FROM admin_chats WHERE owner_id = $1"
    : "SELECT chat_id, title, type, owner_id FROM admin_chats";
  const params = ownerId ? [ownerId] : [];
  const { rows } = await pool.query(query, params);
  return rows.map((d) => ({
    id: d.chat_id,
    title: d.title,
    type: d.type || "unknown",
    owner_id: d.owner_id || null,
  }));
}

async function getAdminChatById(chatId) {
  const { rows } = await pool.query(
    "SELECT chat_id, title, type, owner_id FROM admin_chats WHERE chat_id = $1",
    [String(chatId)]
  );
  if (!rows.length) return null;
  return {
    id: rows[0].chat_id,
    title: rows[0].title,
    type: rows[0].type,
    owner_id: rows[0].owner_id || null,
  };
}

async function addAdminChat(chatId, title, type, ownerId) {
  await pool.query(
    `INSERT INTO admin_chats (chat_id, title, type, owner_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id) DO UPDATE SET
       title     = EXCLUDED.title,
       type      = EXCLUDED.type,
       owner_id  = COALESCE(EXCLUDED.owner_id, admin_chats.owner_id)`,
    [String(chatId), title, type, ownerId ?? null]
  );
}

async function setChatOwner(chatId, ownerId) {
  await pool.query(
    "UPDATE admin_chats SET owner_id = $2 WHERE chat_id = $1",
    [String(chatId), ownerId]
  );
}

async function removeAdminChat(chatId, ownerId) {
  const query = ownerId != null
    ? "DELETE FROM admin_chats WHERE chat_id = $1 AND owner_id = $2"
    : "DELETE FROM admin_chats WHERE chat_id = $1";
  const params = ownerId != null ? [String(chatId), ownerId] : [String(chatId)];
  await pool.query(query, params);
}

async function getAllChatsForUser(userId) {
  const { rows } = await pool.query(
    "SELECT chat_id, title, type, owner_id FROM admin_chats WHERE owner_id = $1",
    [userId]
  );
  return rows.map((d) => ({
    id: d.chat_id,
    title: d.title,
    type: d.type || "unknown",
    owner_id: d.owner_id,
  }));
}

// ─── USERS ─────────────────────────────────────────────────
async function getUserById(userId) {
  const { rows } = await pool.query(
    "SELECT user_id, first_name, username, last_activity FROM users WHERE user_id = $1",
    [Number(userId)]
  );
  return rows[0] || null;
}

async function countUsers() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  return rows[0].count;
}

async function countPosts() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM posts");
  return rows[0].count;
}

async function upsertUser(user) {
  await pool.query(
    `INSERT INTO users (user_id, first_name, username, last_activity)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       first_name    = EXCLUDED.first_name,
       username      = EXCLUDED.username,
       last_activity = NOW()`,
    [user.id, user.first_name || "", user.username || null]
  );
  // 30 kundan ko'p harakatsiz foydalanuvchilarni tozalash
  pool
    .query(`DELETE FROM users WHERE last_activity < NOW() - INTERVAL '30 days'`)
    .catch(() => {});
}

async function savePost({ userId, text, photoFileId, videoFileId, buttons, targetChat }) {
  const { rows } = await pool.query(
    `INSERT INTO posts (user_id, text, photo_file_id, video_file_id, buttons, target_chat)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [userId, text || null, photoFileId || null, videoFileId || null, JSON.stringify(buttons || []), targetChat || null]
  );
  return { id: rows[0].id, created_at: rows[0].created_at };
}

// ─── YAKUNIY CLOSE ─────────────────────────────────────────
async function close() {
  await pool.end();
}

module.exports = {
  pool,
  close,
  initDatabase,
  getAllAdminChats,
  getAdminChatById,
  addAdminChat,
  setChatOwner,
  removeAdminChat,
  getAllChatsForUser,
  getUserById,
  countUsers,
  countPosts,
  upsertUser,
  savePost,
};