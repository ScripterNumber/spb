require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { allCommandData } = require('./commands');

// ─────────────────────────────────────────────────────────────
// Ручная регистрация команд:  npm run register
// На Render регистрация происходит автоматически при старте бота,
// этот скрипт нужен для локальной отладки.
//
// allCommandData = слэш-команды + контекстные команды сообщений
// (Gif Blacklist Add / Remove). Discord перезаписывает список целиком,
// поэтому оба типа обязаны ехать в одном запросе.
// ─────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Заполни DISCORD_TOKEN и CLIENT_ID в .env (см. .env.example)');
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: allCommandData });
      console.log('Готово: команды появятся на сервере мгновенно.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: allCommandData });
      console.log('Готово: глобальные команды появятся в течение часа.');
    }
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    process.exit(1);
  }
})();
