// ─────────────────────────────────────────────────────────────
// LOOPCLEAR — гениальная очистка канала
//
// Принцип: в канале — МАКСИМУМ ОДИН лупклир. Он идёт от новых
// сообщений к старым страницами по 100 (before-курсор), выковыривает
// нужные и удаляет ИХ ПО ОДНОМУ, на максимальной скорости rate-limit.
//
// Гении уровня:
//  • старые сообщения (14+ дней) удаляются принудительно — message.delete()
//    не имеет ограничения по возрасту, в отличие от bulkDelete;
//  • свежие (до 100 шт за раз) уносятся bulkDelete — это в десятки раз
//    быстрее, так что «по одному» применяется ровно там, где это требуется;
//  • count 1–1000 — количество проходов по удалениям: каждый проход это
//    одно удалённое сообщение. Закончились раньше — честно скажем;
//  • без count — копаем до первого сообщения канала, хоть бесконечно;
//  • одинаковый фильтр дважды не запускается (дедупликация), зато его
//    можно превратить в другой фильтр через /stoploopclear + новый старт.
// ─────────────────────────────────────────────────────────────
const BULK_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // bulkDelete: только < 14 дней

const loops = new Map(); // channelId -> loop

function isActive(channelId) {
  return loops.has(channelId);
}

function currentTargetId(channelId) {
  return loops.get(channelId)?.targetId ?? null;
}

function stopLoop(channelId, userId) {
  const loop = loops.get(channelId);
  if (!loop) return { stopped: false };
  if (userId && loop.targetId && loop.targetId !== userId) return { stopped: false };
  loop.stop();
  return { stopped: true };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function startLoop({ channel, targetId = null, count = null }) {
  if (loops.has(channel.id)) return null;

  const loop = {
    channel,
    targetId,
    count,
    deleted: 0,
    stopped: false,
    startedAt: Date.now(),
    onTick: null, // хендлер назначается снаружи после возврата loop
    stop() {
      this.stopped = true;
    },
  };
  loops.set(channel.id, loop);

  const tick = () => {
    loop.onTick?.({ deleted: loop.deleted });
  };

  (async () => {
    let before = null; // курсор: идём от новых к старым

    while (!loop.stopped) {
      // ── нет бюджета удалений ────────────────────────────
      if (loop.count !== null && loop.deleted >= loop.count) break;

      // ── тянем страницу истории (100 шт) ─────────────────
      let page;
      try {
        const options = { limit: 100, cache: false };
        if (before) options.before = before;
        page = await channel.messages.fetch(options);
      } catch (error) {
        console.error('[loopclear] fetch страницы упал:', error);
        await sleep(1500);
        continue; // ретрай — канал точно не бросаем
      }
      if (loop.stopped) break;

      const messages = [...page.values()];
      if (messages.length === 0) break; // дошли до первого сообщения канала

      // фильтруем: закрепы не трогаем, по нику — только его
      let candidates = messages.filter(
        (m) => m.deletable && !m.pinned && (!loop.targetId || m.author.id === loop.targetId),
      );
      if (loop.count !== null) {
        candidates = candidates.slice(0, loop.count - loop.deleted);
      }

      if (candidates.length) {
        const freshThreshold = Date.now() - BULK_MAX_AGE;
        const fresh = candidates.filter((m) => m.createdTimestamp > freshThreshold);
        const oldOnes = candidates.filter((m) => m.createdTimestamp <= freshThreshold);

        // ── свежие: быстрый bulkDelete (группами до 100) ──
        while (fresh.length && !loop.stopped) {
          const batch = fresh.splice(0, 100);
          try {
            const res = await channel.bulkDelete(batch, true);
            loop.deleted += res.size;
          } catch {
            // bulkDelete внезапно отказал — докидываем в «по одному»
            oldOnes.push(...batch);
          }
          tick();
        }

        // ── старые и непокорные: удаляем ПО ОДНОМУ, очень быстро ──
        for (const message of oldOnes) {
          if (loop.stopped) break;
          if (loop.count !== null && loop.deleted >= loop.count) break;
          try {
            await message.delete();
            loop.deleted++;
          } catch (error) {
            const code = error?.code;
            if (code === 10008) {
              /* уже удалено — ок */
            } else if (code === 429 || error?.status === 429) {
              const retryAfter = Math.min(((error?.retryAfter ?? 1) || 1) * 1000, 5000);
              console.warn(`[loopclear] rate limit, пауза ${retryAfter}ms`);
              await sleep(retryAfter);
            } else {
              console.error(`[loopclear] не удалил ${message.id}: code=${code} ${error?.message}`);
              if (code === 50013) break; // нет прав — нечего долбиться
              // остальное пропускаем и идём дальше
            }
          }
          tick();
        }
      }

      before = messages[messages.length - 1].id; // следующий шаг глубже в историю

      // страница шла без удаляемых — крутимся сразу; была работа — короткий вдох
      if (!candidates.length) continue;
      await sleep(60);
    }
  })().finally(() => {
    loops.delete(channel.id);
    loop.onTick?.({ done: true, deleted: loop.deleted });
    console.log(`[loopclear] финиш #${channel.name}: удалено ${loop.deleted}`);
  });

  return loop;
}

module.exports = { startLoop, stopLoop, isActive, currentTargetId };
