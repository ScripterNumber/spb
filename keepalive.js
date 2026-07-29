const http = require('http');

// ─────────────────────────────────────────────────────────────
// KEEP-ALIVE HTTP-СЕРВЕР
//
// Это и есть «хитрость» против засыпания на Render:
//  1. Render требует, чтобы web-сервис слушал порт (PORT, обычно 10000).
//     Порт открыт → Render считает инстанс живым и не гасит его.
//  2. Внешний пингер (cron-job.org / UptimeRobot) дёргает этот URL
//     каждые 5 минут → трафик есть → бесплатный инстанс не засыпает.
//
// 750 бесплатных часов Render в месяц = ровно один сервис 24/7 на весь месяц.
// ─────────────────────────────────────────────────────────────
function startKeepAlive(getStatus) {
  const port = process.env.PORT || 10000;

  const server = http.createServer((req, res) => {
    const body = JSON.stringify({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      ...getStatus(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  server.listen(port, () => {
    console.log(`[keep-alive] HTTP-сервер слушает порт ${port}`);
  });

  return server;
}

module.exports = { startKeepAlive };
