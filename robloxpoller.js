// ─────────────────────────────────────────────────────────────
// ROBLOX POLLER — отслеживает изменения в бан-листе Roblox
// и шлёт лог в Discord-канал.
//
// Работает через polling: каждые POLL_INTERVAL мс запрашивает
// полный список банов через Open Cloud и сравнивает с предыдущим.
// Появился новый — пишем «+ Username», исчез — «- Username».
//
// Требует права API-ключа: universe.user-restriction → Read
// ─────────────────────────────────────────────────────────────

const POLL_INTERVAL = 30_000; // раз в 30 секунд
const RESTRICTIONS_BASE = 'https://apis.roblox.com/cloud/v2/universes';

// Храним предыдущее состояние: Map<userId, { name, active }>
// name берём из кэша — Roblox API в списке банов не возвращает ник,
// только userId, поэтому ник резолвим отдельно через users API.
const prevBans = new Map(); // userId -> username
let initialized = false;
let pollTimer = null;

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

// Получить все активные баны (все страницы через pageToken)
async function fetchAllBans(apiKey, universeId) {
  const bans = new Map(); // userId -> true
  let pageToken = null;

  do {
    const url = new URL(`${RESTRICTIONS_BASE}/${universeId}/user-restrictions`);
    url.searchParams.set('filter', 'gameJoinRestriction.active == true');
    url.searchParams.set('maxPageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { 'x-api-key': apiKey },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Roblox restrictions API ${res.status}: ${text}`);
    }

    const json = await res.json();
    for (const entry of json.userRestrictions ?? []) {
      // name вида "universes/xxx/user-restrictions/userId"
      const userId = entry.user?.split('/').pop() ?? entry.name?.split('/').pop();
      if (userId) bans.set(userId, true);
    }

    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  return bans;
}

// Резолвим userId -> username пачкой через публичный API
async function resolveUsernames(userIds) {
  if (!userIds.length) return new Map();
  const res = await fetch('https://users.roblox.com/v1/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds, excludeBannedUsers: false }),
  });
  if (!res.ok) return new Map();
  const json = await res.json();
  const map = new Map();
  for (const u of json?.data ?? []) {
    map.set(String(u.id), u.name);
  }
  return map;
}

// Отправить diff-сообщение в канал
async function sendLog(client, channelId, lines) {
  if (!lines.length) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    // Группируем в одно сообщение, но не больше 1900 символов
    let chunk = '';
    for (const line of lines) {
      if ((chunk + line + '\n').length > 1900) {
        await channel.send(`\`\`\`diff\n${chunk}\`\`\``);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk) await channel.send(`\`\`\`diff\n${chunk}\`\`\``);
  } catch (err) {
    console.error('[robloxpoller] не смог отправить лог:', err);
  }
}

// Один цикл опроса
async function poll({ client, getChannelId, apiKey, universeId }) {
  let currentBans;
  try {
    currentBans = await fetchAllBans(apiKey, universeId);
  } catch (err) {
    console.error('[robloxpoller] ошибка получения банов:', err);
    return;
  }

  // При первом запуске просто запоминаем состояние, ничего не логируем
  if (!initialized) {
    for (const [userId] of currentBans) {
      prevBans.set(userId, '?'); // ник узнаем при следующем изменении
    }
    initialized = true;
    console.log(`[robloxpoller] инициализация: ${currentBans.size} активных банов`);
    return;
  }

  // Новые баны (появились с прошлого опроса)
  const added = [];
  for (const [userId] of currentBans) {
    if (!prevBans.has(userId)) added.push(userId);
  }

  // Снятые баны (исчезли с прошлого опроса)
  const removed = [];
  for (const [userId] of prevBans) {
    if (!currentBans.has(userId)) removed.push(userId);
  }

  if (!added.length && !removed.length) return; // изменений нет

  // Резолвим ники для новых userId
  const needResolve = [...added, ...removed].filter((id) => !prevBans.get(id) || prevBans.get(id) === '?');
  const resolved = await resolveUsernames(needResolve);

  // Обновляем кэш
  for (const userId of added) {
    prevBans.set(userId, resolved.get(userId) ?? userId);
  }

  const lines = [];
  for (const userId of added) {
    lines.push(`+ ${prevBans.get(userId) ?? userId}`);
  }
  for (const userId of removed) {
    lines.push(`- ${prevBans.get(userId) ?? userId}`);
    prevBans.delete(userId);
  }

  const channelId = getChannelId();
  if (channelId && lines.length) {
    await sendLog(client, channelId, lines);
  }

  console.log(`[robloxpoller] изменения: +${added.length} -${removed.length}`);
}

// ─────────────────────────────────────────────────────────────
// Запуск поллера. Вызвать один раз при старте бота.
//
//   client      — discord.js Client (должен быть ready)
//   getChannelId — функция () => string|null, возвращает текущий
//                  channelId из settings (может меняться в рантайме)
// ─────────────────────────────────────────────────────────────
function startPoller({ client, getChannelId }) {
  const apiKey = process.env.ROBLOX_API_KEY;
  const universeId = process.env.ROBLOX_UNIVERSE_ID;

  if (!apiKey || !universeId) {
    console.warn('[robloxpoller] ROBLOX_API_KEY или ROBLOX_UNIVERSE_ID не заданы — поллер не запущен');
    return;
  }

  const run = async () => {
    await poll({ client, getChannelId, apiKey, universeId });
    pollTimer = setTimeout(run, POLL_INTERVAL);
    pollTimer.unref?.();
  };

  console.log(`[robloxpoller] запущен, интервал ${POLL_INTERVAL / 1000}с`);
  run();
}

function stopPoller() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

module.exports = { startPoller, stopPoller };
