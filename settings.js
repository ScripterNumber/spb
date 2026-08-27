// ─────────────────────────────────────────────────────────────
// SETTINGS — персистентные настройки по серверам
//
// Сейчас единственная настройка: канал для логов банов/разбанов в игре
// (Roblox Open Cloud). Задаётся командой /setgamebanlogschannel,
// хранится в JSON-файле рядом с ботом (data/settings.json).
//
// Важно: на Render free план файловая система эфемерна и обнуляется
// при новом деплое (autoDeploy/manual redeploy). Между обычными
// перезапусками процесса (например, после падения) файл сохраняется.
// Если после деплоя канал логов пропал — просто прогони команду заново.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'settings.json');

let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE_PATH)) {
      const raw = fs.readFileSync(FILE_PATH, 'utf8');
      cache = raw ? JSON.parse(raw) : {};
    } else {
      cache = {};
    }
  } catch (error) {
    console.error('[settings] не смог прочитать settings.json, начинаю с пустого хранилища:', error);
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    console.error('[settings] не смог сохранить settings.json:', error);
  }
}

function getGuildSettings(guildId) {
  const data = ensureLoaded();
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

// ── канал логов банов/разбанов в игре ──────────────────────

function setBanLogChannel(guildId, channelId) {
  const data = ensureLoaded();
  if (!data[guildId]) data[guildId] = {};
  data[guildId].banLogChannelId = channelId;
  persist();
}

function getBanLogChannel(guildId) {
  if (!guildId) return null;
  return getGuildSettings(guildId).banLogChannelId ?? null;
}

function clearBanLogChannel(guildId) {
  const data = ensureLoaded();
  if (data[guildId]) {
    delete data[guildId].banLogChannelId;
    persist();
  }
}

module.exports = {
  getBanLogChannel,
  setBanLogChannel,
  clearBanLogChannel,
};
