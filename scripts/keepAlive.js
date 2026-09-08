// Simple keep-alive pinger for Render free dynos or external cron services.
// Usage: node scripts/keepAlive.js
// It will ping the URL every 10 minutes (configurable via KEEPALIVE_INTERVAL_MS)

const url = process.env.KEEPALIVE_URL || `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/health`;
const intervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS || 10 * 60 * 1000);

async function ping() {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
    const ok = res.ok;
    console.log(`keepAlive: pinged ${url} -> ${res.status} ${res.statusText}`);
  } catch (e) {
    console.warn('keepAlive: ping failed', e && e.message ? e.message : e);
  }
}

console.log(`Starting keepAlive pinger to ${url} every ${intervalMs}ms`);
ping();
setInterval(ping, intervalMs);
