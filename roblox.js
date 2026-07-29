// ─────────────────────────────────────────────────────────────
// ROBLOX — Open Cloud Ban API
//
//  Бан/разбан игрока по нику через официальный Open Cloud:
//    PATCH https://apis.roblox.com/cloud/v2/universes/{universeId}/user-restrictions/{userId}
//  Заголовок: x-api-key с правом universe.user-restriction:write.
//
//  Как завести ключ (один раз, в Creator Hub):
//    1) create.roblox.com → Creator Hub → Cloud (API) → API Keys → Create API Key
//    2) Name: spvkban · Access: выбрать свой Universe (или все, если один)
//    3) Permissions: добавить «User Restrictions» → Read & Write
//    4) Создать и скопировать ключ (больше его не покажут)
//  Ключ кладём в Render как ROBLOX_API_KEY, universe id — как ROBLOX_UNIVERSE_ID.
// ─────────────────────────────────────────────────────────────
const USERNAMES_URL = 'https://users.roblox.com/v1/usernames/users';
const RESTRICTIONS_BASE = 'https://apis.roblox.com/cloud/v2/universes';

function needEnv(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`Не задана переменная окружения ${name} — добавь её в Render → Environment.`);
    err.code = 'MISSING_ENV';
    throw err;
  }
  return value;
}

// По нику достаём userId. Публичный users API (без ключа).
async function getUserIdByUsername(username) {
  const res = await fetch(USERNAMES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Roblox users API ответил ${res.status}`), { status: res.status });
  }
  const json = await res.json();
  const hit = json?.data?.[0];
  return hit ? { id: hit.id, name: hit.name, displayName: hit.displayName } : null;
}

// Универсальный PATCH на user-restrictions
async function patchRestriction({ userId, restriction, apiKey, universeId }) {
  const url = `${RESTRICTIONS_BASE}/${universeId}/user-restrictions/${userId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ gameJoinRestriction: restriction }),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* не-json — ок */
  }

  return {
    ok: res.ok,
    status: res.status,
    data,
    raw: text,
  };
}

// ─────────────────────────────────────────────────────────────
// spvkban: duration в ЧАСАХ, 0 → перманент
// Roblox ждёт duration строкой в секундах: "3600s", либо -1 для пермамента
// (в JSON перманент иногда принимают как отсутствие duration, надёжнее -1)
// ─────────────────────────────────────────────────────────────
async function banByUsername(username, hours, reason, excludeAlts = false) {
  const apiKey = needEnv('ROBLOX_API_KEY');
  const universeId = needEnv('ROBLOX_UNIVERSE_ID');

  const lookup = await getUserIdByUsername(username);
  if (!lookup) return { ok: false, reason: 'not_found', username };

  const durationSeconds = hours > 0 ? `${hours * 3600}s` : -1;
  const restriction = {
    active: true,
    duration: durationSeconds,
    privateReason: `Выдал Discord-модератор. Причина: ${reason}`,
    displayReason: reason,
    excludeAltAccounts: excludeAlts,
    inherited: true,
  };

  const res = await patchRestriction({ userId: lookup.id, restriction, apiKey, universeId });
  return { ...res, lookup, username };
}

// ─────────────────────────────────────────────────────────────
// spvkunban: active:false снимает рестрикшн
// ─────────────────────────────────────────────────────────────
async function unbanByUsername(username) {
  const apiKey = needEnv('ROBLOX_API_KEY');
  const universeId = needEnv('ROBLOX_UNIVERSE_ID');

  const lookup = await getUserIdByUsername(username);
  if (!lookup) return { ok: false, reason: 'not_found', username };

  const res = await patchRestriction({
    userId: lookup.id,
    restriction: { active: false },
    apiKey,
    universeId,
  });
  return { ...res, lookup, username };
}

module.exports = { banByUsername, unbanByUsername, getUserIdByUsername };
