import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import pool from './db/db.js';
import { sub } from './redis.js';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(express.json());

// Minimal CORS for local HTML testing (file:// or different origin)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Simple REST to insert survey
// Accept full survey with arbitrary answers. Payload shape:
// {
//   customer_id: 'abc', channel: 'web', sentiment_raw: 2, nps_score: 9,
//   answers: { overall: 5, recommend: 4, reliability: 3, charges: {value: 'yes', note: '...'}, open_improve: '...' }
// }
app.post('/survey', async (req, res) => {
  const body = req.body || {};
  const {
    customer_id,
    channel,
    sentiment_raw,
    nps_score,
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
      `INSERT INTO customer_surveys (customer_id, nps_score, sentiment_raw, channel, answers)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, submitted_at`,
      [customer_id || null, derivedNps || null, sentiment_raw || null, channel || null, jsonAnswers]
    );
    res.json({ ok: true, survey_id: rows[0].id, submitted_at: rows[0].submitted_at });
  } catch (e) {
    console.error('survey insert error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Fetch recent surveys (limited) for debugging/verification
app.get('/surveys/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 100);
  try {
    const { rows } = await pool.query(
      `SELECT id, submitted_at, customer_id, channel, nps_score, answers
       FROM customer_surveys
       ORDER BY submitted_at DESC
       LIMIT $1`, [limit]
    );
    res.json(rows);
  } catch (e) {
    console.error('surveys/recent error', e);
    res.status(500).json({ ok:false, error: e.message });
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

// Latest snapshot per market for network performance (supports test HTML dashboard)
app.get('/network_metrics.json', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH latest AS (
        SELECT market_id, max(ts) AS ts
        FROM network_metrics
        GROUP BY market_id
      )
      SELECT nm.market_id,
             nm.avg_latency_ms,
             nm.packet_loss_ratio AS avg_packet_loss_pct,
             nm.network_load_percent,
             nm.active_sessions,
             COALESCE(CASE WHEN cm.outage_flag = 1 THEN 0 ELSE 100 END, 100) AS outage_rate_pct
      FROM network_metrics nm
      JOIN latest l ON l.market_id = nm.market_id AND l.ts = nm.ts
      LEFT JOIN LATERAL (
        SELECT outage_flag
        FROM coverage_metrics c2
        WHERE c2.market_id = nm.market_id
        ORDER BY c2.ts DESC
        LIMIT 1
      ) cm ON TRUE;
    `);
    res.json(rows);
  } catch (e) {
    console.error('network_metrics.json error', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Daily happiness index (CSV) derived from happiness_index_calc (averaged by day)
app.get('/daily_happiness.csv', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT to_char(date_trunc('day', bucket), 'YYYY-MM-DD') AS date,
             ROUND(AVG(final_index)::numeric, 2) AS customer_happiness_index
      FROM happiness_index_calc
      GROUP BY 1
      ORDER BY 1;
    `);
    const header = 'date,customer_happiness_index';
    const lines = rows.map(r => `${r.date},${r.customer_happiness_index}`);
    res.setHeader('Content-Type', 'text/csv');
    res.send([header, ...lines].join('\n'));
  } catch (e) {
    console.error('daily_happiness.csv error', e.message);
    res.status(500).send('error,' + e.message);
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
// Serve the dashboard statically at /dashboard so other devices on LAN can access
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/dashboard', express.static(path.join(__dirname, 'generator')));
app.get('/', (req, res) => res.redirect('/dashboard/happinessindicator.html'));

server.listen(PORT, '0.0.0.0', () => console.log(`Backend listening on ${PORT}`));
