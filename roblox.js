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

// ─────────────────────────────────────────────────────────────
// ПУБЛИЧНЫЕ ROBLOX-API (без ключей) — для /nametouserid и /getrobloxinfo
//   Ник → ID:   POST users.roblox.com/v1/usernames/users
//   Профиль:    GET  users.roblox.com/v1/users/{id}
//   Аватарка:   GET  thumbnails.roblox.com/v1/users/avatar-headshot?size=420x420
//   Счётчики:   GET  friends.roblox.com/v1/users/{id}/{followings|followers|friends}/count
// ─────────────────────────────────────────────────────────────
const USERS_API = 'https://users.roblox.com/v1/users';
const THUMBNAILS_API = 'https://thumbnails.roblox.com/v1/users';
const FRIENDS_API = 'https://friends.roblox.com/v1/users';

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw Object.assign(new Error(`Roblox ответил ${res.status}`), { status: res.status });
  }
  return res.json();
}

// Профиль по числовому ID. null — такого игрока нет.
async function getUserById(userId) {
  if (!/^\d+$/.test(String(userId ?? ''))) return null;

  const res = await fetch(`${USERS_API}/${userId}`);
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) {
    throw Object.assign(new Error(`Roblox users API ответил ${res.status}`), { status: res.status });
  }

  const data = await res.json();
  if (!data?.id) return null;

  return {
    id: data.id,
    name: data.name,
    displayName: data.displayName,
    created: data.created ?? null,
    isBanned: data.isBanned === true,
    hasVerifiedBadge: data.hasVerifiedBadge === true,
  };
}

// Принимает ник, числовой ID или ссылку на профиль — отдаёт профиль.
async function resolveRobloxUser(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const fromLink = raw.match(/roblox\.com\/users\/(\d+)/i);
  if (fromLink) return getUserById(fromLink[1]);
  if (/^\d+$/.test(raw)) return getUserById(raw);

  const lookup = await getUserIdByUsername(raw);
  if (!lookup) return null;

  // Профиль мог не отдаться (приватность/лимит) — соберём что есть из самого поиска ника.
  return (
    (await getUserById(lookup.id)) ?? {
      id: lookup.id,
      name: lookup.name,
      displayName: lookup.displayName,
      created: null,
      isBanned: false,
      hasVerifiedBadge: false,
    }
  );
}

// Гениальный фетч аватарки: официальный thumbnails API (Stable), а если он
// притих — старый headshot-thumbnail, который отдаёт картинку тем же 420x420.
async function getHeadshotUrl(userId, size = '420x420') {
  try {
    const json = await getJson(
      `${THUMBNAILS_API}/avatar-headshot?userIds=${userId}&size=${size}&format=Png&isCircular=false`,
    );
    const hit = json?.data?.[0];
    if (hit?.state === 'Completed' && hit.imageUrl) return hit.imageUrl;
  } catch (error) {
    console.warn(`[roblox] thumbnails API не отдал аватарку (${error?.message}) — пробую фолбэк`);
  }
  return `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=420&height=420&format=png`;
}

async function getCount(url) {
  try {
    const json = await getJson(url);
    const count = Number(json?.count);
    return Number.isFinite(count) ? count : null;
  } catch (error) {
    // Эндпоинты счётчиков иногда меняются — команда не должна падать из-за них.
    console.warn(`[roblox] счётчик не отдался (${url}): ${error?.message}`);
    return null;
  }
}

async function getSocialCounts(userId) {
  const [followings, followers, friends] = await Promise.all([
    getCount(`${FRIENDS_API}/${userId}/followings/count`),
    getCount(`${FRIENDS_API}/${userId}/followers/count`),
    getCount(`${FRIENDS_API}/${userId}/friends/count`),
  ]);
  return { followings, followers, friends };
}

module.exports = {
  banByUsername,
  unbanByUsername,
  getUserIdByUsername,
  getUserById,
  resolveRobloxUser,
  getHeadshotUrl,
  getSocialCounts,
};
