const mongoose = require("mongoose");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI;

// ─── JADVALLAR (Schema'lar) ────────────────────────────────
const adminChatSchema = new mongoose.Schema(
  {
    chat_id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    type: { type: String, default: "unknown" },
    owner_id: { type: Number, default: null },
    created_at: { type: Date, default: Date.now },
  },
  { collection: "admin_chats" }
);

const userSchema = new mongoose.Schema(
  {
    user_id: { type: Number, required: true, unique: true },
    first_name: { type: String, default: "" },
    username: { type: String, default: null },
    last_activity: { type: Date, default: Date.now },
  },
  { collection: "users" }
);

const postSchema = new mongoose.Schema(
  {
    user_id: { type: Number, required: true },
    text: { type: String, default: null },
    photo_file_id: { type: String, default: null },
    video_file_id: { type: String, default: null },
    buttons: { type: [mongoose.Schema.Types.Mixed], default: [] },
    target_chat: { type: String, default: null },
    created_at: { type: Date, default: Date.now },
  },
  { collection: "posts" }
);

const AdminChat = mongoose.model("AdminChat", adminChatSchema);
const User = mongoose.model("User", userSchema);
const Post = mongoose.model("Post", postSchema);

// ─── ULANISH ───────────────────────────────────────────────
async function initDatabase() {
  if (!MONGO_URI) {
    throw new Error("MONGO_URI .env faylda topilmadi!");
  }
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    replicaSet: "atlas-bnq0tc-shard-0",
  });
  console.log("✔ MongoDB Atlas ulanishi muvaffaqiyatli!");
  await AdminChat.init();
  await User.init();
  await Post.init();
  console.log("🗄 MongoDB collection'lar tayyor!");
}

// ─── ADMIN CHATS ───────────────────────────────────────────
async function getAllAdminChats(ownerId) {
  const filter = ownerId ? { owner_id: ownerId } : {};
  const docs = await AdminChat.find(filter).lean();
  return docs.map((d) => ({
    id: d.chat_id,
    title: d.title,
    type: d.type || "unknown",
    owner_id: d.owner_id || null,
  }));
}

async function getAdminChatById(chatId) {
  const d = await AdminChat.findOne({ chat_id: String(chatId) }).lean();
  if (!d) return null;
  return { id: d.chat_id, title: d.title, type: d.type, owner_id: d.owner_id || null };
}

async function addAdminChat(chatId, title, type, ownerId) {
  const filter = { chat_id: String(chatId) };
  const update = { title, type };
  if (ownerId != null) update.owner_id = ownerId;
  await AdminChat.findOneAndUpdate(filter, update, { upsert: true, setDefaultsOnInsert: true });
}

async function setChatOwner(chatId, ownerId) {
  await AdminChat.updateOne({ chat_id: String(chatId) }, { owner_id: ownerId });
}

async function removeAdminChat(chatId, ownerId) {
  const filter = { chat_id: String(chatId) };
  if (ownerId != null) filter.owner_id = ownerId;
  await AdminChat.deleteOne(filter);
}

async function getAllChatsForUser(userId) {
  const docs = await AdminChat.find({ owner_id: userId }).lean();
  return docs.map((d) => ({
    id: d.chat_id,
    title: d.title,
    type: d.type || "unknown",
    owner_id: d.owner_id,
  }));
}

// ─── USERS ─────────────────────────────────────────────────
async function getUserById(userId) {
  return User.findOne({ user_id: Number(userId) }).lean();
}

async function countUsers() {
  return User.countDocuments().lean();
}

async function countPosts() {
  return Post.countDocuments().lean();
}

async function upsertUser(user) {
  await User.findOneAndUpdate(
    { user_id: user.id },
    {
      first_name: user.first_name || "",
      username: user.username || null,
      last_activity: Date.now(),
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
  // 30 kundan ko'p harakatsiz foydalanuvchilarni tozalash
  User.deleteMany({ last_activity: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } })
    .catch(() => {});
}

// ─── POSTS ─────────────────────────────────────────────────
async function savePost({ userId, text, photoFileId, videoFileId, buttons, targetChat }) {
  const post = new Post({
    user_id: userId,
    text: text || null,
    photo_file_id: photoFileId || null,
    video_file_id: videoFileId || null,
    buttons: buttons || [],
    target_chat: targetChat || null,
  });
  await post.save();
  return { id: post._id.toString(), created_at: post.created_at };
}

module.exports = {
  mongoose,
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
  AdminChat,
  User,
  Post,
};