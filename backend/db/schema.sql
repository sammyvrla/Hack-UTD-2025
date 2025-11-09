-- TimescaleDB schema for Happiness Index
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- network metrics hypertable
CREATE TABLE IF NOT EXISTS network_metrics (
  ts TIMESTAMPTZ NOT NULL,
  market_id TEXT NOT NULL,
  network_load_percent INT,
  avg_latency_ms INT,
  packet_loss_ratio REAL,
  active_sessions INT
);
SELECT create_hypertable('network_metrics','ts', if_not_exists => TRUE);

-- customer surveys
CREATE TABLE IF NOT EXISTS customer_surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  customer_id TEXT,
  channel TEXT,
  sentiment_raw INT,
  nps_score INT,
  free_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_surveys_submitted_at ON customer_surveys (submitted_at DESC);

-- csat scores snapshots
CREATE TABLE IF NOT EXISTS csat_scores (
  ts TIMESTAMPTZ NOT NULL,
  market_id TEXT NOT NULL,
  csat_score NUMERIC(5,2),
  PRIMARY KEY (ts, market_id)
);
SELECT create_hypertable('csat_scores','ts', if_not_exists => TRUE);

-- reviews table
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT,
  rating INT,
  sentiment_label TEXT,
  market_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews (created_at DESC);

-- continuous aggregate for happiness index
CREATE MATERIALIZED VIEW IF NOT EXISTS happiness_index
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', nm.ts) AS bucket,
  nm.market_id,
  AVG(s.nps_score) AS avg_nps,
  AVG(c.csat_score) AS avg_csat,
  AVG(r.rating) AS avg_review,
  COUNT(r.id) AS review_volume,
  AVG(nm.network_load_percent) AS network_load_avg,
  AVG(nm.avg_latency_ms) AS latency_avg
FROM network_metrics nm
LEFT JOIN customer_surveys s
  ON s.submitted_at BETWEEN nm.ts - INTERVAL '30 seconds' AND nm.ts + INTERVAL '30 seconds'
LEFT JOIN csat_scores c
  ON c.ts = time_bucket('1 minute', nm.ts) AND c.market_id = nm.market_id
LEFT JOIN reviews r
  ON r.created_at BETWEEN nm.ts - INTERVAL '30 seconds' AND nm.ts + INTERVAL '30 seconds' AND r.market_id = nm.market_id
GROUP BY bucket, nm.market_id;

SELECT add_continuous_aggregate_policy('happiness_index',
  start_offset => INTERVAL '2 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- retention policy for raw high volume metrics (7 days)
SELECT add_retention_policy('network_metrics', INTERVAL '7 days');
