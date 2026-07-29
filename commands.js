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
// но все они ведут в один и тот же обработчик мута.
// Хочешь свой аллиас? Просто добавь слово сюда (строчными буквами)
// и перезапусти бота — Discord сам покажет его в меню «/».
// ─────────────────────────────────────────────────────────────
const MUTE_ALIASES = ['mute', 'мьют', 'мут', 'таймаут'];

function buildMuteCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription('Замутить участника на любое время')
    // Команда видна и доступна только тем, у кого есть право «Модерировать участников»
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    // Только на серверах, не в личке
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('участник')
        .setDescription('Кого мутим — текстбокс с выбором участника')
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('количество')
        .setDescription('Любое число')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1_000_000),
    )
    .addStringOption((option) =>
      option
        .setName('единица')
        .setDescription('Секунды, минуты, часы или дни — подсказки появятся при вводе')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName('причина')
        .setDescription('За что? (необязательно)')
        .setRequired(false),
    );
}

// JSON-описания всех команд для регистрации через REST
const commandData = MUTE_ALIASES.map((alias) => buildMuteCommand(alias).toJSON());

module.exports = { UNITS, MUTE_ALIASES, commandData };
