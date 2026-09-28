const {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  PermissionFlagsBits,
  InteractionContextType,
} = require('discord.js');

// ─────────────────────────────────────────────────────────────
// ЕДИНИЦЫ ВРЕМЕНИ — всплывают в автокомплите при вводе
// ─────────────────────────────────────────────────────────────
const UNITS = [
  { value: 'seconds', label: 'секунды', ms: 1_000 },
  { value: 'minutes', label: 'минуты',  ms: 60_000 },
  { value: 'hours',   label: 'часы',    ms: 3_600_000 },
  { value: 'days',    label: 'дни',     ms: 86_400_000 },
];

// ─────────────────────────────────────────────────────────────
// АЛЛИАСЫ — каждое слово становится отдельной slash-командой,
// но все они ведут в один и тот же обработчик.
// Хочешь свой аллиас? Добавь слово в нужный массив (строчными
// буквами) и перезапусти — Discord сам покажет его в меню «/».
// ─────────────────────────────────────────────────────────────
const MUTE_ALIASES = ['mute', 'мьют', 'мут', 'таймаут'];
const UNMUTE_ALIASES = ['unmute', 'размьют', 'размут'];
const LOOPCLEAR_ALIASES = ['loopclear', 'лупклир'];
const STOPLOOPCLEAR_ALIASES = ['stoploopclear', 'стоплупклир'];
const SPVKBAN_ALIASES = ['spvkban', 'спвкбан'];
const SPVKUNBAN_ALIASES = ['spvkunban', 'спвкразбан'];
const GIFBLACKLIST_ALIASES = ['gifblacklist', 'гифблеклист'];
const NAME_TO_ID_ALIASES = ['nametouserid', 'никвиди'];
const ROBLOX_INFO_ALIASES = ['getrobloxinfo', 'роблоксинфо'];

// Контекстные команды (ПКМ по сообщению → Приложения): «сделать с этим сообщением».
// Именно они закрывают сценарий «ответить командой на сообщение человека» —
// слэш-команда не видит, на какое сообщение её вызвали, а контекстная видит.
const GIF_CONTEXT_ADD = 'Gif Blacklist Add';
const GIF_CONTEXT_REMOVE = 'Gif Blacklist Remove';

const ALL_NAMES = [
  ...MUTE_ALIASES,
  ...UNMUTE_ALIASES,
  ...LOOPCLEAR_ALIASES,
  ...STOPLOOPCLEAR_ALIASES,
  ...SPVKBAN_ALIASES,
  ...SPVKUNBAN_ALIASES,
  ...GIFBLACKLIST_ALIASES,
  ...NAME_TO_ID_ALIASES,
  ...ROBLOX_INFO_ALIASES,
];

function mutedOnly(b) {
  return b
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild);
}

function buildMuteCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder()
      .setName(name)
      .setDescription('Замутить участника на любое время'),
  )
    .addUserOption((o) =>
      o.setName('участник').setDescription('Кого мутим — текстбокс с выбором участника').setRequired(true),
    )
    .addIntegerOption((o) =>
      o.setName('количество').setDescription('Любое число').setRequired(true).setMinValue(1).setMaxValue(1_000_000),
    )
    .addStringOption((o) =>
      o
        .setName('единица')
        .setDescription('Секунды, минуты, часы или дни — подсказки появятся при вводе')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('причина').setDescription('За что? (необязательно)').setRequired(false),
    );
}

function buildUnmuteCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder().setName(name).setDescription('Снять мут (тайм-аут) с участника'),
  )
    .addUserOption((o) =>
      o.setName('участник').setDescription('Кого размутить').setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('причина').setDescription('Почему размучиваем? (необязательно)').setRequired(false),
    );
}

function buildLoopClearCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder()
      .setName(name)
      .setDescription('Genius-очистка: удалять сообщения по одному, очень быстро, даже старые'),
  )
    .addUserOption((o) =>
      o
        .setName('ник')
        .setDescription('Чистить только сообщения этого участника (пусто — всех)')
        .setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName('count')
        .setDescription('Сколько проходов: 1–1000 (пусто — до самого начала канала)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(1000),
    );
}

function buildStopLoopClearCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder().setName(name).setDescription('Остановить очистку: для участника или всю'),
  ).addUserOption((o) =>
    o
      .setName('ник')
      .setDescription('Остановить лупклир этого участника (пусто — остановить полностью)')
      .setRequired(false),
  );
}

function buildSpvkBanCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder()
      .setName(name)
      .setDescription('Забанить игрока в Roblox по нику через Open Cloud'),
  )
    .addStringOption((o) => o.setName('юзернеймроблокса').setDescription('Ник игрока в Roblox').setRequired(true))
    .addIntegerOption((o) => o.setName('часы').setDescription('Время в часах (0 = перманентный бан)').setRequired(true).setMinValue(0))
    .addStringOption((o) => o.setName('причина').setDescription('Причина бана').setRequired(true))
    .addBooleanOption((o) =>
      o.setName('твинки').setDescription('Банить и твинков (альт-аккаунты)?').setRequired(false),
    );
}

function buildSpvkUnbanCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder()
      .setName(name)
      .setDescription('Разбанить игрока в Roblox по нику через Open Cloud'),
  ).addStringOption((o) => o.setName('юзернеймроблокса').setDescription('Ник игрока в Roblox').setRequired(true));
}

function buildGifBlacklistCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder()
      .setName(name)
      .setDescription('Чёрный список гифок: бот сам удаляет их из чата'),
  )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Добавить гифку в чёрный список — сообщения с ней бот будет удалять')
        .addStringOption((o) =>
          o
            .setName('ссылка')
            .setDescription('Ссылка на гифку. Пусто — откроется окошко для вставки ссылки')
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('сообщение')
            .setDescription('Ссылка на сообщение (ПКМ → Копировать ссылку на сообщение) — бот сам найдёт гифку')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Убрать гифку из чёрного списка')
        .addIntegerOption((o) =>
          o.setName('номер').setDescription('Номер записи из /gifblacklist list').setRequired(false).setMinValue(1),
        )
        .addStringOption((o) =>
          o
            .setName('ссылка')
            .setDescription('Любая ссылка на эту же гифку. Пусто — откроется окошко для вставки')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('addwhitelist')
        .setDescription('Кому можно отправлять заблокированные гифки: участник и/или роль')
        .addUserOption((o) =>
          o.setName('участник').setDescription('Этому участнику блеклист не помеха').setRequired(false),
        )
        .addRoleOption((o) =>
          o.setName('роль').setDescription('Участники с этой ролью игнорируют блеклист').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('removewhitelist')
        .setDescription('Убрать участника или роль из вайтлиста')
        .addUserOption((o) => o.setName('участник').setDescription('Кого убрать из вайтлиста').setRequired(false))
        .addRoleOption((o) => o.setName('роль').setDescription('Какую роль убрать из вайтлиста').setRequired(false)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Показать чёрный список и вайтлист'));
}

function buildNameToIdCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder()
      .setName(name)
      .setDescription('Roblox-ник → Roblox ID (ответ видишь только ты)'),
  ).addStringOption((o) => o.setName('ник').setDescription('Ник игрока в Roblox').setRequired(true));
}

function buildRobloxInfoCommand(name) {
  return mutedOnly(
    new SlashCommandBuilder()
      .setName(name)
      .setDescription('Всё про игрока Roblox: аватарка, возраст аккаунта, подписки, подписчики, друзья'),
  ).addStringOption((o) =>
    o.setName('игрок').setDescription('Ник, Roblox ID или ссылка на профиль').setRequired(true),
  );
}

const contextCommandData = [
  new ContextMenuCommandBuilder()
    .setName(GIF_CONTEXT_ADD)
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild),
  new ContextMenuCommandBuilder()
    .setName(GIF_CONTEXT_REMOVE)
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild),
].map((c) => c.toJSON());

const commandData = [
  ...MUTE_ALIASES.map(buildMuteCommand),
  ...UNMUTE_ALIASES.map(buildUnmuteCommand),
  ...LOOPCLEAR_ALIASES.map(buildLoopClearCommand),
  ...STOPLOOPCLEAR_ALIASES.map(buildStopLoopClearCommand),
  ...SPVKBAN_ALIASES.map(buildSpvkBanCommand),
  ...SPVKUNBAN_ALIASES.map(buildSpvkUnbanCommand),
  ...GIFBLACKLIST_ALIASES.map(buildGifBlacklistCommand),
  ...NAME_TO_ID_ALIASES.map(buildNameToIdCommand),
  ...ROBLOX_INFO_ALIASES.map(buildRobloxInfoCommand),
].map((c) => c.toJSON());

// ВАЖНО: Discord регистрирует команды пакетным перезаписыванием (bulk overwrite),
// поэтому в одном запросе должны лежать ВСЕ типы команд — и слэш-, и контекстные.
const allCommandData = [...commandData, ...contextCommandData];

module.exports = {
  UNITS,
  MUTE_ALIASES,
  UNMUTE_ALIASES,
  LOOPCLEAR_ALIASES,
  STOPLOOPCLEAR_ALIASES,
  SPVKBAN_ALIASES,
  SPVKUNBAN_ALIASES,
  GIFBLACKLIST_ALIASES,
  NAME_TO_ID_ALIASES,
  ROBLOX_INFO_ALIASES,
  GIF_CONTEXT_ADD,
  GIF_CONTEXT_REMOVE,
  ALL_NAMES,
  commandData,
  contextCommandData,
  allCommandData,
};
