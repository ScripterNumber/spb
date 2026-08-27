const POLL_INTERVAL = 30_000;
const RESTRICTIONS_BASE = 'https://apis.roblox.com/cloud/v2/universes';

const prevBans = new Map();
let initialized = false;
let pollTimer = null;

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

async function fetchAllBans(apiKey, universeId) {
  const bans = new Map();
  let pageToken = null;

  do {
    const url = new URL(`${RESTRICTIONS_BASE}/${universeId}/user-restrictions`);
    // Убираем filter — некоторые версии API его игнорируют или не поддерживают,
    // тянем всё и фильтруем сами
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
      // Берём только активные баны
      if (!entry.gameJoinRestriction?.active) continue;

      // userId достаём из поля user или из name
      // Форматы: "users/12345" или "universes/xxx/user-restrictions/12345"
      let userId = null;
      if (entry.user) {
        userId = entry.user.split('/').pop();
      } else if (entry.name) {
        userId = entry.name.split('/').pop();
      }

      if (userId) bans.set(userId, true);
    }

    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  return bans;
}

async function resolveUsernames(userIds) {
  if (!userIds.length) return new Map();
  const res = await fetch('https://users.roblox.com/v1/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds: userIds.map(Number), excludeBannedUsers: false }),
  });
  if (!res.ok) {
    console.error('[robloxpoller] resolveUsernames ошибка:', res.status);
    return new Map();
  }
  const json = await res.json();
  const map = new Map();
  for (const u of json?.data ?? []) {
    map.set(String(u.id), u.name);
  }
  return map;
}

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

async function poll({ client, getChannelId, apiKey, universeId }) {
  let currentBans;
  try {
    currentBans = await fetchAllBans(apiKey, universeId);
  } catch (err) {
    console.error('[robloxpoller] ошибка получения банов:', err);
    return;
  }

  if (!initialized) {
    for (const [userId] of currentBans) {
      prevBans.set(userId, '?');
    }
    initialized = true;
    console.log(`[robloxpoller] инициализация: ${currentBans.size} активных банов`);
    return;
  }

  // Новые баны
  const added = [];
  for (const [userId] of currentBans) {
    if (!prevBans.has(userId)) added.push(userId);
  }

  // Снятые баны
  const removed = [];
  for (const [userId] of prevBans) {
    if (!currentBans.has(userId)) removed.push(userId);
  }

  console.log(`[robloxpoller] poll: было=${prevBans.size} стало=${currentBans.size} +${added.length} -${removed.length}`);

  if (!added.length && !removed.length) return;

  // Резолвим только неизвестные ники
  const needResolve = [...added, ...removed].filter((id) => !prevBans.get(id) || prevBans.get(id) === '?');
  const resolved = await resolveUsernames(needResolve);

  const lines = [];

  for (const userId of added) {
    const name = resolved.get(userId) ?? userId;
    prevBans.set(userId, name);
    lines.push(`+ ${name}`);
  }

  for (const userId of removed) {
    const name = prevBans.get(userId) ?? userId;
    lines.push(`- ${name}`);
    prevBans.delete(userId);
  }

  const channelId = getChannelId();
  console.log(`[robloxpoller] channelId из settings: ${channelId}`);

  if (channelId && lines.length) {
    await sendLog(client, channelId, lines);
  } else if (!channelId) {
    console.warn('[robloxpoller] канал логов не задан — пропускаем отправку');
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
