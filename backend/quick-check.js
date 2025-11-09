import dotenv from 'dotenv';
import pool from './db/db.js';
dotenv.config();

async function main() {
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM network_metrics WHERE ts > NOW() - INTERVAL '2 minutes') AS metrics_2m,
      (SELECT count(*) FROM reviews WHERE created_at > NOW() - INTERVAL '2 minutes') AS reviews_2m,
      (SELECT count(*) FROM customer_surveys WHERE submitted_at > NOW() - INTERVAL '2 minutes') AS surveys_2m
  `);
  console.log('Recent counts:', counts.rows[0]);

  const aggs = await pool.query(`
    SELECT bucket, market_id, avg_nps, avg_csat, avg_review, network_load_avg, latency_avg
    FROM happiness_index
    WHERE bucket > NOW() - INTERVAL '5 minutes'
    ORDER BY bucket DESC LIMIT 5;
  `);
  console.log('Recent aggregates (latest 5):');
  for (const r of aggs.rows) console.log(r);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
