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
  ChannelType,
} = require('discord.js');

const {
  UNITS,
  MUTE_ALIASES,
  UNMUTE_ALIASES,
  LOOPCLEAR_ALIASES,
  STOPLOOPCLEAR_ALIASES,
  SPVKBAN_ALIASES,
  SPVKUNBAN_ALIASES,
  // Пока в commands.js не добавлена эта команда — работаем с дефолтом,
  // чтобы деструктуризация не падала. После апдейта commands.js забери
  // экспорт оттуда — тут ничего менять не придётся.
  SETGAMEBANLOGSCHANNEL_ALIASES = ['setgamebanlogschannel'],
  commandData,
} = require('./commands');
const { startKeepAlive } = require('./keepalive');
const loopclear = require('./loopclear');
const roblox = require('./roblox');
const robloxpoller = require('./robloxpoller');
const settings = require('./settings');

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
  robloxpoller.startPoller({
    client: readyClient,
    getChannelId: () => settings.getBanLogChannel(null),
  });
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

function truncate(str, n) {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
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

    const name = interaction.commandName;
    if (MUTE_ALIASES.includes(name)) return handleMute(interaction);
    if (UNMUTE_ALIASES.includes(name)) return handleUnmute(interaction);
    if (LOOPCLEAR_ALIASES.includes(name)) return handleLoopClear(interaction);
    if (STOPLOOPCLEAR_ALIASES.includes(name)) return handleStopLoopClear(interaction);
    if (SPVKBAN_ALIASES.includes(name)) return handleSpvkBan(interaction);
    if (SPVKUNBAN_ALIASES.includes(name)) return handleSpvkUnban(interaction);
    if (SETGAMEBANLOGSCHANNEL_ALIASES.includes(name)) return handleSetGameBanLogsChannel(interaction);
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

  const notify = {
    client: interaction.client,
    channelId: settings.getBanLogChannel(interaction.guildId),
  };

  try {
    const res = await roblox.banByUsername(
      username,
      hours,
      reason,
      includeAlts && false /* по умолчанию альтов баним */,
      notify,
    );

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

  const notify = {
    client: interaction.client,
    channelId: settings.getBanLogChannel(interaction.guildId),
  };

  try {
    const res = await roblox.unbanByUsername(username, notify);

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

// ─────────────────────────────────────────────────────────────
// /setgamebanlogschannel — канал для логов банов/разбанов в игре
//
// Без канала — вызов /spvkban и /spvkunban логи никуда не шлёт.
// Вызов без опции «канал» выключает логи для этого сервера.
// ─────────────────────────────────────────────────────────────
async function handleSetGameBanLogsChannel(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      content: 'Нужно право «Управление сервером».',
      flags: MessageFlags.Ephemeral,
    });
  }

  const channelOption = interaction.options.getChannel('канал'); // null = выключить логи

  if (!channelOption) {
    settings.clearBanLogChannel(interaction.guildId);
    return interaction.reply({
      content: 'Логи банов/разбанов в игре выключены — канал не привязан.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const isTextLike =
    channelOption.type === ChannelType.GuildText ||
    channelOption.type === ChannelType.GuildAnnouncement ||
    channelOption.isTextBased?.();

  if (!isTextLike) {
    return interaction.reply({
      content: 'Нужен текстовый канал — выбери другой.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const me = interaction.guild.members.me;
  const perms = channelOption.permissionsFor?.(me);
  if (!perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({
      content: `У меня нет прав писать в ${channelOption} — дай «Просмотр канала» и «Отправка сообщений».`,
      flags: MessageFlags.Ephemeral,
    });
  }

  settings.setBanLogChannel(interaction.guildId, channelOption.id);

  return interaction.reply({
    content: `Готово: логи банов/разбанов в игре теперь идут в ${channelOption}.`,
  });
}

// ─────────────────────────────────────────────────────────────
// АНТИ-ПАДЕНИЕ
//  • ловим необработанные ошибки, чтобы процесс не умирал
//  • discord.js сам переподключается к gateway при обрывах
//  • Render перезапускает контейнер, если он всё же упал
// ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));
process.on('uncaughtException', (error) => console.error('[uncaughtException]', error));
client.on('error', (error) => console.error('[client error]', error));
client.on('shardError', (error) => console.error('[shard error]', error));
client.on('warn', (info) => console.warn('[client warn]', info));

startKeepAlive(() => ({
  bot: client.isReady() ? 'online' : 'starting',
  user: client.isReady() ? client.user.tag : null,
}));

client.login(TOKEN).catch((error) => {
  console.error('[login] не удалось войти:', error);
  process.exit(1); // Render сам перезапустит инстанс
});
