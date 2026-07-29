require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const { UNITS, MUTE_ALIASES, commandData } = require('./commands');
const { startKeepAlive } = require('./keepalive');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // опционально — для мгновенной регистрации команд

// Жёсткий лимит Discord API на тайм-аут — 28 дней.
// Если попросят больше — честно выдаём максимум и говорим об этом.
const MAX_TIMEOUT = 28 * 24 * 60 * 60 * 1000;

if (!TOKEN || !CLIENT_ID) {
  console.error('[bot] Заполни DISCORD_TOKEN и CLIENT_ID в переменных окружения!');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─────────────────────────────────────────────────────────────
// Авто-регистрация команд при старте.
// С GUILD_ID — на одном сервере мгновенно.
// Без него — глобально, но Discord может обновлять кэш до 1 часа.
// ─────────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandData });
      console.log('[commands] зарегистрированы на сервере (мгновенно)');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandData });
      console.log('[commands] зарегистрированы глобально (появятся в течение часа)');
    }
  } catch (error) {
    console.error('[commands] ошибка регистрации:', error);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[bot] вошли как ${readyClient.user.tag}`);
  registerCommands();
});

// ─────────────────────────────────────────────────────────────
// Хелперы
// ─────────────────────────────────────────────────────────────
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(`${d} ${plural(d, 'день', 'дня', 'дней')}`);
  if (h) parts.push(`${h} ${plural(h, 'час', 'часа', 'часов')}`);
  if (m) parts.push(`${m} ${plural(m, 'минута', 'минуты', 'минут')}`);
  if (s && !d) parts.push(`${s} ${plural(s, 'секунда', 'секунды', 'секунд')}`);
  return parts.join(' ') || '0 секунд';
}

function findUnits(query) {
  const q = query.toLowerCase();
  return UNITS.filter(
    (u) => u.label.toLowerCase().includes(q) || u.value.toLowerCase().includes(q),
  ).slice(0, 25);
}

// ─────────────────────────────────────────────────────────────
// Обработчик взаимодействий
// ─────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Автокомплит: подсказки «секунды / минуты / часы / дни» прямо при вводе.
    // Работает для всех аллиасов сразу.
    if (interaction.isAutocomplete()) {
      if (!MUTE_ALIASES.includes(interaction.commandName)) return;
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'единица') {
        const results = findUnits(String(focused.value));
        await interaction.respond(results.map((u) => ({ name: u.label, value: u.value })));
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!MUTE_ALIASES.includes(interaction.commandName)) return;

    await handleMute(interaction);
  } catch (error) {
    console.error('[interaction] ошибка:', error);
    if (interaction.isRepliable()) {
      const payload = { content: 'Что-то пошло не так. Попробуй ещё раз.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────
// /mute (он же /мьют, /мут, /таймаут)
// ─────────────────────────────────────────────────────────────
async function handleMute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Команда работает только на сервере.', ephemeral: true });
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({
      content: 'Нужно право «Модерировать участников» — без него мутить нельзя.',
      ephemeral: true,
    });
  }

  const user = interaction.options.getUser('участник', true);
  const amount = interaction.options.getInteger('количество', true);
  const unit = interaction.options.getString('единица', true);
  const reason = interaction.options.getString('причина') ?? 'без причины';

  const unitInfo = UNITS.find((u) => u.value === unit);
  if (!unitInfo) {
    return interaction.reply({
      content: 'Выбери единицу из подсказок: секунды, минуты, часы или дни.',
      ephemeral: true,
    });
  }

  const target = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!target) {
    return interaction.reply({ content: 'Не нашёл этого участника на сервере.', ephemeral: true });
  }
  if (target.id === interaction.user.id) {
    return interaction.reply({ content: 'Сам себя мутить? Забавно, но нет.', ephemeral: true });
  }
  if (target.id === interaction.guild.ownerId) {
    return interaction.reply({ content: 'Владельца сервера замутить нельзя — таковы правила Discord.', ephemeral: true });
  }
  if (!target.moderatable) {
    return interaction.reply({
      content: 'Не могу замутить: моя роль стоит НИЖЕ роли этого участника. Подними роль бота выше в настройках сервера (Роли).',
      ephemeral: true,
    });
  }

  let ms = amount * unitInfo.ms;
  let capped = false;
  if (ms > MAX_TIMEOUT) {
    ms = MAX_TIMEOUT;
    capped = true;
  }

  await target.timeout(ms, `${reason} — выдал ${interaction.user.tag}`);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Участник замьючен')
    .setDescription(`${target} получил тайм-аут на **${formatDuration(ms)}**`)
    .addFields(
      { name: 'Модератор', value: `${interaction.user}`, inline: true },
      { name: 'Причина', value: reason, inline: true },
    )
    .setTimestamp();

  if (capped) {
    embed.setFooter({ text: 'Discord ограничивает тайм-аут 28 днями — выдан максимум' });
  }

  await interaction.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────
// АНТИ-ПАДЕНИЕ
//  • ловим необработанные ошибки, чтобы процесс не умирал
//  • discord.js сам переподключается к gateway при обрывах
//  • Render перезапускает контейнер, если он всё же упал
// ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));
process.on('uncaughtException', (error) => console.error('[uncaughtException]', error));

startKeepAlive(() => ({
  bot: client.isReady() ? 'online' : 'starting',
  user: client.isReady() ? client.user.tag : null,
}));

client.login(TOKEN).catch((error) => {
  console.error('[login] не удалось войти:', error);
  process.exit(1); // Render сам перезапустит инстанс
});
