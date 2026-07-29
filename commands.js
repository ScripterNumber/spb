const {
  SlashCommandBuilder,
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

const ALL_NAMES = [
  ...MUTE_ALIASES,
  ...UNMUTE_ALIASES,
  ...LOOPCLEAR_ALIASES,
  ...STOPLOOPCLEAR_ALIASES,
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

const commandData = [
  ...MUTE_ALIASES.map(buildMuteCommand),
  ...UNMUTE_ALIASES.map(buildUnmuteCommand),
  ...LOOPCLEAR_ALIASES.map(buildLoopClearCommand),
  ...STOPLOOPCLEAR_ALIASES.map(buildStopLoopClearCommand),
].map((c) => c.toJSON());

module.exports = {
  UNITS,
  MUTE_ALIASES,
  UNMUTE_ALIASES,
  LOOPCLEAR_ALIASES,
  STOPLOOPCLEAR_ALIASES,
  ALL_NAMES,
  commandData,
};
