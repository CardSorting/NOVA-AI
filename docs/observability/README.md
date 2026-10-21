# Observability & Metrics

[Wiki Portal](../README.md) > Observability & Metrics

NOVA provides comprehensive real-time telemetry, Prometheus metrics export, and distributed request tracing designed for production operations.

---

<a id="observability-guides"></a>
## 📊 Observability Guides

| Guide | Description |
| :--- | :--- |
| **[Prometheus Metrics Catalog](./prometheus-metrics.md)** | Full reference of all Prometheus counters, gauges, histograms, labels, and recommended alert thresholds. |
| **[Telemetry & Distributed Tracing](./telemetry-and-tracing.md)** | Latency percentiles (TTFT, ITL), trace ID propagation (`x-trace-id`), and in-memory ring buffers. |

---

<a id="prometheus-scraping"></a>
## ⚙️ Scraping Configuration (Prometheus / Grafana)

Configure your `prometheus.yml` to scrape the gateway:

```yaml
scrape_configs:
  - job_name: 'nova-relay'
    scrape_interval: 10s
    metrics_path: '/metrics'
    bearer_token: '${RELAY_ADMIN_KEY}'
    static_configs:
      - targets: ['127.0.0.1:3001']
```
