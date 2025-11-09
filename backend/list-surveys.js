import dotenv from 'dotenv';
import pool from './db/db.js';

dotenv.config();

const limit = parseInt(process.argv[2] || '5', 10);

(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT id, submitted_at, customer_id, channel, nps_score, answers
       FROM customer_surveys
       ORDER BY submitted_at DESC
       LIMIT $1`, [limit]
    );
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
