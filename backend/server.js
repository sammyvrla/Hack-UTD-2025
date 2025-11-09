import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import pool from './db/db.js';
import { sub } from './redis.js';

dotenv.config();

const app = express();
app.use(express.json());

// Simple REST to insert survey
app.post('/survey', async (req, res) => {
  try {
    const { customer_id, nps_score, sentiment_raw, channel, free_text } = req.body || {};
    await pool.query(
      `INSERT INTO customer_surveys (customer_id, nps_score, sentiment_raw, channel, free_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [customer_id || null, nps_score || null, sentiment_raw || null, channel || null, free_text || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Endpoint to fetch recent aggregate
app.get('/aggregate', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT bucket, market_id, avg_nps, avg_csat, avg_review, review_volume, network_load_avg, latency_avg
       FROM happiness_index
       WHERE bucket > NOW() - INTERVAL '10 minutes'
       ORDER BY bucket DESC LIMIT 60;`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', ts: Date.now() }));
});

// Forward live metrics from Redis to clients
await sub.subscribe('metrics-channel', (message) => {
  try {
    const metric = JSON.parse(message);
    broadcast({ type: 'metric', metric });
  } catch (_) {}
});

// Periodically push aggregates
setInterval(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT bucket, market_id, avg_nps, avg_csat, avg_review, review_volume, network_load_avg, latency_avg
       FROM happiness_index
       WHERE bucket > NOW() - INTERVAL '5 minutes'
       ORDER BY bucket DESC LIMIT 20;`
    );
    broadcast({ type: 'aggregate', rows });
  } catch (e) {
    console.error('aggregate push error', e.message);
  }
}, 5000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
