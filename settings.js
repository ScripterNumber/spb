// ─────────────────────────────────────────────────────────────
// SETTINGS
//
// Render free план сбрасывает файловую систему при каждом деплое,
// поэтому настройки хранятся в переменных окружения, а не в файле.
//
// BAN_LOG_CHANNEL_ID — ID канала для логов банов/разбанов в игре.
// Можно переопределить командой /setgamebanlogschannel прямо в Discord
// (работает до следующего деплоя, потом снова берётся из env).
// ─────────────────────────────────────────────────────────────

// runtime-override: живёт только пока процесс жив
const overrides = new Map(); // guildId -> channelId

function getBanLogChannel(guildId) {
  // Сначала смотрим runtime-override (команда /setgamebanlogschannel)
  if (guildId && overrides.has(guildId)) {
    return overrides.get(guildId);
  }
  // Потом env-переменная (постоянная, не слетает при деплое)
  return process.env.BAN_LOG_CHANNEL_ID ?? null;
}

function setBanLogChannel(guildId, channelId) {
  overrides.set(guildId, channelId);
  console.log(`[settings] BAN_LOG_CHANNEL_ID для ${guildId} = ${channelId} (runtime, до след. деплоя)`);
  console.log(`[settings] чтобы сохранить навсегда — добавь BAN_LOG_CHANNEL_ID=${channelId} в Render → Environment`);
}

function clearBanLogChannel(guildId) {
  overrides.delete(guildId);
}

module.exports = {
  getBanLogChannel,
  setBanLogChannel,
  clearBanLogChannel,
};
