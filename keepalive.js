// ─────────────────────────────────────────────────────────────
// АНТИ-СОН + АНТИ-СМЕРТЬ (Render free)
//
// Почему бот «молча ложится»: Render free гасит web-сервис после 15 минут БЕЗ
// ВХОДЯЩЕГО трафика, а сон/перезапуск рвёт gateway Discord — снаружи это
// выглядит как «бот просто пропал», и в канал ничего не пишется.
//
// Метод в три слоя (каждый работает, даже если два других отказали):
//   1) HTTP-сервер держит порт открытым → Render видит живой web-сервис.
//   2) ВНУТРЕННИЙ АВТОБОТ: раз в 4 минуты бот сам пингует свой публичный URL
//      (/healthz). Render сам отдаёт URL в RENDER_EXTERNAL_URL, так что
//      настраивать ничего не надо (переопределяется через PING_URL).
//   3) ВНЕШНИЙ АВТОБОТ: .github/workflows/keepalive.yml дёргает /healthz каждые
//      5 минут из GitHub Actions — он поднимает инстанс, даже если процесс умер.
//
// Плюс СТОРОЖЕВОЙ ПЁС: вместо тихой смерти — громкие логи и самоподъём:
//   • gateway не готов дольше 3 минут → destroy() + login() заново;
//   • 3 таких перезапуска за 30 минут → process.exit(1), Render поднимет контейнер;
//   • RSS выше лимита (OOM Render убивает молча) → выходим сами;
//   • меряем лаг event loop и ловим «инстанс спал» (тик опоздал больше 3 минут).
// ─────────────────────────────────────────────────────────────
const http = require('http');
const { monitorEventLoopDelay } = require('perf_hooks');

const KEEPALIVE_DEFAULTS = {
  pingIntervalMs: 4 * 60 * 1000, // внутренний пинг (Render спит после 15 минут тишины)
  watchdogIntervalMs: 60 * 1000,
  readyGraceMs: 3 * 60 * 1000,
  sleepDetectMs: 3 * 60 * 1000,
  memoryLimitMb: 460, // выше — Render рискует убить контейнер по OOM
  memoryStrikes: 3,
  recoveryWindowMs: 30 * 60 * 1000,
  maxRecoveriesPerWindow: 3,
};

function startKeepAlive(getStatus, hooks = {}) {
  const cfg = { ...KEEPALIVE_DEFAULTS, ...(hooks.config ?? {}) };
  const port = process.env.PORT || 10000;
  const selfUrl = String(hooks.selfUrl ?? process.env.PING_URL ?? process.env.RENDER_EXTERNAL_URL ?? '').trim();
  const healthy = () => (hooks.isHealthy ? hooks.isHealthy() === true : true);

  const stats = {
    startedAt: new Date().toISOString(),
    selfUrl: selfUrl || null,
    selfPings: 0,
    selfPingFails: 0,
    lastSelfPingAt: null,
    selfPingError: null,
    watchdogTicks: 0,
    recoveries: 0,
    sleeps: 0,
    lastSleepMs: null,
    downSince: null,
    memoryStrikes: 0,
    maxLoopLagMs: 0,
  };

  // ── Слой 1: держим порт открытым, отдаём /healthz ───────────
  const server = http.createServer((req, res) => {
    const path = String(req.url ?? '/').split('?')[0];
    const ok = healthy();
    const body = JSON.stringify(
      {
        status: ok ? 'ok' : 'bot-offline',
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        ...(getStatus ? getStatus() : {}),
        keepAlive: stats,
      },
      null,
      2,
    );
    res.writeHead(path === '/healthz' && !ok ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  server.keepAliveTimeout = 65_000; // Render держит соединение 60 c — не рвём первыми
  server.headersTimeout = 70_000;
  server.on('clientError', (_error, socket) => socket.destroy()); // чужой кривой сокет не должен ронять процесс
  server.on('error', (error) => console.error('[keep-alive] сервер упал:', error));
  server.listen(port, () => {
    console.log(
      `[keep-alive] HTTP-сервер слушает порт ${port} · ` +
        (selfUrl ? `самопинг: ${selfUrl}/healthz` : 'самопинг выключен (нет RENDER_EXTERNAL_URL/PING_URL)'),
    );
  });

  // ── Слой 2: внутренний автобот — пингуем себя ───────────────
  async function selfPing() {
    if (!selfUrl) return false;
    const target = `${selfUrl.replace(/\/+$/, '')}/healthz`;
    stats.lastSelfPingAt = new Date().toISOString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref?.();
    try {
      const res = await fetch(target, { signal: controller.signal, headers: { 'user-agent': 'spvk-keepalive/2' } });
      stats.selfPings += 1;
      if (res.ok) {
        stats.selfPingError = null;
        return true;
      }
      stats.selfPingFails += 1;
      stats.selfPingError = `HTTP ${res.status}`;
      console.warn(`[keep-alive] самопинг ответил ${res.status} — Render может считать сервис нездоровым`);
      return false;
    } catch (error) {
      stats.selfPingFails += 1;
      stats.selfPingError = error?.message ?? String(error);
      console.warn(`[keep-alive] самопинг не прошёл: ${stats.selfPingError}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Слой 3: сторожевой пёс (чтобы не ложился молча) ─────────
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  const recoveryTimes = [];
  let lastTickAt = Date.now();

  function callHook(name, payload) {
    const hook = hooks[name];
    if (typeof hook !== 'function') return;
    try {
      const result = hook(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error(`[watchdog] ${name} упал: ${error?.message ?? error}`));
      }
    } catch (error) {
      console.error(`[watchdog] ${name} упал: ${error?.message ?? error}`);
    }
  }

  async function watchdog() {
    const now = Date.now();
    stats.watchdogTicks += 1;

    // а) Инстанс спал? Тик опоздал сильно больше интервала → процесс замораживали.
    const late = now - lastTickAt - cfg.watchdogIntervalMs;
    lastTickAt = now;
    if (late > cfg.sleepDetectMs) {
      stats.sleeps += 1;
      stats.lastSleepMs = late;
      console.warn(`[watchdog] похоже, инстанс спал ~${Math.round(late / 1000)} c — экстренно пингую себя`);
      await selfPing();
      callHook('onWake', { sleptMs: late });
    }

    // б) Память: при OOM Render убивает контейнер молча — лучше перезапуститься самим.
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMb > cfg.memoryLimitMb) {
      stats.memoryStrikes += 1;
      console.warn(
        `[watchdog] память ${rssMb} МБ > ${cfg.memoryLimitMb} МБ (${stats.memoryStrikes}/${cfg.memoryStrikes})`,
      );
      if (stats.memoryStrikes >= cfg.memoryStrikes) {
        return callHook('onFatal', { reason: `память ${rssMb} МБ`, kind: 'memory' });
      }
    } else {
      stats.memoryStrikes = 0;
    }

    // в) Лаг event loop: большой = всё встало (сеть, диск, тяжёлый цикл).
    const lagMs = Math.round(loopDelay.max / 1e6);
    loopDelay.reset();
    stats.maxLoopLagMs = Math.max(stats.maxLoopLagMs, lagMs);
    if (lagMs > 5_000) console.warn(`[watchdog] event loop тормозил до ${lagMs} мс`);

    // г) Главное: жив ли gateway. Мёртвый gateway = «бот молча лёг».
    if (healthy()) {
      stats.downSince = null;
      return;
    }

    stats.downSince = stats.downSince ?? now;
    const downFor = now - stats.downSince;
    if (downFor < cfg.readyGraceMs) return;

    recoveryTimes.push(now);
    while (recoveryTimes.length && now - recoveryTimes[0] > cfg.recoveryWindowMs) recoveryTimes.shift();

    if (recoveryTimes.length > cfg.maxRecoveriesPerWindow) {
      console.error(
        `[watchdog] gateway не держится: ${recoveryTimes.length} перезапусков за ${Math.round(
          cfg.recoveryWindowMs / 60_000,
        )} мин — отдаю контейнер Render на перезапуск (exit 1)`,
      );
      return callHook('onFatal', { reason: 'gateway не восстанавливается', kind: 'gateway' });
    }

    stats.recoveries += 1;
    console.error(
      `[watchdog] gateway не готов ${Math.round(downFor / 1000)} c — перезапускаю подключение (#${stats.recoveries})`,
    );
    callHook('onRecover', { attempt: stats.recoveries, downMs: downFor });
  }

  const pingTimer = setInterval(selfPing, cfg.pingIntervalMs);
  pingTimer.unref?.();
  const watchdogTimer = setInterval(watchdog, cfg.watchdogIntervalMs);
  watchdogTimer.unref?.();

  // Первый пинг не через 4 минуты, а сразу: Render умеет усыпить раньше.
  const firstPing = setTimeout(selfPing, 15_000);
  firstPing.unref?.();

  console.log(
    `[keep-alive] анти-сон включён: самопинг каждые ${Math.round(cfg.pingIntervalMs / 60_000)} мин, ` +
      `сторож каждые ${Math.round(cfg.watchdogIntervalMs / 1000)} c (порог ${Math.round(
        cfg.readyGraceMs / 60_000,
      )} мин, память ${cfg.memoryLimitMb} МБ)`,
  );

  return server;
}

module.exports = { startKeepAlive, KEEPALIVE_DEFAULTS };
