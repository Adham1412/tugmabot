require("dotenv").config();
// Atlas SRV lookup may fail with the local DNS resolver in some environments.
const dnsServers = (process.env.MONGODB_DNS_SERVERS || "")
  .split(",")
  .map((server) => server.trim())
  .filter(Boolean);
if (dnsServers.length) require("node:dns").setServers(dnsServers);

const { MongoClient } = require("mongodb");

let client;
let database;

function collection(name) {
  if (!database) {
    throw new Error("MongoDB bazasi hali ulanmagan.");
  }
  return database.collection(name);
}

async function initDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI .env faylda topilmadi!");
  }

  client = new MongoClient(uri);
  await client.connect();
  database = client.db(process.env.MONGODB_DATABASE || "tugmali_bot");

  await Promise.all([
    collection("admin_chats").createIndex({ chat_id: 1 }, { unique: true }),
    collection("users").createIndex({ user_id: 1 }, { unique: true }),
  ]);

  console.log("✔ MongoDB ulanishi muvaffaqiyatli!");
  console.log("🗄 MongoDB kolleksiyalari tayyor!");
}

async function getAllAdminChats(ownerId) {
  const filter = ownerId != null ? { owner_id: ownerId } : {};
  const rows = await collection("admin_chats")
    .find(filter, { projection: { _id: 0, chat_id: 1, title: 1, type: 1, owner_id: 1 } })
    .toArray();
  return rows.map((chat) => ({
    id: chat.chat_id,
    title: chat.title,
    type: chat.type || "unknown",
    owner_id: chat.owner_id || null,
  }));
}

async function getAdminChatById(chatId) {
  const chat = await collection("admin_chats").findOne(
    { chat_id: String(chatId) },
    { projection: { _id: 0, chat_id: 1, title: 1, type: 1, owner_id: 1 } }
  );
  if (!chat) return null;
  return {
    id: chat.chat_id,
    title: chat.title,
    type: chat.type,
    owner_id: chat.owner_id || null,
  };
}

async function addAdminChat(chatId, title, type, ownerId) {
  const update = {
    $set: { title, type },
    $setOnInsert: { chat_id: String(chatId), created_at: new Date() },
  };
  if (ownerId != null) {
    update.$set.owner_id = ownerId;
  }
  await collection("admin_chats").updateOne(
    { chat_id: String(chatId) },
    update,
    { upsert: true }
  );
}

async function setChatOwner(chatId, ownerId) {
  await collection("admin_chats").updateOne(
    { chat_id: String(chatId) },
    { $set: { owner_id: ownerId } }
  );
}

async function removeAdminChat(chatId, ownerId) {
  const filter = { chat_id: String(chatId) };
  if (ownerId != null) {
    filter.owner_id = ownerId;
  }
  await collection("admin_chats").deleteOne(filter);
}

async function getAllChatsForUser(userId) {
  const rows = await collection("admin_chats")
    .find(
      { owner_id: userId },
      { projection: { _id: 0, chat_id: 1, title: 1, type: 1, owner_id: 1 } }
    )
    .toArray();
  return rows.map((chat) => ({
    id: chat.chat_id,
    title: chat.title,
    type: chat.type || "unknown",
    owner_id: chat.owner_id,
  }));
}

async function getUserById(userId) {
  const user = await collection("users").findOne(
    { user_id: Number(userId) },
    { projection: { _id: 0, user_id: 1, first_name: 1, username: 1, last_activity: 1 } }
  );
  return user || null;
}

async function countUsers() {
  return collection("users").countDocuments();
}

async function countPosts() {
  return collection("posts").countDocuments();
}

async function upsertUser(user) {
  await collection("users").updateOne(
    { user_id: Number(user.id) },
    {
      $set: {
        first_name: user.first_name || "",
        username: user.username || null,
        last_activity: new Date(),
      },
    },
    { upsert: true }
  );
  await collection("users").deleteMany({
    last_activity: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
  });
}

async function savePost({ userId, text, photoFileId, videoFileId, buttons, targetChat }) {
  const createdAt = new Date();
  const result = await collection("posts").insertOne({
    user_id: Number(userId),
    text: text || null,
    photo_file_id: photoFileId || null,
    video_file_id: videoFileId || null,
    buttons: buttons || [],
    target_chat: targetChat || null,
    created_at: createdAt,
  });
  return { id: result.insertedId, created_at: createdAt };
}

async function close() {
  if (client) {
    await client.close();
    client = undefined;
    database = undefined;
  }
}

module.exports = {
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
