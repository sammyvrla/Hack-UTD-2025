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
// Accept full survey with arbitrary answers. Payload shape:
// {
//   customer_id: 'abc', channel: 'web', sentiment_raw: 2, nps_score: 9,
//   free_text: 'optional overall comment',
//   answers: { overall: 5, recommend: 4, reliability: 3, charges: {value: 'yes', note: '...'}, open_improve: '...' }
// }
app.post('/survey', async (req, res) => {
  const body = req.body || {};
  const {
    customer_id,
    channel,
    sentiment_raw,
    nps_score,
    free_text,
    answers
  } = body;

  // Basic validation / normalization
  if (answers && typeof answers !== 'object') {
    return res.status(400).json({ ok: false, error: 'answers must be an object' });
  }
  // Limit size to prevent abuse (rough limit)
  const jsonAnswers = answers ? JSON.stringify(answers) : '{}';
  if (jsonAnswers.length > 50_000) {
    return res.status(413).json({ ok: false, error: 'answers payload too large' });
  }

  // Derive NPS from `answers.recommend` if not explicitly provided
  let derivedNps = nps_score;
  if ((derivedNps === undefined || derivedNps === null) && answers && answers.recommend !== undefined) {
    const rec = Number(answers.recommend);
    if (!Number.isNaN(rec)) {
      if (rec >= 0 && rec <= 10) derivedNps = rec; // already 0-10 scale
      else if (rec >= 1 && rec <= 5) derivedNps = Math.round((rec - 1) * 2.5); // map 1-5 to 0-10
    }
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO customer_surveys (customer_id, nps_score, sentiment_raw, channel, free_text, answers)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, submitted_at`,
      [customer_id || null, derivedNps || null, sentiment_raw || null, channel || null, free_text || null, jsonAnswers]
    );
    res.json({ ok: true, survey_id: rows[0].id, submitted_at: rows[0].submitted_at });
  } catch (e) {
    console.error('survey insert error', e);
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
