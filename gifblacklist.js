// ─────────────────────────────────────────────────────────────
// GIF BLACKLIST — чёрный список гифок + авто-удаление
//
// Задача: одну и ту же гифку люди кидают разными ссылками:
//  • прокси Discord:  https://images-ext-1.discordapp.net/external/<hmac>/https/static.klipy.com/ii/<id>/...mp4
//  • прямая ссылка:   https://static.klipy.com/ii/<id>/...mp4
//  • прямая ссылка с подписью: ...?ex=...&is=...&hm=...
// Поэтому в блеклист пишется не строка, а НАБОР подписей (signature):
//  • keys      — «хост + путь» в нижнем регистре, без query и #;
//  • tokens    — длинные хеш-подобные токены из пути (id гифки, hmac прокси);
//  • filenames — имя файла (15lktkqmwrmszdt.mp4), только «специфичные»;
//  • sha256    — хеш самого файла + его размер (ловит ре-аплоад того же файла).
// Сообщение считается «этой самой гифкой», если совпал любой key,
// любой token или размер+sha256 вложения.
//
// Хранилище: configs/gifblacklist.json (путь можно переопределить
// переменной окружения GIF_BLACKLIST_PATH — например, на Render).
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PermissionFlagsBits } = require('discord.js');

const STORAGE_PATH = process.env.GIF_BLACKLIST_PATH
  ? path.resolve(process.env.GIF_BLACKLIST_PATH)
  : path.join(__dirname, 'configs', 'gifblacklist.json');

// Владелец сервера и участники с правом «Администратор» пропускаются всегда.
// Не нравится — поставь false, тогда эти права придётся выдать через вайтлист.
const BYPASS_ADMINS = true;

const MAX_HASH_BYTES = 16 * 1024 * 1024; // больше 16 МБ не качаем — только подписи URL
const HASH_TIMEOUT_MS = 10_000;
const TOKEN_MIN_LENGTH = 16;

const URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

let state = null; // ленивая копия файла в памяти: файл читается один раз за запуск

function load() {
  if (state) return state;
  try {
    const raw = fs.readFileSync(STORAGE_PATH, 'utf8').trim();
    state = normalizeState(raw ? JSON.parse(raw) : {});
    console.log(`[gifblacklist] загружено ${state.gifs.length} записей из ${STORAGE_PATH}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[gifblacklist] не прочитал ${STORAGE_PATH}: ${error.message} — начинаю с пустого списка`);
    }
    state = normalizeState({});
  }
  return state;
}

function normalizeState(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const gifs = Array.isArray(source.gifs) ? source.gifs.filter((e) => e && typeof e.url === 'string') : [];
  const users = Array.isArray(source.whitelist?.users) ? source.whitelist.users.filter((u) => u && u.id) : [];
  const roles = Array.isArray(source.whitelist?.roles) ? source.whitelist.roles.filter((r) => r && r.id) : [];
  const strikes = source.strikes && typeof source.strikes === 'object' ? source.strikes : {};

  return {
    gifs: gifs.map((entry, index) => ({
      id: Number.isInteger(entry.id) ? entry.id : index + 1,
      url: entry.url,
      keys: Array.isArray(entry.keys) ? entry.keys : [],
      tokens: Array.isArray(entry.tokens) ? entry.tokens : [],
      filenames: Array.isArray(entry.filenames) ? entry.filenames : [],
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
      addedById: entry.addedById ?? null,
      addedByTag: entry.addedByTag ?? null,
      addedAt: entry.addedAt ?? null,
    })),
    whitelist: {
      users: users.map((u) => ({ id: String(u.id), tag: u.tag ?? null, addedAt: u.addedAt ?? null })),
      roles: roles.map((r) => ({ id: String(r.id), name: r.name ?? null, addedAt: r.addedAt ?? null })),
    },
    // Счётчик нарушений: userId -> { count, firstAt, lastAt }
    strikes: Object.fromEntries(
      Object.entries(strikes)
        .filter(([userId, value]) => /^\d+$/.test(userId) && value && typeof value === 'object')
        .map(([userId, value]) => [
          userId,
          {
            count: Number.isFinite(value.count) ? value.count : 0,
            firstAt: value.firstAt ?? null,
            lastAt: value.lastAt ?? null,
          },
        ]),
    ),
  };
}

// Пишем через временный файл + rename — так json не побьётся при падении процесса.
function save() {
  const store = load();
  try {
    fs.mkdirSync(path.dirname(STORAGE_PATH), { recursive: true });
    const tmp = `${STORAGE_PATH}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, STORAGE_PATH);
  } catch (error) {
    console.error(`[gifblacklist] не сохранил ${STORAGE_PATH}: ${error.message}`);
    throw error;
  }
}

function nextId(store) {
  return store.gifs.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0) + 1;
}

// ─────────────────────────────────────────────────────────────
// ПОДПИСИ URL
// ─────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  let value = String(raw ?? '').trim();
  value = value.replace(/^<|>$/g, ''); // <https://...> — так Discord отдаёт ссылки
  value = value.replace(/[.,;:!?)\]}>"']+$/, ''); // хвостовая пунктуация из текста
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function decodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

// /external/<hmac>/https/static.klipy.com/... и /external/<hmac>/https%3A%2F%2Fstatic.klipy.com/...
function unwrapProxy(hostname, pathname) {
  if (!/(^|\.)discordapp\.(net|com)$/i.test(hostname)) return null;
  const match = pathname.match(/^\/external\/([^/]+)\/(https?)[:/]+(.+)$/i);
  if (!match) return null;
  return { hmac: match[1].toLowerCase(), inner: `${match[2].toLowerCase()}://${match[3]}` };
}

function collectSignatures(parsed, sig, depth) {
  const hostname = parsed.hostname.toLowerCase();
  const pathname = decodePath(parsed.pathname).toLowerCase();
  if (!pathname || pathname === '/') return;

  sig.keys.add(`${hostname}${pathname}`);

  const parts = pathname.split('/').filter(Boolean);
  for (const part of parts) {
    if (part.length >= TOKEN_MIN_LENGTH && /^[a-z0-9_-]+$/.test(part)) sig.tokens.add(part);
  }

  const filename = parts[parts.length - 1] ?? '';
  if (filename && /\.[a-z0-9]{2,5}$/.test(filename)) sig.filenames.add(filename);

  const proxy = unwrapProxy(hostname, pathname);
  if (proxy) {
    sig.tokens.add(proxy.hmac);
    const inner = depth < 3 ? normalizeUrl(proxy.inner) : null;
    if (inner) collectSignatures(inner, sig, depth + 1);
  }
}

// Подпись одной ссылки: ключи, токены и имена файлов в нижнем регистре.
function signatureOf(rawUrl) {
  const parsed = normalizeUrl(rawUrl);
  if (!parsed) return null;
  const sig = { keys: new Set(), tokens: new Set(), filenames: new Set() };
  collectSignatures(parsed, sig, 0);
  return { keys: [...sig.keys], tokens: [...sig.tokens], filenames: [...sig.filenames] };
}

// Имя файла вроде «gif.gif» ничего не доказывает — по одному имени не баним.
function isSpecificFilename(name) {
  if (!name) return false;
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  if (base.length >= 12) return true;
  return base.length >= 6 && /\d/.test(base);
}

// ─────────────────────────────────────────────────────────────
// СБОР ССЫЛОК ИЗ СООБЩЕНИЯ
// ─────────────────────────────────────────────────────────────
function collectUrlsFromMessage(message) {
  const urls = [];
  const push = (value) => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
    urls.push(value);
  };

  const content = String(message.content ?? '');
  for (const match of content.matchAll(URL_REGEX)) push(match[0]);

  for (const attachment of message.attachments?.values?.() ?? []) {
    push(attachment.url);
    push(attachment.proxyURL);
  }

  for (const embed of message.embeds ?? []) {
    const data = embed?.data ?? embed ?? {};
    push(data.url);
    for (const key of ['image', 'thumbnail', 'video']) {
      push(data[key]?.url);
      push(data[key]?.proxyURL);
    }
  }

  return [...new Set(urls)];
}

function signaturesFromMessage(message) {
  const out = [];
  for (const url of collectUrlsFromMessage(message)) {
    const sig = signatureOf(url);
    if (sig && sig.keys.length) out.push({ url, sig });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// ХЕШ ФАЙЛА — второй эшелон: тот же файл залили заново, URL новый
// ─────────────────────────────────────────────────────────────
async function downloadForHash(rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HASH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(rawUrl, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) return null;
    const announced = Number(res.headers.get('content-length') ?? 0);
    if (announced > MAX_HASH_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_HASH_BYTES) return null;
    return { sha256: crypto.createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
  } catch (error) {
    console.warn(`[gifblacklist] не смог скачать ${rawUrl}: ${error?.message ?? error}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const hashCache = new Map(); // url -> sha256 | null

async function sha256OfUrl(rawUrl) {
  const key = String(rawUrl);
  if (hashCache.has(key)) return hashCache.get(key);
  const digest = await downloadForHash(key);
  const value = digest?.sha256 ?? null;
  if (hashCache.size > 500) hashCache.delete(hashCache.keys().next().value);
  hashCache.set(key, value);
  return value;
}

function matchesSignature(entry, sig) {
  if (!sig) return false;
  for (const key of sig.keys) {
    if (entry.keys.includes(key)) return true;
  }
  for (const token of sig.tokens) {
    if (entry.tokens.includes(token)) return true;
  }
  for (const filename of sig.filenames) {
    if (entry.filenames.includes(filename) && isSpecificFilename(filename)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// ЧЁРНЫЙ СПИСОК: добавить / убрать / показать
// ─────────────────────────────────────────────────────────────
async function addGif(rawUrl, actor = {}) {
  const sig = signatureOf(rawUrl);
  if (!sig || !sig.keys.length) {
    return { ok: false, error: 'Это не похоже на ссылку. Нужна обычная http(s)-ссылка на гифку.' };
  }

  const store = load();
  const duplicate = store.gifs.find((entry) => matchesSignature(entry, sig));
  if (duplicate) return { ok: false, duplicate: true, entry: duplicate };

  const value = String(rawUrl).trim();
  const digest = await downloadForHash(value); // подсеть может не пустить — тогда обойдёмся подписями

  const entry = {
    id: nextId(store),
    url: value,
    keys: sig.keys,
    tokens: sig.tokens,
    filenames: sig.filenames,
    sha256: digest?.sha256 ?? null,
    bytes: digest?.bytes ?? null,
    addedById: actor.id ?? null,
    addedByTag: actor.tag ?? null,
    addedAt: new Date().toISOString(),
  };

  store.gifs.push(entry);
  save();
  return { ok: true, entry };
}

function removeGif({ id = null, url = null } = {}) {
  const store = load();

  if (Number.isInteger(id)) {
    const removed = store.gifs.filter((entry) => entry.id === id);
    if (!removed.length) {
      return { ok: false, error: `Записи №${id} в блеклисте нет. Номера видно в /gifblacklist list.` };
    }
    store.gifs = store.gifs.filter((entry) => entry.id !== id);
    save();
    return { ok: true, removed };
  }

  if (url) {
    const sig = signatureOf(url);
    if (!sig || !sig.keys.length) {
      return { ok: false, error: 'Это не похоже на ссылку. Укажи ссылку на гифку или номер записи.' };
    }
    const removed = store.gifs.filter((entry) => matchesSignature(entry, sig));
    if (!removed.length) return { ok: false, error: 'Такой гифки в блеклисте нет.' };
    const ids = new Set(removed.map((entry) => entry.id));
    store.gifs = store.gifs.filter((entry) => !ids.has(entry.id));
    save();
    return { ok: true, removed };
  }

  return { ok: false, error: 'Укажи ссылку на гифку или номер записи из /gifblacklist list.' };
}

function listGifs() {
  return [...load().gifs].sort((a, b) => a.id - b.id);
}

// ─────────────────────────────────────────────────────────────
// ВАЙТЛИСТ: кому можно отправлять заблокированные гифки
// ─────────────────────────────────────────────────────────────
function addWhitelistUser(user, actor = {}) {
  const store = load();
  const id = String(user.id);
  const existing = store.whitelist.users.find((u) => u.id === id);
  if (existing) return { ok: false, duplicate: true, entry: existing };

  const entry = {
    id,
    tag: user.tag ?? user.username ?? id,
    addedById: actor.id ?? null,
    addedAt: new Date().toISOString(),
  };
  store.whitelist.users.push(entry);
  save();
  return { ok: true, entry };
}

function removeWhitelistUser(userId) {
  const store = load();
  const id = String(userId);
  if (!store.whitelist.users.some((u) => u.id === id)) {
    return { ok: false, error: 'Этого участника в вайтлисте нет.' };
  }
  store.whitelist.users = store.whitelist.users.filter((u) => u.id !== id);
  save();
  return { ok: true };
}

function addWhitelistRole(role, actor = {}) {
  const store = load();
  const id = String(role.id);
  const existing = store.whitelist.roles.find((r) => r.id === id);
  if (existing) return { ok: false, duplicate: true, entry: existing };

  const entry = {
    id,
    name: role.name ?? id,
    addedById: actor.id ?? null,
    addedAt: new Date().toISOString(),
  };
  store.whitelist.roles.push(entry);
  save();
  return { ok: true, entry };
}

function removeWhitelistRole(roleId) {
  const store = load();
  const id = String(roleId);
  if (!store.whitelist.roles.some((r) => r.id === id)) {
    return { ok: false, error: 'Этой роли в вайтлисте нет.' };
  }
  store.whitelist.roles = store.whitelist.roles.filter((r) => r.id !== id);
  save();
  return { ok: true };
}

function listWhitelist() {
  const store = load();
  return { users: [...store.whitelist.users], roles: [...store.whitelist.roles] };
}

function isUserIdWhitelisted(userId) {
  if (!userId) return false;
  const id = String(userId);
  return load().whitelist.users.some((u) => u.id === id);
}

// ─────────────────────────────────────────────────────────────
// СТРАЙКИ: сколько раз человек прислал заблокированную гифку
// ─────────────────────────────────────────────────────────────
const STRIKE_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // старше 30 дней — мусор, чистим

function addStrike(userId, windowMs) {
  const id = String(userId);
  const store = load();
  const now = Date.now();

  const current = store.strikes[id] ?? null;
  const firstAt = Date.parse(current?.firstAt ?? '');
  const expired = !Number.isFinite(firstAt) || now - firstAt > windowMs;

  const strike = expired
    ? { count: 1, firstAt: new Date(now).toISOString(), lastAt: new Date(now).toISOString() }
    : {
        count: (Number(current?.count) || 0) + 1,
        firstAt: current.firstAt,
        lastAt: new Date(now).toISOString(),
      };

  store.strikes[id] = strike;

  // Заодно подчищаем древние записи, чтобы json не пух.
  for (const [key, value] of Object.entries(store.strikes)) {
    const stamp = Date.parse(value?.lastAt ?? value?.firstAt ?? '');
    if (Number.isFinite(stamp) && now - stamp > STRIKE_KEEP_MS) delete store.strikes[key];
  }

  save();
  return { count: strike.count, firstAt: strike.firstAt };
}

function resetStrikes(userId) {
  const store = load();
  const id = String(userId);
  if (!store.strikes[id]) return false;
  delete store.strikes[id];
  save();
  return true;
}

function listStrikes() {
  return Object.entries(load().strikes)
    .map(([userId, value]) => ({ userId, count: value.count ?? 0, lastAt: value.lastAt ?? null }))
    .sort((a, b) => b.count - a.count);
}

// ─────────────────────────────────────────────────────────────
// ПОИСК СОВПАДЕНИЙ В СООБЩЕНИИ
// ─────────────────────────────────────────────────────────────
async function findMatches(message) {
  const store = load();
  if (!store.gifs.length) return [];

  const hits = new Map(); // id записи -> запись

  for (const { sig } of signaturesFromMessage(message)) {
    for (const entry of store.gifs) {
      if (!hits.has(entry.id) && matchesSignature(entry, sig)) hits.set(entry.id, entry);
    }
  }

  // Второй эшелон: вложение того же размера, что заблокированный файл,
  // проверяем по sha256 — так ловится повторная заливка того же файла.
  const hashed = store.gifs.filter((entry) => entry.sha256 && entry.bytes);
  if (hashed.length && message.attachments?.size) {
    for (const attachment of message.attachments.values()) {
      const size = Number(attachment.size ?? 0);
      if (!size || !hashed.some((entry) => entry.bytes === size)) continue;
      const sha = await sha256OfUrl(attachment.url);
      if (!sha) continue;
      const hit = hashed.find((entry) => entry.sha256 === sha);
      if (hit) hits.set(hit.id, hit);
    }
  }

  return [...hits.values()];
}

// ─────────────────────────────────────────────────────────────
// ВАЙТЛИСТ: проверка автора сообщения
// ─────────────────────────────────────────────────────────────
const memberCache = new Map(); // userId -> { expires, roleIds, isAdmin, owner }

async function resolveMemberInfo(message) {
  const guild = message.guild;
  const userId = message.author?.id;
  if (!guild || !userId) return null;

  const cached = memberCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached;

  // member приезжает в самом событии; если данных нет — берём участника через REST.
  const member = message.member ?? (await guild.members.fetch({ user: userId }).catch(() => null));
  if (!member) return null;

  let isAdmin = false;
  try {
    isAdmin = member.roles.cache.some((role) => role.permissions.has(PermissionFlagsBits.Administrator));
  } catch {
    isAdmin = false;
  }

  const info = {
    expires: Date.now() + 60_000,
    roleIds: new Set(member.roles.cache.keys()),
    isAdmin,
    owner: guild.ownerId === userId,
  };

  if (memberCache.size > 1000) memberCache.delete(memberCache.keys().next().value);
  memberCache.set(userId, info);
  return info;
}

async function isWhitelisted(message) {
  if (isUserIdWhitelisted(message.author?.id)) return true;

  const store = load();
  const info = await resolveMemberInfo(message);
  if (!info) {
    // Участника не достали (REST не ответил): если роли в вайтлисте настроены,
    // честно предупреждаем, что проверить их не смогли.
    if (store.whitelist.roles.length) {
      console.warn(
        `[gifblacklist] не смог получить участника ${message.author?.id} — роли вайтлиста не проверены`,
      );
    }
    return false;
  }

  if (BYPASS_ADMINS && (info.owner || info.isAdmin)) return true;

  if (!store.whitelist.roles.length) return false;
  return store.whitelist.roles.some((role) => info.roleIds.has(role.id));
}

module.exports = {
  STORAGE_PATH,
  signatureOf,
  collectUrlsFromMessage,
  addGif,
  removeGif,
  listGifs,
  addWhitelistUser,
  removeWhitelistUser,
  addWhitelistRole,
  removeWhitelistRole,
  listWhitelist,
  isUserIdWhitelisted,
  isWhitelisted,
  findMatches,
  addStrike,
  resetStrikes,
  listStrikes,
};
