// Consumes metrics from Redis (optional batching) and writes to Postgres
import dotenv from 'dotenv';
import pool from './db/db.js';
import { sub } from './redis.js';

dotenv.config();

const batch = [];
const FLUSH_SIZE = 200;
const FLUSH_MS = 1000;

async function flush() {
  if (!batch.length) return;
  const values = [];
  const params = [];
  batch.forEach((m, i) => {
    params.push(`($${i*6+1}, $${i*6+2}, $${i*6+3}, $${i*6+4}, $${i*6+5}, $${i*6+6})`);
    values.push(m.ts); // timestamptz
    values.push(m.market_id);
    values.push(m.network_load_percent);
    values.push(m.avg_latency_ms);
    values.push(m.packet_loss_ratio);
    values.push(m.active_sessions);
  });
  const sql = `INSERT INTO network_metrics (ts, market_id, network_load_percent, avg_latency_ms, packet_loss_ratio, active_sessions) VALUES ${params.join(',')}`;
  try {
    await pool.query(sql, values);
  } catch (e) {
    console.error('Flush error', e.message);
  }
  batch.length = 0;
}

setInterval(flush, FLUSH_MS);

await sub.subscribe('metrics-channel', (message) => {
  try {
    const metric = JSON.parse(message);
    batch.push(metric);
    if (batch.length >= FLUSH_SIZE) flush();
  } catch (e) {}
});

console.log('Ingest worker running');
