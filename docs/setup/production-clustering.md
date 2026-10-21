# Production Clustering & Deployment Guide

This guide details best practices for deploying NOVA in production environments with high availability, zero dropped streams, and resource safety.

---

## Architecture Topology

A production NOVA cluster consists of two decoupled tiers:

```
                  [ Public Inbound Traffic / API Ingress ]
                                      │
                                      ▼
               ┌──────────────────────────────────────────────┐
               │         Load Balancer / Cloudflare           │
               └──────────────────────┬───────────────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌─────────────────────────┐                           ┌─────────────────────────┐
│  nova-relay Replica 1   │                           │  nova-relay Replica 2   │
│  (Port 3001, Stateless) │                           │  (Port 3001, Stateless) │
└───────────┬─────────────┘                           └───────────┬─────────────┘
            │                                                     │
            └─────────────────────────┬───────────────────────────┘
                                      │ Internal RPC / Leases
                                      ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                 NOVA POOL ROUTING SUBSTRATE (Port 3000)                       │
│       (Smooth Weighted Round Robin, Continuous Token Buckets, SWRR)           │
└─────────────────────────────────────┬─────────────────────────────────────────┘
                                      │
                                      ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                PostgreSQL 17 Primary (Distilled db/schema.sql)                │
│             (Shard Accounts, Leases, Principals, Relay Executions)            │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Docker Compose Production Deployment

```yaml
version: '3.8'

services:
  nova-postgres:
    image: postgres:17-alpine
    container_name: nova-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: nova
    volumes:
      - nova-db-data:/var/lib/postgresql/data
      - ./db/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d nova"]
      interval: 5s
      timeout: 5s
      retries: 5

  nova-relay:
    build: .
    container_name: nova-relay
    restart: unless-stopped
    depends_on:
      nova-postgres:
        condition: service_healthy
    environment:
      PORT: "3001"
      HOST: "0.0.0.0"
      RELAY_API_KEY: ${RELAY_API_KEY}
      RELAY_ADMIN_KEY: ${RELAY_ADMIN_KEY}
      DATABASE_URL: "postgresql://postgres:${POSTGRES_PASSWORD}@nova-postgres:5432/nova"
      RELAY_MAX_CONCURRENT_REQUESTS: "128"
      RELAY_MAX_RSS_MB: "512"
      DRAIN_TIMEOUT_MS: "30000"
    ports:
      - "3001:3001"

volumes:
  nova-db-data:
```

---

## 2. Kubernetes Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nova-relay
  namespace: inference
  labels:
    app: nova-relay
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nova-relay
  template:
    metadata:
      labels:
        app: nova-relay
    spec:
      terminationGracePeriodSeconds: 35
      containers:
      - name: relay
        image: ghcr.io/cardsorting/nova-relay:latest
        ports:
        - containerPort: 3001
        env:
        - name: PORT
          value: "3001"
        - name: HOST
          value: "0.0.0.0"
        - name: RELAY_API_KEY
          valueFrom:
            secretKeyRef:
              name: nova-secrets
              key: api-key
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: nova-secrets
              key: database-url
        resources:
          requests:
            cpu: "500m"
            memory: "256Mi"
          limits:
            cpu: "2000m"
            memory: "512Mi"
        livenessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3001
          initialDelaySeconds: 3
          periodSeconds: 5
```

---

## 3. Bare-Metal Systemd Unit Configuration

For bare-metal Linux servers (Ubuntu/Debian), configure systemd units:

### `/etc/systemd/system/nova-relay.service`:
```ini
[Unit]
Description=NOVA Inference Relay Gateway
After=network.target postgresql.service

[Service]
Type=simple
User=nova
WorkingDirectory=/opt/nova
EnvironmentFile=/etc/nova/relay.env
ExecStart=/usr/bin/node --import tsx bin/relay.ts --port 3001 --host 0.0.0.0
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=35s

[Install]
WantedBy=multi-user.target
```

Enable and start with:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nova-relay
```

---

## 4. Graceful Shutdown & Drain Protocol

When rolling out new deployments or restarting instances:
1. `SIGTERM` is intercepted by the relay server.
2. The readiness probe (`/health/ready`) immediately returns `HTTP 503 Service Unavailable`, prompting the upstream load balancer to route new traffic to remaining healthy pods.
3. In-flight streams are granted a **30-second completion grace period** (`DRAIN_TIMEOUT_MS`).
4. Once active streams complete, leases are settled, pending tokens refunded, memory WAL tables flush to disk, and the process exits with code `0`.
