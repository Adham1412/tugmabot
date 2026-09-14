const { Telegraf, Markup } = require("telegraf");
require("dotenv").config();
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN .env faylda topilmadi! .env faylga BOT_TOKEN qo'shing.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ─── ADMIN (faqat statistika uchun) ─────────────────────────
const ADMIN_IDS = new Set(
  (process.env.ADMIN_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function isAdmin(userId) {
  return ADMIN_IDS.has(String(userId));
}

// ─── SESSIYA — har bir foydalanuvchi uchun alohida ─────────
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      step: null,
      postText: null,
      postPhoto: null,
      postVideo: null,
      buttons: [],
      currentButton: {},
      totalButtons: 0,
      targetChat: null,
      targetTitle: null,
      editingIndex: null,
      selectedTargets: [],
    });
  }
  return sessions.get(userId);
}

function resetSession(userId) {
  sessions.set(userId, {
    step: null,
    postText: null,
    postPhoto: null,
    postVideo: null,
    buttons: [],
    currentButton: {},
    totalButtons: 0,
    targetChat: null,
    targetTitle: null,
    editingIndex: null,
    selectedTargets: [],
  });
}

// ─── RANGLAR (Telegram native style) ───────────────────────
const COLORS = {
  red:   { name: "Qizil",  style: "danger" },
  blue:  { name: "Ko'k",   style: "primary" },
  green: { name: "Yashil", style: "success" },
};

// Tugma matni — emoji'siz, faqat rangli fon (style)
function buildKeyboard(buttons) {
  return buttons.map((b) => {
    const style = b.color ? COLORS[b.color]?.style : undefined;
    if (b.url) {
      const btn = { text: b.text, url: b.url };
      if (style) btn.style = style;
      return [btn];
    }
    const btn = { text: b.text, callback_data: "noop_" + b.text.slice(0, 30) };
    if (style) btn.style = style;
    return [btn];
  });
}

function buttonsSummary(buttons) {
  if (!buttons.length) return "  (yo'q)";
  return buttons
    .map((b, i) => {
      const emoji = b.color ? { red: "🔴", blue: "🔵", green: "🟢" }[b.color] || "" : "⬜️";
      const c = b.color ? COLORS[b.color]?.name + " rang" : "Rangsiz";
      const urlInfo = b.url ? `\n     🔗 Havola: ${b.url}` : "";
      return `  ${i + 1}. ${emoji} <b>${b.text}</b> (${c})${urlInfo}`;
    })
    .join("\n");
}

function actionsMenu(s) {
  const rows = [];
  if (s.buttons.length < s.totalButtons) {
    rows.push([Markup.button.callback(
      `🔘 Keyingi tugma (${s.buttons.length + 1}/${s.totalButtons})`, "next_btn"
    )]);
  }
  if (s.buttons.length > 0) {
    rows.push([Markup.button.callback("🗑 Oxirgisini olib tashlash", "undo_btn")]);
    rows.push([Markup.button.callback("👀 Ko'rib chiqish", "preview")]);
    rows.push([Markup.button.callback("📤 Kanalga yuborish", "send_to")]);
  }
  rows.push([Markup.button.callback("❌ Bekor qilish", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── MENU (rangsiz boshqaruv tugmalari) ────────────────────
function startMenu(ctx) {
  const rows = [
    [Markup.button.callback("✍️ Post yaratish", "cmd_post")],
    [Markup.button.callback("📋 Kanallarim", "cmd_channels")],
    [Markup.button.callback("📖 Yordam", "cmd_help")],
  ];
  if (isAdmin(ctx?.from?.id)) {
    rows.push([Markup.button.callback("📊 Statistika", "cmd_stats")]);
  }
  return Markup.inlineKeyboard(rows);
}

// Oldindan ko'rish va tahrirlash menyusi
function editMenu(s) {
  const rows = [];
  rows.push([Markup.button.callback("✏️ Matnni tahrirlash", "edit_text")]);
  if (s.buttons.length > 0) {
    rows.push([Markup.button.callback("🔘 Tugmalarni tahrirlash", "edit_buttons")]);
  }
  if (s.buttons.length < 10) {
    rows.push([Markup.button.callback("➕ Yangi tugma qo'shish", "next_btn")]);
  }
  if (s.buttons.length > 0) {
    rows.push([Markup.button.callback("🗑 Oxirgi tugmani o'chirish", "undo_btn")]);
    rows.push([Markup.button.callback("📤 Kanalga yuborish", "send_to")]);
  }
  rows.push([Markup.button.callback("❌ Bekor qilish", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function chatTypeName(type) {
  if (type === "channel") return "Kanal";
  if (type === "supergroup" || type === "group") return "Guruh";
  return "Noma'lum";
}

// ═══════════════════════════════════════════════════════════
//  Foydalanuvchi uchun kanallar ro'yxatini olish
// ═══════════════════════════════════════════════════════════
async function getUserChats(userId) {
  const rows = await db.getAllChatsForUser(userId);
  const chats = new Map();
  for (const r of rows) {
    chats.set(String(r.id), { title: r.title, type: r.type, id: r.id });
  }
  return chats;
}

// Egasiz (eski) kanallarni shu foydalanuvchimikinligini tekshirib bog'lash
async function claimOwnerlessChats(ctx) {
  try {
    const all = await db.getAllAdminChats();
    for (const c of all) {
      if (c.owner_id) continue;
      try {
        const m = await bot.telegram.getChatMember(c.id, ctx.from.id);
        if (m && (m.status === "administrator" || m.status === "creator")) {
          await db.setChatOwner(c.id, ctx.from.id);
          console.log(`Kanal egasi aniqlandi: ${c.title} → ${ctx.from.id}`);
        }
      } catch (e) {
        // Foydalanuvchi o'sha kanal a'zosi emas yoki xato — o'tkazib yuboramiz
      }
    }
  } catch (e) {
    console.error("Egasiz kanallarni tekshirishda xatolik:", e.message);
  }
}

// Yangi foydalanuvchi kelganida admin'e bildirishnoma yuborish
async function notifyAdminNewUser(ctx) {
  const from = ctx.from;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "—";
  const username = from.username ? "@" + from.username : "yo'q";
  const timeStr = new Date().toLocaleString("uz-Latn-UZ", {
    timeZone: "Asia/Tashkent",
    dateStyle: "short",
    timeStyle: "short",
  });

  const msg =
    `🆕 <b>Yangi foydalanuvchi!</b>\n\n` +
    `👤 Ism: <b>${escapeHtml(name)}</b>\n` +
    `🔗 Username: ${escapeHtml(username)}\n` +
    `🆔 ID: <code>${from.id}</code>\n` +
    `📅 Vaqt: ${escapeHtml(timeStr)}`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error("Admin bildirishnoma jo'natishda xatolik:", e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  /START — har bir yangi akkaunt o'z ID si bilan ro'yxatga
//  olinadi va faqat O'Z kanallarini ko'radi
// ═══════════════════════════════════════════════════════════
bot.start(async (ctx) => {
  resetSession(ctx.from.id);
  const isNewUser = !(await db.getUserById(ctx.from.id).catch(() => null));
  await db.upsertUser(ctx.from).catch(() => {});
  const name = ctx.from.first_name || "Foydalanuvchi";

  // Yangi foydalanuvchi bo'lsa admin'ga xabar ketadi
  if (isNewUser) await notifyAdminNewUser(ctx);

  // Bot admin bo'lgan kanallardan shu USER ga tegishlilarini bog'lash
  await claimOwnerlessChats(ctx);

  const chats = await getUserChats(ctx.from.id);

  let adminList = "";
  if (chats.size === 0) {
    adminList =
      "📭 Hozircha kanallaringiz yo'q.\n\n" +
      "➕ Botni o'z kanalingiz yoki guruhingizga admin qiling — bot avtomatik sezadi va sizning ro'yxatingizga qo'shib oladi.";
  } else {
    for (const [, chat] of chats) {
      adminList += `\n  • ${chat.title}`;
    }
    adminList += "\n\n👀 Ko'rish: \"Kanallarim\" tugmasi";
  }

  ctx.replyWithHTML(
    `👋 Salom, <b>${escapeHtml(name)}</b>! Bu bot bilan o'z kanal va guruhingizga rangli tugmali xabarlar yuboring. 🚀\n\n` +
    `📋 Sizning kanallaringiz:${adminList}`,
    startMenu(ctx)
  );
});

// Start tugmalari
bot.action("cmd_post", (ctx) => { ctx.answerCbQuery(); startPost(ctx); });
bot.action("cmd_channels", (ctx) => { ctx.answerCbQuery(); return showChannels(ctx); });
bot.action("cmd_help", (ctx) => { ctx.answerCbQuery(); return showHelp(ctx); });
bot.action("cmd_stats", (ctx) => { ctx.answerCbQuery(); return showStats(ctx); });

// ═══════════════════════════════════════════════════════════
//  /HELP
// ═══════════════════════════════════════════════════════════
function showHelp(ctx) {
  ctx.replyWithHTML(
    `📖 Qo'llanma\n\n` +
    `1️⃣ Botni o'z kanal yoki guruhingizga admin qiling.\n` +
    `   (Huquq: "Xabar yuborish" shart.) ⚙️\n\n` +
    `2️⃣ Post yaratish — "Post yaratish" tugmasini bosing. ✍️\n\n` +
    `3️⃣ Xabar matnini kiriting. 📝\n\n` +
    `4️⃣ Tugmalar sonini tanlang (1-10). 🔢\n\n` +
    `5️⃣ Har bir tugma uchun matn, havola (URL) va rang kiriting. 🎨\n\n` +
    `6️⃣ Kanalni tanlang va yuboring. 📤\n\n` +
    `🔒 Siz faqat o'z kanallaringizni ko'rasiz.`
  );
}

bot.help((ctx) => showHelp(ctx));

// ═══════════════════════════════════════════════════════════
//  /STATS — faqat admin uchun statistika
// ═══════════════════════════════════════════════════════════
async function showStats(ctx) {
  if (!isAdmin(ctx.from.id)) {
    return ctx.replyWithHTML("⛔ Bu bo'lim faqat admin uchun. 🔒", startMenu(ctx));
  }

  const totalUsers = await db.countUsers().catch(() => 0);
  const totalPosts = await db.countPosts().catch(() => 0);
  const chats = await db.getAllAdminChats().catch(() => []);

  const channels = chats.filter((c) => c.type === "channel");
  const groups = chats.filter((c) => c.type === "group" || c.type === "supergroup");

  let list = "";
  for (const c of chats) {
    let owner = "";
    if (c.owner_id) {
      const u = await db.getUserById(c.owner_id).catch(() => null);
      if (u && u.username) owner = ` (@${u.username})`;
    }
    list += `  • <b>${escapeHtml(c.title || c.id)}</b> — ${chatTypeName(c.type)}${owner}\n`;
  }
  if (!list) list = "  (bot hali hech qanday kanal/guruhga qo'shilmagan)";

  const msg =
    `📊 <b>Bot statistikasi</b>\n\n` +
    `👥 Foydalanuvchilar: <b>${totalUsers}</b> ta\n` +
    `📝 Yuborilgan postlar: <b>${totalPosts}</b> ta\n` +
    `📣 Kanallar: <b>${channels.length}</b> ta\n` +
    `👥 Guruhlar: <b>${groups.length}</b> ta\n\n` +
    `💬 <b>Bot o'rnatilgan chatlar:</b>\n${list}`;

  return ctx.replyWithHTML(msg, startMenu(ctx));
}

bot.command("stats", (ctx) => showStats(ctx));

// ═══════════════════════════════════════════════════════════
//  /CHANNELS — faqat o'z kanallari
// ═══════════════════════════════════════════════════════════
async function showChannels(ctx) {
  await claimOwnerlessChats(ctx);
  const chats = await getUserChats(ctx.from.id);

  if (chats.size === 0) {
    return ctx.replyWithHTML(
      `📭 Kanallaringiz hozircha yo'q.\n\n` +
      `Botni o'z kanal yoki guruhingizga admin qiling — bot uni avtomatik aniqlab, sizning ro'yxatingizga qo'shib oladi. ✅`,
      startMenu(ctx)
    );
  }

  let list = "";
  let i = 1;
  for (const [, chat] of chats) {
    list += `  ${i}. ${chat.title} (${chatTypeName(chat.type)})\n`;
    i++;
  }

  ctx.replyWithHTML(
    `📋 Sizning kanallaringiz:\n${list}\n\n` +
    `🔒 Boshqalar hech qanday ko'rmaydi — hamma ma'lumot faqat sizga.`,
    startMenu(ctx)
  );
}

bot.command("channels", (ctx) => showChannels(ctx));

// ═══════════════════════════════════════════════════════════
//  /POST
// ═══════════════════════════════════════════════════════════
function startPost(ctx) {
  resetSession(ctx.from.id);
  const s = getSession(ctx.from.id);
  s.step = "wait_text";
  ctx.replyWithHTML(
    `📝 Post matnini kiriting:\n\n` +
    `🅱️ Qalin matn: *so'z*, ✍️ Egri matn: _so'z_\n\n` +
    `🖼 Rasm, 🎬 video — izohsiz ham mumkin.`
  );
}

bot.command("post", (ctx) => startPost(ctx));

// ═══════════════════════════════════════════════════════════
//  RASM / VIDEO QABUL QILISH
// ═══════════════════════════════════════════════════════════
bot.on("photo", (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "wait_text") return;
  s.postPhoto = ctx.message.photo.pop().file_id;
  s.postVideo = null;
  s.postText = ctx.message.caption || null;
  ctx.replyWithHTML(
    s.postText
      ? `✅ Rasm qabul qilindi! 📷\n\n🔢 Endi tugmalar sonini tanlang:`
      : `✅ Rasm qabul qilindi, izohi yo'q. 📷\n\n🔢 Endi tugmalar sonini tanlang:`
  );
  askButtonCount(ctx);
});

bot.on("video", (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== "wait_text") return;
  s.postVideo = ctx.message.video.file_id;
  s.postPhoto = null;
  s.postText = ctx.message.caption || null;
  ctx.replyWithHTML(
    s.postText
      ? `✅ Video qabul qilindi! 🎬\n\n🔢 Endi tugmalar sonini tanlang:`
      : `✅ Video qabul qilindi, izohi yo'q. 🎬\n\n🔢 Endi tugmalar sonini tanlang:`
  );
  askButtonCount(ctx);
});

function askButtonCount(ctx) {
  const s = getSession(ctx.from.id);
  s.step = "wait_count";
  const numBtns = [];
  for (let i = 1; i <= 5; i++) numBtns.push([Markup.button.callback(`${i}`, `count:${i}`)]);
  for (let i = 6; i <= 10; i++) numBtns.push([Markup.button.callback(`${i}`, `count:${i}`)]);
  ctx.replyWithHTML(`🔢 Nechta tugma kerak?`, Markup.inlineKeyboard(numBtns));
}

bot.action(/^count:(\d+)$/, (ctx) => {
  ctx.answerCbQuery();
  const count = parseInt(ctx.match[1]);
  const s = getSession(ctx.from.id);
  if (s.step !== "wait_count") return;
  s.totalButtons = count;
  s.buttons = [];
  s.step = "wait_button_text";
  ctx.replyWithHTML(
    `✅ ${count} ta tugma yaratiladi.\n\n` +
    `🔘 1-tugma matnini kiriting:\n` +
    `Masalan: Batafsil, Obuna, Sotib olish`
  );
});

// ═══════════════════════════════════════════════════════════
//  MATN QABUL QILISH
// ═══════════════════════════════════════════════════════════
bot.on("text", (ctx) => {
  const text = ctx.message.text;
  const s = getSession(ctx.from.id);

  if (text === "/clear") {
    resetSession(ctx.from.id);
    return ctx.replyWithHTML(`🗑 Post yaratish to'xtatildi.`);
  }

  if (!s.step) return;

  if (s.step === "wait_text") {
    if (text.startsWith("/")) return;
    s.postText = text;
    askButtonCount(ctx);
    return;
  }

  // Matnni tahrirlash (skip = eski matn qoladi)
  if (s.step === "wait_edit_text") {
    if (text.toLowerCase() === "skip") {
      // eski matn qoladi
    } else {
      s.postText = text;
    }
    s.step = null;
    return showPreview(ctx, s);
  }

  // Tugma matnini tahrirlash
  if (s.step === "wait_edit_btn_text") {
    const b = s.buttons[s.editingIndex];
    if (!b) return ctx.replyWithHTML(`⚠️ Tugma topilmadi.`);
    if (text.toLowerCase() !== "skip") {
      b.text = text;
    }
    s.step = "wait_edit_btn_url";
    return ctx.replyWithHTML(
      `Tugma uchun havola (URL) kiriting:\n` +
      `Joriy: ${b.url || "(yo'q)"}\n` +
      `O'zgartirmaslik uchun: skip ⏭`
    );
  }

  // Tugma havolasini tahrirlash
  if (s.step === "wait_edit_btn_url") {
    const b = s.buttons[s.editingIndex];
    if (!b) return ctx.replyWithHTML(`⚠️ Tugma topilmadi.`);
    if (text.toLowerCase() !== "skip") {
      try {
        new URL(text);
        b.url = text;
      } catch {
        return ctx.replyWithHTML(`❌ Havola noto'g'ri. Qaytadan yoki skip deb yozing.`);
      }
    }
    s.step = "wait_edit_btn_color";
    return ctx.replyWithHTML(
      `🎨 "${escapeHtml(b.text)}" tugmasi rangini tanlang:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔴 Qizil", callback_data: "clr:red", style: "danger" }],
            [{ text: "🔵 Ko'k", callback_data: "clr:blue", style: "primary" }],
            [{ text: "🟢 Yashil", callback_data: "clr:green", style: "success" }],
            [{ text: "⬜️ Rangsiz", callback_data: "clr:none" }],
          ],
        },
      }
    );
  }

  if (s.step === "wait_button_text") {
    if (text.startsWith("/")) return;
    s.currentButton = { text };
    s.step = "wait_button_url";
    return ctx.replyWithHTML(
      `🔗 "${escapeHtml(text)}" tugmasi uchun havola (URL) kiriting:\n\n` +
      `Masalan: https://t.me/kanal_nomi 🌐\n` +
      `Havola kerak bo'lmasa: skip deb yozing. ⏭`
    );
  }

  if (s.step === "wait_button_url") {
    if (text.startsWith("/")) return;
    if (text.toLowerCase() === "skip") {
      s.currentButton.url = null;
    } else {
      try { new URL(text); s.currentButton.url = text; } catch {
        return ctx.replyWithHTML(`❌ Havola noto'g'ri. Qaytadan yoki skip deb yozing.`);
      }
    }
    s.step = "wait_button_color";
    ctx.replyWithHTML(
      `🎨 "${escapeHtml(s.currentButton.text)}" tugmasi rangini tanlang:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔴 Qizil", callback_data: "clr:red", style: "danger" }],
            [{ text: "🔵 Ko'k", callback_data: "clr:blue", style: "primary" }],
            [{ text: "🟢 Yashil", callback_data: "clr:green", style: "success" }],
            [{ text: "⬜️ Rangsiz", callback_data: "clr:none" }],
          ],
        },
      }
    );
  }

  if (s.step === "wait_chat_id") {
    if (text.startsWith("/")) return;
    s.targetChat = text.trim();
    s.targetTitle = text.trim();
    s.step = "confirm_send";
    showConfirm(ctx, s);
  }
});

// ═══════════════════════════════════════════════════════════
//  RANG TANLASH
// ═══════════════════════════════════════════════════════════
bot.action(/^clr:(.+)$/, (ctx) => {
  ctx.answerCbQuery();
  const colorKey = ctx.match[1];
  const s = getSession(ctx.from.id);
  const isEdit = s.step === "wait_edit_btn_color" && s.editingIndex != null;
  if (s.step !== "wait_button_color" && !isEdit) return;

  // Tahrirlash rejimida: mavjud tugmani yangilash
  if (isEdit) {
    const b = s.buttons[s.editingIndex];
    if (b) {
      b.color = colorKey === "none" ? null : colorKey;
    }
    s.editingIndex = null;
    s.step = null;
    return showPreview(ctx, s);
  }

  // Yangi tugma qo'shish
  s.currentButton.color = colorKey === "none" ? null : colorKey;
  s.buttons.push({ ...s.currentButton });
  s.currentButton = {};
  const done = s.buttons.length;
  const total = s.totalButtons;
  const last = s.buttons[s.buttons.length - 1];
  const colorLabel = last.color ? COLORS[last.color].name + " rang" : "Rangsiz";

  const msg =
    (done < total
      ? `✅ Tugma qo'shildi! (${done}/${total})\n\n` +
        `  📌 Matn: ${last.text}\n` +
        `  🎨 Rang: ${colorLabel}\n` +
        `  🔗 Havola: ${last.url || "(yo'q)"}\n\n` +
        `📋 Tugmalar (${done}/${total}):\n${buttonsSummary(s.buttons)}`
      : `🎉 Barcha ${total} ta tugma tayyor!\n\n` +
        `📋 Tugmalar:\n${buttonsSummary(s.buttons)}`);
  return ctx.replyWithHTML(msg, actionsMenu(s));
});

// ═══════════════════════════════════════════════════════════
//  TUGMA AMALLARI
// ═══════════════════════════════════════════════════════════
bot.action("next_btn", (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.buttons.length >= 10) {
    ctx.answerCbQuery("Maksimal 10 ta tugma");
    return;
  }
  ctx.answerCbQuery();
  // Kiritilgan son tugab qolsa ham qo'shishga ruxsat (tahrirlash rejimida)
  if (s.buttons.length >= s.totalButtons) s.totalButtons = s.buttons.length + 1;
  s.editingIndex = null;
  s.currentButton = {};
  s.step = "wait_button_text";
  ctx.replyWithHTML(`🔘 Tugma matnini kiriting (${s.buttons.length + 1}/${s.totalButtons}):`);
});

bot.action("undo_btn", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  if (!s.buttons.length) return ctx.replyWithHTML(`⚠️ Olib tashlash uchun tugma yo'q.`);
  const removed = s.buttons.pop();
  ctx.replyWithHTML(
    `🗑 "${escapeHtml(removed.text)}" olib tashlandi.\n\n` +
    (s.buttons.length > 0
      ? `📋 Qolgan tugmalar (${s.buttons.length}/${s.totalButtons}):\n${buttonsSummary(s.buttons)}`
      : `Hozircha tugmalar yo'q.`),
    actionsMenu(s)
  );
});

// Postni xuddi kanaldagi ko'rinishida ko'rsatadi + tahrirlash menyusi
async function showPreview(ctx, s) {
  if (s.buttons.length === 0) {
    return ctx.replyWithHTML(`⚠️ Avval kamida bitta tugma qo'shing.`);
  }
  const kb = buildKeyboard(s.buttons);
  s.step = null;

  // 1) Postni asl ko'rinishida yuboramiz (tugmalari bilan)
  if (s.postPhoto) {
    await ctx.replyWithPhoto(s.postPhoto, {
      caption: s.postText || "",
      parse_mode: "HTML",
      reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
    });
  } else if (s.postVideo) {
    await ctx.replyWithVideo(s.postVideo, {
      caption: s.postText || "",
      parse_mode: "HTML",
      reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
    });
  } else {
    const previewText = s.postText || "(matn yo'q)";
    await ctx.replyWithHTML(
      previewText,
      kb.length ? { reply_markup: { inline_keyboard: kb } } : undefined
    );
  }

  // 2) Tahrirlash menyusi (post ko'rinishining ostida emas, alohida yuqori xabar)
  return ctx.replyWithHTML(
    `👀 <b>Post shu ko'rinishda chiqadi.</b>\n\n` +
    `📝 Xabar:\n${escapeHtml(s.postText || "(matn yo'q)")}\n\n` +
    `🔘 Tugmalar (${s.buttons.length} ta):\n${buttonsSummary(s.buttons)}\n\n` +
    `Xatolik bo'lsa, quyidagi tugmalar bilan tahrirlang:`,
    editMenu(s)
  );
}

bot.action("preview", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  return showPreview(ctx, s);
});

// ─── MATNNI TAHRIRLASH ─────────────────────────────────────
bot.action("edit_text", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  s.step = "wait_edit_text";
  ctx.replyWithHTML(
    `📝 <b>Yangi post matnini kiriting:</b>\n\n` +
    `Joriy matn:\n${escapeHtml(s.postText || "(matn yo'q)")}\n\n` +
    `Eski matnni qoldirish uchun: skip`
  );
});

// ─── TUGMALARNI TAHRIRLASH ─────────────────────────────────
bot.action("edit_buttons", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  if (!s.buttons.length) {
    return ctx.replyWithHTML(`⚠️ Tahrirlash uchun tugma yo'q.`);
  }
  const rows = s.buttons.map((b, i) => [
    Markup.button.callback(`🔘 ${i + 1}. ${b.text}`, `edit_btn:${i}`),
  ]);
  rows.push([Markup.button.callback("🔙 Orqaga", "preview")]);
  ctx.replyWithHTML(
    `Qaysi tugmani tahrirlamoqchisiz?\n\n` +
    buttonsSummary(s.buttons),
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/^edit_btn:(\d+)$/, (ctx) => {
  ctx.answerCbQuery();
  const idx = parseInt(ctx.match[1]);
  const s = getSession(ctx.from.id);
  const b = s.buttons[idx];
  if (!b) return ctx.replyWithHTML(`⚠️ Tugma topilmadi.`);
  s.editingIndex = idx;
  s.step = "wait_edit_btn_text";
  ctx.replyWithHTML(
    `🔘 <b>${idx + 1}-tugmani tahrirlash</b>\n\n` +
    `Joriy matn: <b>${escapeHtml(b.text)}</b>\n\n` +
    `Yangi matn kiriting yoki skip deb yozing:`
  );
});

// ═══════════════════════════════════════════════════════════
//  YUBORISH — kanal/guruhlarni ko'p tanlash (checkbox)
// ═══════════════════════════════════════════════════════════
async function renderChatPicker(ctx) {
  await claimOwnerlessChats(ctx);
  const chats = await getUserChats(ctx.from.id);
  const s = getSession(ctx.from.id);

  if (chats.size === 0) {
    return ctx.replyWithHTML(
      `📭 Kanallaringiz topilmadi.\n\n` +
      `Botni o'z kanal yoki guruhingizga admin qilib, qaytadan bosing. ✅`,
      startMenu(ctx)
    );
  }

  const chatBtns = [];
  for (const [id, chat] of chats) {
    const checked = s.selectedTargets.includes(id);
    const mark = checked ? "✅" : "⬜️";
    chatBtns.push([
      Markup.button.callback(`${mark} ${chat.title}`, `toggle:${id}`),
    ]);
  }
  chatBtns.push([
    Markup.button.callback(
      s.selectedTargets.length === chats.size ? "🔄 Boshlang'ichaga qaytarish" : "✅ Hammasini tanlash",
      "select_all"
    ),
  ]);
  if (s.selectedTargets.length > 0) {
    chatBtns.push([Markup.button.callback(`📤 Yuborish (${s.selectedTargets.length})`, "confirm_review")]);
  }
  chatBtns.push([Markup.button.callback("🔙 Orqaga", "back_actions")]);

  // Nomlarni saqlaymiz (tasdiqlashda ko'rsatish uchun)
  s.targetTitleMap = {};
  for (const [, chat] of chats) s.targetTitleMap[chat.id] = chat.title;

  const list = Array.from(chats.values())
    .map((c) => (s.selectedTargets.includes(c.id) ? "  ✅" : "  ⬜️") + ` ${c.title}`)
    .join("\n");

  ctx.replyWithHTML(
    `📡 Yuborish uchun kanal yoki guruhlarni belgilang:\n\n${list}\n\n` +
    `Tanlanganlar: <b>${s.selectedTargets.length} ta</b>`,
    Markup.inlineKeyboard(chatBtns)
  );
}

bot.action("send_to", (ctx) => {
  ctx.answerCbQuery();
  return renderChatPicker(ctx);
});

// Belgilash / belgini olib tashlash
bot.action(/^toggle:(.+)$/, (ctx) => {
  ctx.answerCbQuery();
  const chatId = ctx.match[1];
  const s = getSession(ctx.from.id);
  const idx = s.selectedTargets.indexOf(chatId);
  if (idx >= 0) {
    s.selectedTargets.splice(idx, 1);
  } else {
    s.selectedTargets.push(chatId);
  }
  return renderChatPicker(ctx);
});

// Hammasini tanlash / olib tashlash
bot.action("select_all", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  getUserChats(ctx.from.id).then((chats) => {
    const allIds = [...chats.keys()];
    if (s.selectedTargets.length === allIds.length) {
      s.selectedTargets = [];
    } else {
      s.selectedTargets = allIds;
    }
    renderChatPicker(ctx);
  });
});

// Tanlanganlarga tasdiqlash oynasi
bot.action("confirm_review", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  if (!s.selectedTargets.length) {
    return ctx.replyWithHTML(`⚠️ Avval kanal yoki guruh tanlang.`);
  }
  showConfirm(ctx, s);
});

function showConfirm(ctx, s) {
  const targetIds = s.selectedTargets.length ? s.selectedTargets : (s.targetChat ? [s.targetChat] : []);
  const names = targetIds.length
    ? targetIds.map((id) => `  ✔️ ${s.targetTitleMap?.[id] || id}`).join("\n")
    : "  (tanlanmagan)";

  ctx.replyWithHTML(
    `📤 Yuborishni tasdiqlaysizmi?\n\n` +
    `📍 Manzil(lar):\n${names}\n\n` +
    `📝 Xabar:\n${escapeHtml(s.postText || "(matn yo'q)")}\n\n` +
    `🔘 Tugmalar (${s.buttons.length} ta):\n${buttonsSummary(s.buttons)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Ha, yuborish", "confirm_send")],
      [Markup.button.callback("🔙 Orqaga", "send_to")],
      [Markup.button.callback("❌ Bekor qilish", "cancel")],
    ])
  );
}

// Boshlang'ich holatga qaytarish (selchat orqali tanlangan bo'lsa ham)
bot.action("selchat_clear", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  s.selectedTargets = [];
  s.targetChat = null;
  return renderChatPicker(ctx);
});

bot.action("back_actions", (ctx) => {
  ctx.answerCbQuery();
  const s = getSession(ctx.from.id);
  ctx.replyWithHTML(
    `📋 Tugmalar (${s.buttons.length}/${s.totalButtons}):\n${buttonsSummary(s.buttons)}`,
    actionsMenu(s)
  );
});

// ═══════════════════════════════════════════════════════════
//  YUBORISH (TASDIQLASH)
// ═══════════════════════════════════════════════════════════
bot.action("confirm_send", async (ctx) => {
  const s = getSession(ctx.from.id);

  const targetIds = s.selectedTargets.length
    ? s.selectedTargets
    : (s.targetChat ? [s.targetChat] : []);

  if (targetIds.length === 0) {
    ctx.answerCbQuery("Manzil topilmadi!");
    return ctx.replyWithHTML(`⚠️ Manzil ko'rsatilmagan. Kanal tanlang.`);
  }
  if (!s.postText && !s.postPhoto && !s.postVideo) {
    ctx.answerCbQuery("Matn bo'sh!");
    return ctx.replyWithHTML(`⚠️ Xabar matni bo'sh. /post bilan qayta boshlang.`);
  }
  if (s.buttons.length === 0) {
    ctx.answerCbQuery("Tugmalar yo'q!");
    return ctx.replyWithHTML(`⚠️ Kamida 1 ta tugma kerak. /post bilan qayta boshlang.`);
  }

  const kb = buildKeyboard(s.buttons);
  const okList = [];
  const failList = [];

  ctx.answerCbQuery(`⏳ ${targetIds.length} ta manzilga yuborilmoqda...`);

  for (const chatId of targetIds) {
    try {
      if (s.postPhoto) {
        try { await bot.telegram.sendChatAction(chatId, "upload_photo"); } catch {}
        await bot.telegram.sendPhoto(chatId, s.postPhoto, {
          caption: s.postText || "",
          parse_mode: "HTML",
          reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
        });
      } else if (s.postVideo) {
        try { await bot.telegram.sendChatAction(chatId, "upload_video"); } catch {}
        await bot.telegram.sendVideo(chatId, s.postVideo, {
          caption: s.postText || "",
          parse_mode: "HTML",
          reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
        });
      } else {
        try { await bot.telegram.sendChatAction(chatId, "typing"); } catch {}
        await bot.telegram.sendMessage(chatId, s.postText || "(bo'sh)", {
          parse_mode: "HTML",
          reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
        });
      }
      okList.push(chatId);
    } catch (err) {
      console.error(`Yuborishda xatolik (${chatId}):`, err.message);
      failList.push({ chatId, reason: err.message || "noma'lum xato" });
    }
  }

  try {
    await db.savePost({
      userId: ctx.from.id,
      text: s.postText,
      photoFileId: s.postPhoto,
      videoFileId: s.postVideo,
      buttons: s.buttons,
      targetChat: targetIds.join(","),
    });
  } catch (e) {
    console.error("Postni saqlashda xatolik:", e.message);
  }

  const chatNames = await (async () => {
    try {
      const chats = await getUserChats(ctx.from.id);
      return targetIds.map((id) => chats.get(id)?.title || id);
    } catch {
      return targetIds;
    }
  })();

  resetSession(ctx.from.id);

  // Natija xabari
  let result = `✅ Xabar yuborildi! 🎉\n\n`;
  result += `📍 Yuborilgan (${okList.length}):\n`;
  okList.forEach((id) => {
    result += `  ✔️ ${chatNames[targetIds.indexOf(id)] || id}\n`;
  });
  if (failList.length) {
    result += `\n❌ Yuborilmagan (${failList.length}):\n`;
    failList.forEach((f) => {
      result += `  ✖️ ${chatNames[targetIds.indexOf(f.chatId)] || f.chatId} — <i>${escapeHtml(f.reason)}</i>\n`;
    });
  }

  return ctx.replyWithHTML(result, startMenu(ctx));
});

// ═══════════════════════════════════════════════════════════
//  BEKOR QILISH
// ═══════════════════════════════════════════════════════════
bot.action("cancel", (ctx) => {
  ctx.answerCbQuery("Bekor qilindi");
  resetSession(ctx.from.id);
  ctx.replyWithHTML(`❌ Post yaratish bekor qilindi.`, startMenu(ctx));
});

bot.action(/^noop_/, (ctx) => ctx.answerCbQuery(""));

// ═══════════════════════════════════════════════════════════
//  BOT ADMIN BO'LGAN CHAT — AVTOMATIK ANIQLASH
//  Egasini (akkauntni) my_chat_member.from orqali aniqlaymiz
// ═══════════════════════════════════════════════════════════
bot.on("my_chat_member", async (ctx) => {
  try {
    const member = ctx.myChatMember;
    const chat = member.chat;
    const newStatus = member.new_chat_member?.status;
    const oldStatus = member.old_chat_member?.status;
    const chatId = String(chat.id);
    // Kanalni qo'shgan/admin qilgan foydalanuvchi — egasi
    const ownerId = member.from?.id || null;

    console.log(`Chat o'zgarishi: ${chat.title || chatId} (${chatId}) — ${oldStatus} → ${newStatus} (egasi: ${ownerId})`);

    if (newStatus === "administrator" || newStatus === "creator") {
      let title = chat.title || chat.username || chatId;
      let type = chat.type || "unknown";
      try {
        const info = await bot.telegram.getChat(chatId);
        title = info.title || info.username || title;
        type = info.type || type;
      } catch (e) {}

      // Egasi foydalanuvchini ham ro'yxatga olib qo'yamiz
      if (ownerId && member.from) {
        try { await db.upsertUser(member.from); } catch (e) {}
      }

      await db.addAdminChat(chatId, title, type, ownerId);
      console.log(`Bot admin bo'ldi: ${title} (${chatId}) egasi: ${ownerId}`);
    } else if (newStatus === "left" || newStatus === "kicked") {
      // Bot chiqarilgan/chiqib ketgan — kanalni o'chiramiz (kim chiqarganidan qat'iy nazar)
      await db.removeAdminChat(chatId, null);
      console.log(`Bot olib tashlandi: ${chat.title || chatId}`);
    }
  } catch (e) {
    console.error("my_chat_member ni qayta ishlashda xatolik:", e.message);
  }
});

// Kanalga xabar kelganda — nomini yangilash (egasi o'zgarishmaydi)
bot.on("channel_post", async (ctx) => {
  const chat = ctx.channelPost.chat;
  const chatId = String(chat.id);
  try {
    const existing = await db.getAdminChatById(chatId);
    if (!existing) return; // Egasi bo'lmagan kanalni qo'shmaymiz (kiruvchi qo'shish yo'q)
    let info = null;
    try { info = await bot.telegram.getChat(chatId); } catch {}
    const title = (info && (info.title || info.username)) || chat.title || chat.username || existing.title;
    const type = info?.type || existing.type || "channel";
    await db.addAdminChat(chatId, title, type, existing.owner_id);
    console.log(`Kanal nomi yangilandi: ${title} (${chatId})`);
  } catch (e) {
    console.error("channel_post ni qayta ishlashda xatolik:", e.message);
  }
});

// Guruhdan xabar kelganda — nomini yangilash (egasi o'zgarishmaydi)
bot.on("message", async (ctx) => {
  const chat = ctx.message?.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const chatId = String(chat.id);
  try {
    const existing = await db.getAdminChatById(chatId);
    if (!existing) return; // Egasi bo'lmagan guruhni qo'shmaymiz
    const title = chat.title || chat.username || existing.title;
    if (existing.title !== title) {
      await db.addAdminChat(chatId, title, chat.type || existing.type, existing.owner_id);
      console.log(`Guruh nomi yangilandi: ${title} (${chatId})`);
    }
  } catch (e) {}
});

// ═══════════════════════════════════════════════════════════
//  ISHGA TUSHIRISH
// ═══════════════════════════════════════════════════════════
async function main() {
  try {
    await db.initDatabase();
  } catch (e) {
    console.error("MongoDB ulanishida xatolik:", e.message);
  }

  bot.launch();
  console.log("Bot ishga tushdi!");

  async function shutdown() {
    bot.stop("shutdown");
    await db.close().catch(() => {});
    process.exit(0);
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("Bot ishga tushmadi:", e.message);
  process.exit(1);
});