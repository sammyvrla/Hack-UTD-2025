import express from 'express';
import pool from './db/db.js';
import { spawn } from 'child_process';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 8080;

// Return latest 1-minute network data
app.get('/network_metrics.json', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT market_id AS tower_id, market_id AS location,
             AVG(avg_latency_ms) AS avg_latency_ms,
             AVG(packet_loss_ratio) AS avg_packet_loss_pct,
             SUM(CASE WHEN service_ok=0 THEN 1 ELSE 0 END)::float/COUNT(*)*100 AS outage_rate_pct,
             AVG(network_load_percent) AS network_load_percent,
             AVG(active_sessions) AS active_sessions
      FROM network_metrics
      WHERE ts >= NOW() - INTERVAL '1 minute'
      GROUP BY market_id
      ORDER BY AVG(network_load_percent) DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('DB error', err);
    res.status(500).json({ error: 'database error' });
  }
});

// serve static frontend
app.use(express.static('frontend'));

// run Python daily happiness aggregation at midnight
cron.schedule('0 0 * * *', () => {
  console.log('🌙 Running daily Python aggregator...');
  const py = spawn('python3', ['scripts/daily_happiness.py']);
  py.stdout.on('data', d => console.log(d.toString()));
  py.stderr.on('data', d => console.error('ERR', d.toString()));
  py.on('close', code => console.log('Python exited with', code));
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
