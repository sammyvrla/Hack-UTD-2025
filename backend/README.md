# Happiness Backend

End-to-end demo for a real-time Happiness Index: Redis + TimescaleDB + Node.js WebSocket broadcast.

## Components
- **TimescaleDB/Postgres**: Stores raw metrics, surveys, reviews, csat snapshots; continuous aggregate `happiness_index`.
- **Redis**: Pub/Sub channel `metrics-channel` for live metric fan-out + ingestion worker.
- **Server (`server.js`)**: Express REST + WebSocket pushing aggregates and live metrics.
- **Ingest Worker (`ingestWorker.js`)**: Batches Redis metrics into Postgres.
- **Simulator (`simulateData.js`)**: Generates fake network metrics each second.
- **Test Client (`test-client.html`)**: Simple browser page to verify WebSocket flow.

## Setup (PowerShell)
```powershell
# 1. Start containers
docker run --name timescale -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d timescale/timescaledb:latest-pg14
docker run --name redis -p 6379:6379 -d redis:7

# 2. Create DB + apply schema
docker exec -it timescale psql -U postgres -c "CREATE DATABASE happiness;"
docker cp .\backend\db\schema.sql timescale:/schema.sql
docker exec -it timescale psql -U postgres -d happiness -f /schema.sql

# 3. Install dependencies
cd .\backend
npm install
copy .env.example .env

# 4. Run processes (each in separate window or use `start-process`)
npm run worker   # ingest worker
npm run simulate # metric generator
npm start        # API + WebSocket server

# (Optional) React app in another terminal
cd ..\hackutd2025sam
npm start
```

## Verification Steps
1. Open `backend/test-client.html` in your browser (double-click or `code .` then Live Server).
2. You should see metrics count increasing every second and aggregate updates every ~5s.
3. Run quick DB check:
```powershell
cd .\backend
node quick-check.js
```
4. Post a survey to see data recorded:
```powershell
curl -Method POST -Uri http://localhost:4000/survey -Body '{"customer_id":"abc123","nps_score":9,"sentiment_raw":2,"channel":"web","free_text":"Great service"}' -ContentType 'application/json'
```
5. Re-run `node quick-check.js` to confirm survey count changed.

## Expected Outputs
- WebSocket test page shows new `metric` objects (one per region) appended.
- Aggregates show latest bucket entries; they will start populating after a minute of simulated data.
- `quick-check.js` prints non-zero `metrics_2m` count and some aggregate rows.

## Troubleshooting
| Symptom | Fix |
|---------|-----|
| `ECONNREFUSED` Postgres | Confirm container running: `docker ps`; check port 5432 free. |
| No metrics in DB | Ensure `simulateData.js` and `ingestWorker.js` both running; check Redis logs. |
| Aggregate empty | Wait ~1-2 minutes for continuous aggregate refresh cycle. |
| WebSocket not connecting | Verify server on port 4000; firewall off; URL `ws://localhost:4000`. |
| Redis auth error | Adjust `REDIS_URL` in `.env` if using protected instance. |

## Extending Tests
- Add Jest tests for DB queries (mock Pool). 
- Implement latency threshold alert broadcast (add type `alert`).
- Add a synthetic review generator & ensure reviews appear in aggregate.

## Cleanup
```powershell
docker rm -f timescale redis
```
