require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  GuildMFALevel,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

const {
  UNITS,
  MUTE_ALIASES,
  UNMUTE_ALIASES,
  LOOPCLEAR_ALIASES,
  STOPLOOPCLEAR_ALIASES,
  SPVKBAN_ALIASES,
  SPVKUNBAN_ALIASES,
  GIFBLACKLIST_ALIASES,
  GIF_CONTEXT_ADD,
  GIF_CONTEXT_REMOVE,
  allCommandData,
} = require('./commands');
const { startKeepAlive } = require('./keepalive');
const loopclear = require('./loopclear');
const roblox = require('./roblox');
const gifblacklist = require('./gifblacklist');

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

// GuildMessages + MessageContent нужны фильтру гифок: без них Discord не отдаёт
// ни текст, ни вложения, ни эмбеды (content/embeds/attachments приходят пустыми).
// MessageContent — привилегированный intent: включи его в Developer Portal →
// Bot → Privileged Gateway Intents, иначе бот вообще не подключится (close code 4014).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ─────────────────────────────────────────────────────────────
// Авто-регистрация команд при старте.
// С GUILD_ID — на одном сервере мгновенно.
// Без него — глобально, но Discord может обновлять кэш до 1 часа.
// ─────────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: allCommandData });
      console.log('[commands] зарегистрированы на сервере (мгновенно)');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: allCommandData });
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

    // Окошко «вставь ссылку»: /gifblacklist add или remove без параметров.
    if (interaction.isModalSubmit()) return handleGifBlacklistModal(interaction);

    // ПКМ по сообщению → Приложения → «Gif Blacklist Add / Remove».
    if (interaction.isMessageContextMenuCommand()) return handleGifContextCommand(interaction);

    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;
    if (MUTE_ALIASES.includes(name)) return handleMute(interaction);
    if (UNMUTE_ALIASES.includes(name)) return handleUnmute(interaction);
    if (LOOPCLEAR_ALIASES.includes(name)) return handleLoopClear(interaction);
    if (STOPLOOPCLEAR_ALIASES.includes(name)) return handleStopLoopClear(interaction);
    if (SPVKBAN_ALIASES.includes(name)) return handleSpvkBan(interaction);
    if (SPVKUNBAN_ALIASES.includes(name)) return handleSpvkUnban(interaction);
    if (GIFBLACKLIST_ALIASES.includes(name)) return handleGifBlacklist(interaction);
  } catch (error) {
    console.error('[interaction] ошибка:', error);
    if (interaction.isRepliable()) {
      const payload = { content: 'Что-то пошло не так. Попробуй ещё раз.', flags: MessageFlags.Ephemeral };
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
    return interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({
      content: 'Нужно право «Модерировать участников» — без него мутить нельзя.',
      flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
  }

  const guild = interaction.guild;

  // force: true — спрашиваем у API напрямую, минуя кэш.
  // Иначе бот может работать на устаревших ролях после того, как их подвигали.
  const target =
    (await guild.members.fetch({ user: user.id, force: true }).catch(() => null)) ??
    guild.members.cache.get(user.id) ??
    null;
  if (!target) {
    return interaction.reply({ content: 'Не нашёл этого участника на сервере.', flags: MessageFlags.Ephemeral });
  }
  if (target.id === interaction.user.id) {
    return interaction.reply({ content: 'Сам себя мутить? Забавно, но нет.', flags: MessageFlags.Ephemeral });
  }
  if (target.id === interaction.client.user.id) {
    return interaction.reply({ content: 'Меня мутить бесполезно — я бот, тайм-аут мне не выдаётся.', flags: MessageFlags.Ephemeral });
  }
  if (target.user.bot) {
    return interaction.reply({
      content: 'Других ботов Discord мутить запрещает в принципе (даже с админкой будет Missing Access). Кикнуть или забанить — пожалуйста, а тайм-аут — только живым людям.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (target.id === guild.ownerId) {
    return interaction.reply({
      content: 'Владельца сервера замутить нельзя — это жёсткое правило Discord, его не обходит даже Administrator.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Свежие данные о своей роли — тоже напрямую из API, кэшу не доверяем.
  const me = (await guild.members.fetchMe({ force: true }).catch(() => null)) ?? guild.members.me;
  if (!me) {
    return interaction.reply({
      content: 'Не вижу свою роль. Перезапусти бота (Manual Deploy → Deploy на Render) и попробуй снова.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // 1) У роли бота должно быть право на модерацию.
  if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({
      content: 'У моей роли нет права «Модерировать участников». Выдай его (или Administrator): Настройки сервера → Роли.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const myTop = me.roles.highest;
  const targetTop = target.roles.highest;

  // 2) Иерархия: высшая роль бота должна быть СТРОГО выше высшей роли цели.
  //    ВАЖНО: Administrator иерархию НЕ пробивает — таковы правила Discord.
  if (myTop.comparePositionTo(targetTop) <= 0) {
    console.log(
      `[mute] отказ по иерархии: «${myTop.name}»(${myTop.position}) <= «${targetTop.name}»(${targetTop.position}), цель=${target.user.tag}`,
    );
    return interaction.reply({
      content: [
        'Роли стоят не так, как нужно:',
        `• моя высшая роль: **${myTop.name}** — позиция ${myTop.position}`,
        `• высшая роль ${target}: **${targetTop.name}** — позиция ${targetTop.position}`,
        '',
        'Перетащи мою роль выше его роли: Настройки сервера → Роли.',
        'Смотри именно на список РОЛЕЙ — в списке участников боты всегда висят наверху группой, но на иерархию это никак не влияет.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

  // 3) Модератор не должен мутить через бота тех, кто выше или равен ему по роли.
  if (interaction.user.id !== guild.ownerId) {
    const invokerTop = interaction.member.roles.highest;
    if (invokerTop.comparePositionTo(targetTop) <= 0) {
      return interaction.reply({
        content: `Твоя высшая роль (**${invokerTop.name}**) не выше роли участника (**${targetTop.name}**) — через бота мутить вышестоящих нельзя.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  let ms = amount * unitInfo.ms;
  let capped = false;
  if (ms > MAX_TIMEOUT) {
    ms = MAX_TIMEOUT;
    capped = true;
  }

  console.log(
    `[mute] ${interaction.user.tag} -> ${target.user.tag} на ${ms}ms (я: «${myTop.name}»${myTop.position}, цель: «${targetTop.name}»${targetTop.position})`,
  );

  try {
    await target.timeout(ms, `${reason} — выдал ${interaction.user.tag}`);
  } catch (error) {
    console.error(
      `[mute] Discord API отклонил тайм-аут: code=${error?.code} message=${error?.message} ` +
        `(я: «${myTop.name}»${myTop.position}, цель: «${targetTop.name}»${targetTop.position}, bot=${target.user.bot}, owner=${target.id === guild.ownerId}, mfa=${guild.mfaLevel})`,
    );

    // Классика: на сервере включено «Требовать 2FA для действий модерации».
    // Тогда Discord считает, что прав у бота НЕТ, пока у владельца бота не включена 2FA.
    if (error?.code === 50013 && guild.mfaLevel === GuildMFALevel.Elevated) {
      return interaction.reply({
        content: [
          'Причина найдена: на сервере включено **«Требовать 2FA для действий модерации»**.',
          'Discord считает, что у бота нет прав, пока у **владельца бота** не включена двухфакторная аутентификация — админка и иерархия ролей здесь не помогают.',
          '',
          'Что сделать (на выбор):',
          '• включи 2FA: Настройки пользователя → Моя учётная запись → «Включить двухфакторную аутентификацию» — рекомендуется;',
          '• или выключи требование: Настройки сервера → Настройки безопасности → «Требовать 2FA для действий модерации».',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: [
        `Discord отклонил мут (код ${error?.code ?? 'неизвестно'}: ${error?.message ?? 'ошибка API'}).`,
        'Мои проверки до этого прошли — значит, проблема на стороне Discord. Пришли строку с кодом из логов Render, разберёмся.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

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
// /размьют (он же /unmute, /размут)
// ─────────────────────────────────────────────────────────────
async function handleUnmute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({
      content: 'Нужно право «Модерировать участников».',
      flags: MessageFlags.Ephemeral,
    });
  }

  const user = interaction.options.getUser('участник', true);
  const reason = interaction.options.getString('причина') ?? 'без причины';

  const guild = interaction.guild;
  const target = await guild.members.fetch(user.id).catch(() => null);
  if (!target) {
    return interaction.reply({ content: 'Не нашёл этого участника на сервере.', flags: MessageFlags.Ephemeral });
  }

  if (!target.isCommunicationDisabled()) {
    return interaction.reply({ content: `${target} и так не в муте.`, flags: MessageFlags.Ephemeral });
  }

  const me = (await guild.members.fetchMe().catch(() => null)) ?? guild.members.me;
  if (me) {
    const myTop = me.roles.highest;
    const targetTop = target.roles.highest;
    if (target.id !== guild.ownerId && myTop.comparePositionTo(targetTop) <= 0) {
      return interaction.reply({
        content: `Снять мут не смогу: роль ${target} (**${targetTop.name}**) не ниже моей (**${myTop.name}**). Подними мою роль выше в Настройки сервера → Роли.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  try {
    await target.timeout(null, `Размут: ${reason} — выдал ${interaction.user.tag}`);
  } catch (error) {
    console.error(`[unmute] Discord API отклонил: code=${error?.code} message=${error?.message}`);
    return interaction.reply({
      content: `Discord отклонил размут (код ${error?.code ?? 'неизвестно'}). Скорее всего, дело в иерархии ролей или требовании 2FA.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Мут снят')
    .setDescription(`${target} снова может писать и говорить`)
    .addFields(
      { name: 'Модератор', value: `${interaction.user}`, inline: true },
      { name: 'Причина', value: reason, inline: true },
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────
// /loopclear (он же /лупклир) — гениальная очистка
// ─────────────────────────────────────────────────────────────
async function handleLoopClear(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: 'Нужно право «Модерировать участников».', flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.channel;
  if (!channel || !('messages' in channel)) {
    return interaction.reply({ content: 'Здесь нет сообщений для очистки.', flags: MessageFlags.Ephemeral });
  }

  const targetUser = interaction.options.getUser('ник'); // может быть null = все
  const targetId = targetUser?.id ?? null;
  const count = interaction.options.getInteger('count'); // 1..1000 или null = до конца канала

  // В канале — максимум один лупклир. Запущенный с тем же фильтром качается дальше.
  if (loopclear.isActive(channel.id)) {
    const current = loopclear.currentTargetId(channel.id);
    return interaction.reply({
      content:
        current === targetId
          ? 'Лупклир с такой настройкой уже качается здесь — дождись финиша или останови его через /stoploopclear.'
          : 'Тут уже идёт очистка (в канале может быть только один лупклир). Останови его: /stoploopclear — и запусти новый.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const loop = loopclear.startLoop({ channel, targetId, count });
  if (!loop) {
    return interaction.editReply({ content: 'Не вышло запустить очистку.', flags: MessageFlags.Ephemeral });
  }

  const scopeText = targetUser ? `сообщения ${targetUser}` : 'сообщения всех';
  const limitText = count ? `Проходов: **${count}**.` : 'Пойдём до самого первого сообщения канала.';
  const oldText =
    'Старые сообщения (14+ дней, их не берёт массовая чистка) выковыриваются **по одному**, принудительно, быстро и по очереди.';

  await interaction.editReply({
    content: `Запустил лупклир: чищу ${scopeText} в этом канале.\n${limitText} ${oldText}\nОстановить: /stoploopclear${targetUser ? ` ${targetUser.username}` : ''}`,
  });

  // Тикаем и докладываем по мере прогресса — раз в ~5 секунд обновляем счётчик.
  let lastEdit = 0;
  let lastDeleted = -1;
  loop.onTick = async ({ deleted = loop.deleted, done = false } = {}) => {
    const now = Date.now();
    if (!done && (now - lastEdit < 5000 || deleted === lastDeleted)) return;
    lastEdit = now;
    lastDeleted = deleted;
    const line = done
      ? `Лупклир финишировал: удалено **${deleted}**.`
      : `Лупклир качается: удалено **${deleted}**…`;
    interaction.editReply({ content: `${line}\n${limitText} ${oldText}` }).catch(() => {});
  };
}

// ─────────────────────────────────────────────────────────────
// /stoploopclear (он же /стоплупклир)
// ─────────────────────────────────────────────────────────────
async function handleStopLoopClear(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: 'Нужно право «Модерировать участников».', flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.channel;
  const targetUser = interaction.options.getUser('ник'); // null = остановить весь лупклир

  if (!loopclear.isActive(channel.id)) {
    return interaction.reply({ content: 'В этом канале нет активного лупклира.', flags: MessageFlags.Ephemeral });
  }

  const current = loopclear.currentTargetId(channel.id);
  if (targetUser && current && current !== targetUser.id) {
    return interaction.reply({
      content: `Сейчас качается лупклир другого фильтра (участник с id ${current}). /stoploopclear без ника остановит его полностью.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const res = loopclear.stopLoop(channel.id, targetUser?.id ?? null);
  return interaction.reply({
    content: res.stopped
      ? `Остановил лупклир${targetUser ? ` для ${targetUser}` : ''} в этом канале.`
      : 'Не вышло остановить — похоже, он уже финишировал.',
  });
}

// ─────────────────────────────────────────────────────────────
// /spvkban (он же /спвкбан) — бан в Roblox через Open Cloud
// ─────────────────────────────────────────────────────────────
async function handleSpvkBan(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: 'Нужно право «Модерировать участников».', flags: MessageFlags.Ephemeral });
  }

  const username = interaction.options.getString('юзернеймроблокса', true).trim();
  const hours = interaction.options.getInteger('часы', true);
  const reason = interaction.options.getString('причина', true).trim();
  const includeAlts = interaction.options.getBoolean('твинки') === true;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const res = await roblox.banByUsername(username, hours, reason, includeAlts && false /* по умолчанию альтов баним */);

    if (res.reason === 'not_found') {
      return interaction.editReply({
        content: `Игрока **${username}** в Roblox не существует.`,
      });
    }

    const displayName = res.lookup?.displayName || res.lookup?.name || username;
    const userId = res.lookup?.id ?? '?';
    const durationText = hours > 0 ? `${hours} ч.` : 'навсегда';

    const embed = new EmbedBuilder().setTimestamp();

    if (res.ok) {
      embed
        .setColor(0x2ecc71)
        .setTitle('Бан выдан')
        .addFields(
          { name: 'Игрок', value: `${displayName} (@${res.lookup?.name ?? username})`, inline: true },
          { name: 'Roblox ID', value: String(userId), inline: true },
          { name: 'Срок', value: durationText, inline: true },
          { name: 'Причина', value: reason, inline: false },
        );
      if (includeAlts) embed.setFooter({ text: 'Твинки заблокированы вместе с основным' });
    } else {
      embed
        .setColor(0xe74c3c)
        .setTitle('Не вышло забанить')
        .setDescription(`Roblox ответил кодом **${res.status}**.`)
        .addFields(
          { name: 'Игрок', value: `${displayName} (@${res.lookup?.name ?? username})`, inline: true },
          { name: 'Roblox ID', value: String(userId), inline: true },
        );
      if (res.raw) embed.addFields({ name: 'Ответ Roblox', value: `\`\`\`${truncate(res.raw, 500)}\`\`\`` });
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[spvkban] ошибка:', error);
    const msg = error?.code === 'MISSING_ENV'
      ? error.message
      : `Roblox API не ответил: ${error?.message ?? 'неизвестная ошибка'}`;
    return interaction.editReply({ content: msg });
  }
}

// ─────────────────────────────────────────────────────────────
// /spvkunban (он же /спвкразбан)
// ─────────────────────────────────────────────────────────────
async function handleSpvkUnban(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: 'Нужно право «Модерировать участников».', flags: MessageFlags.Ephemeral });
  }

  const username = interaction.options.getString('юзернеймроблокса', true).trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const res = await roblox.unbanByUsername(username);

    if (res.reason === 'not_found') {
      return interaction.editReply({ content: `Игрока **${username}** в Roblox не существует.` });
    }

    const displayName = res.lookup?.displayName || res.lookup?.name || username;
    const userId = res.lookup?.id ?? '?';

    const embed = new EmbedBuilder().setTimestamp();

    if (res.ok) {
      embed
        .setColor(0x2ecc71)
        .setTitle('Игрок разбанен')
        .addFields(
          { name: 'Игрок', value: `${displayName} (@${res.lookup?.name ?? username})`, inline: true },
          { name: 'Roblox ID', value: String(userId), inline: true },
        );
    } else {
      embed
        .setColor(0xe74c3c)
        .setTitle('Разбан не прошёл')
        .setDescription(`Roblox ответил кодом **${res.status}**.`)
        .addFields(
          { name: 'Игрок', value: `${displayName} (@${res.lookup?.name ?? username})`, inline: true },
          { name: 'Roblox ID', value: String(userId), inline: true },
        );
      if (res.raw) embed.addFields({ name: 'Ответ Roblox', value: `\`\`\`${truncate(res.raw, 500)}\`\`\`` });
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[spvkunban] ошибка:', error);
    const msg = error?.code === 'MISSING_ENV'
      ? error.message
      : `Roblox API не ответил: ${error?.message ?? 'неизвестная ошибка'}`;
    return interaction.editReply({ content: msg });
  }
}

function truncate(str, n) {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// ─────────────────────────────────────────────────────────────
// /gifblacklist — чёрный список гифок
//
//   /gifblacklist add [ссылка] [сообщение]     — добавить гифку
//   /gifblacklist remove [номер] [ссылка]      — убрать гифку
//   /gifblacklist addwhitelist [участник] [роль]
//   /gifblacklist removewhitelist [участник] [роль]
//   /gifblacklist list                         — что в блеклисте и вайтлисте
//
// Без параметров add/remove открывают окошко (modal) «вставь ссылку».
// «Ответить командой на сообщение» решается контекстными командами:
// ПКМ по сообщению → Приложения → Gif Blacklist Add / Remove.
// ─────────────────────────────────────────────────────────────
const GIF_MODAL_ADD = 'gifblacklist:add';
const GIF_MODAL_REMOVE = 'gifblacklist:remove';
const GIF_MODAL_INPUT = 'ссылка';
const MESSAGE_LINK_REGEX = /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i;

function gifPermissionError(interaction) {
  if (!interaction.inGuild()) return 'Команда работает только на сервере.';
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return 'Нужно право «Модерировать участников».';
  }
  return null;
}

function actorOf(interaction) {
  return { id: interaction.user.id, tag: interaction.user.tag ?? interaction.user.username };
}

// Окошко, которое Discord показывает поверх чата: «вставь ссылку».
function gifModal(kind) {
  const adding = kind === 'add';
  return new ModalBuilder()
    .setCustomId(adding ? GIF_MODAL_ADD : GIF_MODAL_REMOVE)
    .setTitle(adding ? 'Заблеклистить гифку' : 'Убрать гифку из блеклиста')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(GIF_MODAL_INPUT)
          .setLabel(adding ? 'Ссылка на гифку' : 'Ссылка на гифку или номер записи')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(1000)
          .setPlaceholder(
            adding
              ? 'https://images-ext-1.discordapp.net/external/…/15LKtkqmWrMszDt.mp4'
              : 'например: 1 или ссылка на гифку',
          ),
      ),
    );
}

// Если вставили ссылку на сообщение — достаём само сообщение (как «ответ на сообщение»).
async function fetchLinkedMessage(interaction, value) {
  const match = String(value ?? '').match(MESSAGE_LINK_REGEX);
  if (!match) return null;

  const [, guildId, channelId, messageId] = match;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !('messages' in channel)) return { error: 'Не нашёл канал из этой ссылки.' };
  if (channel.guildId && channel.guildId !== guildId) return { error: 'Ссылка на сообщение с другого сервера.' };

  const message = await channel.messages.fetch(messageId, { cache: false }).catch(() => null);
  if (!message) return { error: 'Сообщение не найдено — или бот не видит его в том канале.' };
  return { message };
}

async function gifAddFromValue(interaction, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'Пусто. Вставь ссылку на гифку или ссылку на сообщение с ней.' };

  if (MESSAGE_LINK_REGEX.test(raw)) {
    const found = await fetchLinkedMessage(interaction, raw);
    if (found?.error) return { ok: false, error: found.error };

    const urls = gifblacklist.collectUrlsFromMessage(found.message);
    if (!urls.length) return { ok: false, error: 'В том сообщении нет медиа или ссылок, которые можно заблеклистить.' };

    const added = [];
    const skipped = [];
    for (const url of urls) {
      const res = await gifblacklist.addGif(url, actorOf(interaction));
      if (res.ok) added.push(res.entry);
      else if (res.duplicate) skipped.push(res.entry);
      else console.warn(`[gifblacklist] ${url}: ${res.error}`);
    }
    return { ok: added.length > 0, added, skipped, error: added.length ? null : 'Все эти гифки уже в блеклисте.' };
  }

  const res = await gifblacklist.addGif(raw, actorOf(interaction));
  if (res.ok) return { ok: true, added: [res.entry], skipped: [] };
  if (res.duplicate) return { ok: false, error: `Эта гифка уже в блеклисте — запись **#${res.entry.id}**.` };
  return { ok: false, error: res.error ?? 'Не вышло добавить гифку.' };
}

async function gifRemoveFromValue(interaction, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'Пусто. Укажи номер записи из /gifblacklist list или ссылку на гифку.' };

  if (/^\d+$/.test(raw)) return gifblacklist.removeGif({ id: Number(raw) });

  if (MESSAGE_LINK_REGEX.test(raw)) {
    const found = await fetchLinkedMessage(interaction, raw);
    if (found?.error) return { ok: false, error: found.error };

    const removed = [];
    for (const url of gifblacklist.collectUrlsFromMessage(found.message)) {
      const res = gifblacklist.removeGif({ url });
      if (res.ok) removed.push(...res.removed);
    }
    return removed.length ? { ok: true, removed } : { ok: false, error: 'В том сообщении нет гифок из блеклиста.' };
  }

  return gifblacklist.removeGif({ url: raw });
}

function gifEntriesValue(entries) {
  if (!entries.length) return '—';
  return entries
    .slice(0, 10)
    .map((entry) => `**#${entry.id}** · \`${truncate(String(entry.url), 80)}\``)
    .join('\n');
}

function gifAddEmbed(res) {
  const embed = new EmbedBuilder().setTimestamp();
  if (!res.ok) {
    return embed.setColor(0xe74c3c).setTitle('Не добавил').setDescription(res.error ?? 'Не вышло.');
  }

  embed
    .setColor(0x2ecc71)
    .setTitle(res.added.length > 1 ? `В блеклисте ${res.added.length} гифки` : 'Гифка в блеклисте')
    .setDescription(gifEntriesValue(res.added))
    .setFooter({ text: 'Теперь бот удаляет эти гифки сразу. Убрать: /gifblacklist remove <номер>' });

  if (res.skipped?.length) {
    embed.addFields({ name: 'Уже были в блеклисте', value: gifEntriesValue(res.skipped), inline: false });
  }
  return embed;
}

function gifRemoveEmbed(res) {
  const embed = new EmbedBuilder().setTimestamp();
  if (!res.ok) {
    return embed.setColor(0xe74c3c).setTitle('Не убрал').setDescription(res.error ?? 'Не вышло.');
  }
  return embed
    .setColor(0x5865f2)
    .setTitle(res.removed.length > 1 ? `Из блеклиста убрано ${res.removed.length}` : 'Гифка убрана из блеклиста')
    .setDescription(gifEntriesValue(res.removed));
}

// ─────────────────────────────────────────────────────────────
// /gifblacklist — роутер подкоманд
// ─────────────────────────────────────────────────────────────
async function handleGifBlacklist(interaction) {
  const denied = gifPermissionError(interaction);
  if (denied) return interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand(true);

  if (sub === 'add' || sub === 'remove') {
    const value = interaction.options.getString('ссылка') ?? interaction.options.getString('сообщение');
    // Ссылку не указали — покажем окошко, куда её вставить.
    if (!value) return interaction.showModal(gifModal(sub));

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res =
      sub === 'add' ? await gifAddFromValue(interaction, value) : await gifRemoveFromValue(interaction, value);
    return interaction.editReply({ embeds: [sub === 'add' ? gifAddEmbed(res) : gifRemoveEmbed(res)] });
  }

  if (sub === 'addwhitelist' || sub === 'removewhitelist') {
    return handleGifWhitelist(interaction, sub === 'addwhitelist');
  }

  return handleGifList(interaction);
}

async function handleGifWhitelist(interaction, adding) {
  const user = interaction.options.getUser('участник');
  const role = interaction.options.getRole('роль');

  if (!user && !role) {
    return interaction.reply({
      content: `Укажи хотя бы одного: /gifblacklist ${
        adding ? 'addwhitelist' : 'removewhitelist'
      } участник:@ник и/или роль:@роль`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const lines = [];

  if (user) {
    if (adding) {
      const res = gifblacklist.addWhitelistUser({ id: user.id, tag: user.tag ?? user.username }, actorOf(interaction));
      lines.push(res.ok ? `\`+\` ${user} — заблокированные гифки можно` : `${user} уже был в вайтлисте.`);
    } else {
      const res = gifblacklist.removeWhitelistUser(user.id);
      lines.push(res.ok ? `\`−\` ${user} — снова под блеклистом` : `${user} в вайтлисте не было.`);
    }
  }

  if (role) {
    if (adding) {
      const res = gifblacklist.addWhitelistRole({ id: role.id, name: role.name }, actorOf(interaction));
      lines.push(res.ok ? `\`+\` ${role} — заблокированные гифки можно` : `${role} уже была в вайтлисте.`);
    } else {
      const res = gifblacklist.removeWhitelistRole(role.id);
      lines.push(res.ok ? `\`−\` ${role} — снова под блеклистом` : `${role} в вайтлисте не было.`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Вайтлист обновлён')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Весь список: /gifblacklist list' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleGifList(interaction) {
  const gifs = gifblacklist.listGifs();
  const whitelist = gifblacklist.listWhitelist();

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('GIF-блеклист')
    .addFields(
      {
        name: `Гифки (${gifs.length})`,
        value: gifs.length
          ? `${gifEntriesValue(gifs)}${gifs.length > 10 ? `\n…и ещё ${gifs.length - 10}` : ''}`
          : 'пусто',
      },
      {
        name: `Вайтлист: участники (${whitelist.users.length})`,
        value: whitelist.users.length ? whitelist.users.map((u) => `<@${u.id}>`).slice(0, 15).join(' ') : 'пусто',
      },
      {
        name: `Вайтлист: роли (${whitelist.roles.length})`,
        value: whitelist.roles.length ? whitelist.roles.map((r) => `<@&${r.id}>`).slice(0, 15).join(' ') : 'пусто',
      },
    )
    .setFooter({ text: 'Владелец сервера и админы блеклист игнорируют (BYPASS_ADMINS в gifblacklist.js)' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─────────────────────────────────────────────────────────────
// Окошко «вставь ссылку» (modal) и контекстная команда по сообщению
// ─────────────────────────────────────────────────────────────
async function handleGifBlacklistModal(interaction) {
  const adding = interaction.customId === GIF_MODAL_ADD;
  if (!adding && interaction.customId !== GIF_MODAL_REMOVE) return; // чужой modal — не наш

  const denied = gifPermissionError(interaction);
  if (denied) return interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });

  const value = interaction.fields.getTextInputValue(GIF_MODAL_INPUT);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (adding) {
    const res = await gifAddFromValue(interaction, value);
    return interaction.editReply({ embeds: [gifAddEmbed(res)] });
  }

  const res = await gifRemoveFromValue(interaction, value);
  return interaction.editReply({ embeds: [gifRemoveEmbed(res)] });
}

async function handleGifContextCommand(interaction) {
  const denied = gifPermissionError(interaction);
  if (denied) return interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Сообщение, по которому щёлкнули ПКМ. Если оно пришло частичным — догружаем.
  let target = interaction.targetMessage;
  if (target.partial) target = await target.fetch().catch(() => null);
  if (!target) {
    return interaction.editReply({ content: 'Не смог прочитать это сообщение (нет доступа к каналу?).' });
  }

  const urls = gifblacklist.collectUrlsFromMessage(target);
  if (!urls.length) {
    return interaction.editReply({ content: 'В этом сообщении нет ни медиа, ни ссылок — блеклистить нечего.' });
  }

  if (interaction.commandName === GIF_CONTEXT_ADD) {
    const added = [];
    const skipped = [];
    for (const url of urls) {
      const res = await gifblacklist.addGif(url, actorOf(interaction));
      if (res.ok) added.push(res.entry);
      else if (res.duplicate) skipped.push(res.entry);
    }
    return interaction.editReply({
      embeds: [
        gifAddEmbed({
          ok: added.length > 0,
          added,
          skipped,
          error: added.length ? null : 'Всё из этого сообщения уже в блеклисте.',
        }),
      ],
    });
  }

  const removed = [];
  for (const url of urls) {
    const res = gifblacklist.removeGif({ url });
    if (res.ok) removed.push(...res.removed);
  }
  return interaction.editReply({
    embeds: [
      gifRemoveEmbed({ ok: removed.length > 0, removed, error: 'В этом сообщении нет гифок из блеклиста.' }),
    ],
  });
}

// ─────────────────────────────────────────────────────────────
// ФИЛЬТР: следим за всем, что пишут люди
// Ответов в канал здесь нет: удаление молчаливое, ошибки — в ЛС автору
// записи блеклиста и в консоль.
// ─────────────────────────────────────────────────────────────
async function inspectMessage(message) {
  if (!message.inGuild?.()) return; // ЛС не трогаем
  if (message.system) return;
  if (message.author?.id === client.user?.id) return; // свои сообщения (логи) не удаляем

  // Дешёвая проверка: участник в вайтлисте — даже подписи не считаем.
  if (gifblacklist.isUserIdWhitelisted(message.author?.id)) return;

  const matches = await gifblacklist.findMatches(message);
  if (!matches.length) return;

  // Роли/админов проверяем только когда гифка реально совпала.
  if (await gifblacklist.isWhitelisted(message)) return;

  await deleteBlacklistedMessage(message, matches);
}

async function deleteBlacklistedMessage(message, matches) {
  try {
    await message.delete();
  } catch (error) {
    const code = error?.code;
    if (code === 10008) return; // уже удалено — цель достигнута
    if (code === 50013) {
      console.error(
        `[gifblacklist] нет права «Управлять сообщениями» в канале #${message.channel?.name ?? message.channelId} — выдай его роли бота`,
      );
      await notifyEntryAuthors(
        message,
        matches,
        'Не смог удалить гифку из блеклиста: у бота нет права «Управлять сообщениями» в нужном канале. Выдай это право роли бота — и удаления заработают.',
      );
      return;
    }
    console.error(`[gifblacklist] не удалил сообщение ${message.id}: code=${code} ${error?.message}`);
    await notifyEntryAuthors(
      message,
      matches,
      `Не смог удалить гифку из блеклиста — Discord вернул ошибку ${code ?? 'без кода'}.`,
    );
    return;
  }

  console.log(
    `[gifblacklist] удалил сообщение ${message.id} от ${message.author?.tag} (записи ${matches
      .map((entry) => `#${entry.id}`)
      .join(', ')})`,
  );

  await logBlacklistHit(message, matches);
}

async function logBlacklistHit(message, matches) {
  const channelId = process.env.GIF_BLACKLIST_LOG_CHANNEL_ID;
  if (!channelId) return; // лог-канал не задан — просто пишем в консоль Render

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return;

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Удалена гифка из блеклиста')
      .addFields(
        { name: 'Автор', value: `${message.author ?? 'неизвестно'}`, inline: true },
        { name: 'Канал', value: `<#${message.channelId}>`, inline: true },
        {
          name: 'Записи блеклиста',
          value: matches.map((entry) => `#${entry.id}`).join(', ').slice(0, 1024),
        },
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error(`[gifblacklist] не смог записать в лог-канал ${channelId}: ${error?.message}`);
  }
}

// Ошибки фильтра в чат не пишем: их видит только автор записи блеклиста (в ЛС)
// плюс строка в консоли Render. Успешные удаления по-прежнему молчат —
// при желании их можно складывать в лог-канал через GIF_BLACKLIST_LOG_CHANNEL_ID.
const failureNotifyCache = new Map(); // userId -> время последнего уведомления

async function notifyEntryAuthors(message, matches, errorText) {
  const authors = [...new Set(matches.map((entry) => entry.addedById).filter(Boolean))];
  const now = Date.now();

  for (const userId of authors) {
    // Не спамим: одному и тому же модератору — не чаще раза в 5 минут.
    if (now - (failureNotifyCache.get(userId) ?? 0) < 5 * 60_000) continue;
    failureNotifyCache.set(userId, now);
    if (failureNotifyCache.size > 500) failureNotifyCache.delete(failureNotifyCache.keys().next().value);

    try {
      const user = await client.users.fetch(userId);
      await user.send({
        content: [
          errorText,
          `Сообщение: https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`,
          `Записи блеклиста: ${matches.map((entry) => `#${entry.id}`).join(', ')}`,
        ].join('\n'),
      });
    } catch (error) {
      console.warn(`[gifblacklist] не смог написать в ЛС ${userId}: ${error?.message}`);
    }
  }
}

client.on(Events.MessageCreate, (message) => {
  inspectMessage(message).catch((error) => console.error('[gifblacklist] ошибка фильтра:', error));
});

// Правка сообщения — тоже проверяем: иначе блеклист обходится «дописал ссылку после».
client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  try {
    const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (message) await inspectMessage(message);
  } catch (error) {
    console.error('[gifblacklist] ошибка фильтра (edit):', error);
  }
});

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

  // Классика после включения фильтра гифок: в Developer Portal выключен
  // привилегированный intent Message Content — Discord рвёт подключение (4014).
  if (String(error?.message ?? '').toLowerCase().includes('disallowed intent')) {
    console.error(
      '[login] Включи Developer Portal → Bot → Privileged Gateway Intents → «Message Content Intent» ' +
        '(без него фильтр гифок не увидит ни текст, ни вложения) и перезапусти сервис.',
    );
  }

  process.exit(1); // Render сам перезапустит инстанс
});
