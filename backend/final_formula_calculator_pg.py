"""
Compute the Customer Happiness Index directly from Postgres (TimescaleDB)
using the combined coverage_metrics hypertable that is populated by
dfwDataGenerator.js. Writes results into a table happiness_index_calc.

Weights (same spirit as earlier notebook):
- Network performance: 20%
- Behavioral Engagement & Market Context: 50%
- Consumer Sentiment: 20%
- Brand/Reach/Social: 10%

Run examples (PowerShell):
  # Install deps once (Windows)
  # python -m pip install --upgrade pip
  # pip install psycopg[binary] pandas numpy python-dotenv schedule

  # Run one calculation over the latest snapshot
  # $env:PGHOST='localhost'; $env:PGUSER='postgres'; $env:PGPASSWORD='postgres'; $env:PGDATABASE='happiness'; $env:PGPORT='5432'
  # python final_formula_calculator_pg.py --once

  # Or schedule every minute to keep it updated
  # python final_formula_calculator_pg.py --interval 60
"""

from __future__ import annotations
import os
import time
import math
import argparse
import numpy as np
import pandas as pd

try:
    import psycopg
except ImportError:
    raise SystemExit("Missing dependency 'psycopg'. Install with: pip install psycopg[binary]")


def env(key: str, default: str | None = None) -> str:
    v = os.getenv(key, default)
    if v is None:
        raise RuntimeError(f"Missing env var: {key}")
    return v


DDL_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS happiness_index_calc (
  bucket TIMESTAMPTZ NOT NULL,
  market_id TEXT NOT NULL,
  network_score NUMERIC(6,2),
  engagement_market_score NUMERIC(6,2),
  sentiment_score NUMERIC(6,2),
  brand_social_score NUMERIC(6,2),
  final_index NUMERIC(6,2),
  PRIMARY KEY (bucket, market_id)
);
"""


SQL_LATEST_COVERAGE = """
WITH latest AS (
  SELECT market_id, max(ts) AS ts
  FROM coverage_metrics
  GROUP BY market_id
)
SELECT c.*
FROM coverage_metrics c
JOIN latest l ON l.market_id = c.market_id AND l.ts = c.ts;
"""


def normalize_0_100(x: pd.Series | float, min_val: float, max_val: float) -> pd.Series:
    if isinstance(x, (int, float)):
        if max_val == min_val:
            return 50.0
        return float(np.clip((x - min_val) / (max_val - min_val) * 100.0, 0, 100))
    # series
    rng = max_val - min_val if max_val != min_val else 1.0
    return ((x - min_val) / rng * 100.0).clip(lower=0, upper=100)


def compute_scores(df: pd.DataFrame) -> pd.DataFrame:
    """Compute component scores and final index per market_id for latest snapshot."""
    if df.empty:
        return df

    # Network performance: we already have latency_score and packet_loss_score (0-100)
    # outage_flag is 0/1 (0=outage, 1=healthy) => convert to 0 or 100
    outage_score = df["outage_flag"].astype(float) * 100.0
    df["network_score"] = 0.4 * df["latency_score"] + 0.3 * df["packet_loss_score"] + 0.3 * outage_score

    # Engagement + Market context: retention (0-100), likely months (~1-48) -> normalize, business_index (0-100)
    months_norm = normalize_0_100(df["likely_remain_months"].astype(float), 1.0, 48.0)
    df["engagement_market_score"] = (
        0.6 * df["consumer_retention_score"].astype(float) +
        0.2 * months_norm +
        0.2 * df["business_index"].astype(float)
    )

    # Consumer sentiment: survey/review 1-5 -> 0..100
    survey_0100 = normalize_0_100(df["survey_score"].astype(float), 1.0, 5.0)
    review_0100 = normalize_0_100(df["review_score"].astype(float), 1.0, 5.0)
    df["sentiment_score"] = (survey_0100 + review_0100) / 2.0

    # Brand + Reach + Social: brand_market_score (0-100) given, make a composite with ad_reach & social volumes
    # Min-max using current snapshot (robust enough for synthetic data)
    reach_0100 = normalize_0_100(df["ad_reach"].astype(float), df["ad_reach"].min(), df["ad_reach"].max())
    social_raw = (
        0.25 * df["shares"].astype(float) +
        0.35 * df["likes"].astype(float) +
        0.20 * df["posts"].astype(float) +
        0.20 * df["comments"].astype(float)
    )
    social_0100 = normalize_0_100(social_raw, social_raw.min(), social_raw.max())
    df["brand_social_score"] = 0.5 * df["brand_market_score"].astype(float) + 0.25 * reach_0100 + 0.25 * social_0100

    # Final index weights
    df["final_index"] = (
        0.20 * df["network_score"] +
        0.50 * df["engagement_market_score"] +
        0.20 * df["sentiment_score"] +
        0.10 * df["brand_social_score"]
    )

    return df


def run_once(conn: psycopg.Connection):
    # Ensure output table exists
    with conn.cursor() as cur:
        cur.execute(DDL_CREATE_TABLE)
        conn.commit()

    # Fetch latest rows per market
    df = pd.read_sql(SQL_LATEST_COVERAGE, conn)
    if df.empty:
        print("No coverage_metrics data available yet.")
        return

    df = compute_scores(df)

    # Use the snapshot ts as the bucket timestamp
    out = df[[
        "ts","market_id","network_score","engagement_market_score",
        "sentiment_score","brand_social_score","final_index"
    ]].copy()
    out.rename(columns={"ts":"bucket"}, inplace=True)

    # Upsert into happiness_index_calc
    records = [
        (
            row.bucket, row.market_id, float(round(row.network_score, 2)),
            float(round(row.engagement_market_score, 2)), float(round(row.sentiment_score, 2)),
            float(round(row.brand_social_score, 2)), float(round(row.final_index, 2))
        )
        for row in out.itertuples(index=False)
    ]

    UPSERT = (
        "INSERT INTO happiness_index_calc (bucket, market_id, network_score, engagement_market_score, sentiment_score, brand_social_score, final_index) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s) "
        "ON CONFLICT (bucket, market_id) DO UPDATE SET "
        "network_score=EXCLUDED.network_score, engagement_market_score=EXCLUDED.engagement_market_score, "
        "sentiment_score=EXCLUDED.sentiment_score, brand_social_score=EXCLUDED.brand_social_score, final_index=EXCLUDED.final_index"
    )
    with conn.cursor() as cur:
        cur.executemany(UPSERT, records)
        conn.commit()

    # Print a small summary
    overall = out["final_index"].mean()
    print(f"Calculated {len(out)} markets. Overall Customer Happiness Index: {overall:.2f}")


def connect_pg() -> psycopg.Connection:
    conn = psycopg.connect(
        host=env("PGHOST", "localhost"),
        port=int(env("PGPORT", "5432")),
        user=env("PGUSER", "postgres"),
        password=env("PGPASSWORD", "postgres"),
        dbname=env("PGDATABASE", "happiness"),
        autocommit=False,
    )
    return conn


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Run a single calculation and exit")
    parser.add_argument("--interval", type=int, default=0, help="Run every N seconds (0 = disabled)")
    args = parser.parse_args()

    with connect_pg() as conn:
        if args.once or args.interval == 0:
            run_once(conn)
            return
        else:
            while True:
                run_once(conn)
                time.sleep(max(5, args.interval))


if __name__ == "__main__":
    main()
