// Simulate live network metrics and publish via Redis
import { publishMetric } from './redis.js';

const markets = ['NE', 'SE', 'MW', 'SW', 'W'];

function randBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

setInterval(async () => {
  const ts = new Date();
  for (const market_id of markets) {
    const metric = {
      ts: ts.toISOString(),
      market_id,
      network_load_percent: randBetween(20, 95),
      avg_latency_ms: randBetween(15, 120),
      packet_loss_ratio: Math.random() * 2,
      active_sessions: randBetween(1000, 50000)
    };
    await publishMetric(metric);
  }
}, 1000);

console.log('Simulating metrics...');
