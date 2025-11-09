# Hack UTD 2025

## Docker-Based Full Stack Test Environment

This repo now includes a `docker-compose.yml` that spins up:

1. TimescaleDB (Postgres + Timescale extension) with the `happiness` database and schema auto-applied.
2. Redis for Pub/Sub metrics.
3. Backend API (`server.js`) on port 4000 (REST + WebSocket).
4. Ingestion worker (`ingestWorker.js`) batching network metrics into TimescaleDB.
5. Simulator (`simulateData.js`) publishing fake metrics each second.

### One-Time Prerequisites
Install Docker Desktop for Windows. Ensure PowerShell is your terminal.

### Start Everything
Run from the repository root (where `docker-compose.yml` lives):

```powershell
docker compose up -d --build
```

Check container status:

```powershell
docker compose ps
```

### View Logs (follow mode)
```powershell
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f simulator
```

### Post a Test Survey (after api healthy)
```powershell
curl -Method POST -Uri http://localhost:4000/survey -Body '{"customer_id":"abc123","nps_score":9,"sentiment_raw":2,"channel":"web","free_text":"Great service"}' -ContentType 'application/json'
```

### Quick DB Sanity Check
Exec into the Timescale container and run a query:
```powershell
docker exec -it timescale psql -U postgres -d happiness -c "SELECT count(*) AS metrics_last_2m FROM network_metrics WHERE ts > NOW() - INTERVAL '2 minutes';"
```

Or run the helper script inside the api container (after metrics flow ~1 min):
```powershell
docker exec -it api node quick-check.js
```

### WebSocket Verification
Open `backend/test-client.html` directly in a browser (it connects to `ws://localhost:4000`). You should see:
- Per-second `metric` messages (one per market).
- Periodic `aggregate` messages (~every 5s).

### Tear Down
```powershell
docker compose down
```

Remove volumes for a clean slate (drops DB data):
```powershell
docker compose down -v
```

### Common Troubleshooting
| Issue | Action |
|-------|--------|
| `ECONNREFUSED` Postgres in api/worker | `docker compose logs timescale`; ensure healthcheck passed. |
| No metrics in DB | Confirm `simulator` and `worker` containers running; check `docker compose logs worker`. |
| Empty aggregates | Wait 1–2 minutes for continuous aggregate refresh cycle. |
| WebSocket not receiving | Ensure port 4000 not blocked; check `docker compose logs api`. |
| Schema missing | Rebuild: `docker compose down -v` then `docker compose up --build`. |

### Advanced: Live Iteration
While containers run, you can edit backend JS files and rebuild just those services:
```powershell
docker compose build api
docker compose up -d api
```

### Next Ideas
- Add review + csat simulators to populate more aggregate columns.
- Add health endpoint and Prometheus metrics exporter.
- Add integration tests executed via `docker compose run --rm api node quick-check.js` in CI.

---
For backend implementation details see `backend/README.md`.

