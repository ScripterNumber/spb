// ─────────────────────────────────────────────────────────────
// ROBLOX POLLER — отслеживает изменения в бан-листе Roblox
// и шлёт лог в Discord-канал.
// ─────────────────────────────────────────────────────────────

const POLL_INTERVAL = 30_000; // опрос каждые 30 секунд
const RESTRICTIONS_BASE = 'https://apis.roblox.com/cloud/v2/universes';

const prevBans = new Map(); // userId -> username (или '?' до первого резолва)
let initialized = false;
let pollTimer = null;

// Получить все активные баны
async function fetchAllBans(apiKey, universeId) {
  const bans = new Map();
  let pageToken = null;

  do {
    const url = new URL(`${RESTRICTIONS_BASE}/${universeId}/user-restrictions`);
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
      if (!entry.gameJoinRestriction?.active) continue;

      let userId = null;
      if (entry.user) {
        userId = String(entry.user).split('/').pop();
      } else if (entry.name) {
        userId = String(entry.name).split('/').pop();
      }

      if (userId) bans.set(String(userId), true);
    }

    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  return bans;
}

// Резолвим userId -> username пачками до 100 шт
async function resolveUsernames(userIds) {
  if (!userIds.length) return new Map();

  const validIds = userIds
    .map((id) => Number(id))
    .filter((n) => !isNaN(n) && n > 0);

  if (!validIds.length) return new Map();

  const map = new Map();

  // Roblox /v1/users принимает максимум 100 id за один запрос
  for (let i = 0; i < validIds.length; i += 100) {
    const batch = validIds.slice(i, i + 100);
    try {
      const res = await fetch('https://users.roblox.com/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
      });

      if (!res.ok) {
        console.error(`[robloxpoller] ошибка resolveUsernames (статус ${res.status})`);
        continue;
      }

      const json = await res.json();
      for (const u of json?.data ?? []) {
        if (u?.id && u?.name) {
          map.set(String(u.id), u.name);
        }
      }
    } catch (err) {
      console.error('[robloxpoller] ошибка сети при резолве ников:', err);
    }
  }

  return map;
}

// Отправка сообщений в канал Discord
async function sendLog(client, channelId, lines) {
  if (!lines.length) return;
  console.log(`[robloxpoller] шлём лог в канал ${channelId}:`, lines);
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.error('[robloxpoller] канал не текстовый или не найден');
      return;
    }

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

// Один такт опроса
async function poll({ client, getChannelId, apiKey, universeId }) {
  let currentBans;
  try {
    currentBans = await fetchAllBans(apiKey, universeId);
  } catch (err) {
    console.error('[robloxpoller] ошибка получения банов:', err);
    return;
  }

  // При первом запуске молча сохраняем текущий список банов
  if (!initialized) {
    for (const [userId] of currentBans) {
      prevBans.set(userId, '?');
    }
    initialized = true;
    console.log(`[robloxpoller] инициализация: ${currentBans.size} активных банов`);
    return;
  }

  // Новые баны (появились)
  const added = [];
  for (const [userId] of currentBans) {
    if (!prevBans.has(userId)) added.push(userId);
  }

  // Снятые баны (пропали)
  const removed = [];
  for (const [userId] of prevBans) {
    if (!currentBans.has(userId)) removed.push(userId);
  }

  if (!added.length && !removed.length) return;

  console.log(`[robloxpoller] poll: было=${prevBans.size} стало=${currentBans.size} +${added.length} -${removed.length}`);

  // Собираем список id, для которых надо узнать ник через API
  const needResolve = [];
  for (const id of added) {
    if (!prevBans.has(id) || prevBans.get(id) === '?') needResolve.push(id);
  }
  for (const id of removed) {
    if (!prevBans.has(id) || prevBans.get(id) === '?') needResolve.push(id);
  }

  const resolved = await resolveUsernames(needResolve);

  const lines = [];

  // Обработка добавлений (+)
  for (const userId of added) {
    let name = resolved.get(userId);
    if (!name) {
      const cached = prevBans.get(userId);
      if (cached && cached !== '?') name = cached;
    }
    if (!name) name = userId; // запасной вариант — id вместо '?'

    prevBans.set(userId, name);
    lines.push(`+ ${name}`);
  }

  // Обработка снятий (-)
  for (const userId of removed) {
    let name = resolved.get(userId);
    if (!name) {
      const cached = prevBans.get(userId);
      if (cached && cached !== '?') name = cached;
    }
    if (!name) name = userId; // запасной вариант — id вместо '?'

    lines.push(`- ${name}`);
    prevBans.delete(userId);
  }

  const channelId = getChannelId();
  if (channelId && lines.length) {
    await sendLog(client, channelId, lines);
  }
}

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
