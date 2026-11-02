# Monitoring and infrastructure coverage

The engine can inspect coverage, propose indicators/thresholds, investigate anomalies and draft improvements. Measurements still come from instrumentation/exporters. Reliability objectives express the service owner's intent; they cannot be inferred from yesterday's failures.

`engine coverage` (or MCP `monitoring_coverage`) reads a bounded current window without a model call. It returns request volume, HTTP non-5xx fraction and p95/p99 latency per configured family/service, objective/owner when configured, and measurement gaps. Zero traffic is unknown availability. HTTP success is a candidate indicator, not proof that sign-in, checkout or payment succeeded. A latency p99 is a request-duration quantile, not a p-value for an anomaly classifier.

The patrol adds sustained gauges to the existing request/status, workload, log, trace and consumer-error signals. These use explicit units and duration thresholds; event-count floors and Poisson scoring do not apply. Critical node readiness, database availability and StatefulSet readiness rules take the deterministic urgent path before the model. CPU/memory/pool/scrape warnings go to investigation. Existing scoped Prometheus warning/critical alerts can start an investigation; info alerts only add context. Their declared severity does not itself create a second urgent notification.

## Current evidence and gaps

Read-only inventory on 2026-11-02 found request counters and latency buckets for 13 V3 services, legacy latency buckets, node CPU/memory, database pools, node readiness, StatefulSets and scrape health. All new queries share the existing bounded telemetry client. Node churn can leave incomplete histories: usable nodes are still evaluated, the gap is recorded, and missing measurements cannot resolve an old incident. Source failures remain blind spots.

The database availability exporter covers `acid-production`, not every database. Pool waiting covers 12 services. Initial sustained thresholds in `config/sources.yaml` are reviewable operational policy, not calibrated customer SLOs. Grafana verified full histories for database/pool/StatefulSet queries; node histories had partial coverage during churn.

Still missing or unverified:

- Frontend-next request/journey measurements, browser experience and external synthetic checks. Existing backend telemetry cannot establish frontend reliability.
- SQS queue depth and oldest-message age: the observed metrics describe consumer activity/errors/processing duration, not the backlog. Add CloudWatch/exporter measurements before claiming backlog coverage.
- Filesystem capacity: filesystem metrics exist, but the candidate `/` mount selector returned no series; subsequent label inspection was blocked by Grafana connectivity. Do not enable that check until the actual root mount labels are verified.
- Keycloak latency histograms, and conversion/configuration for mesh latency in milliseconds.
- Owner-reviewed service/journey SLOs and error-budget burn rules. No objective is silently assumed.
- Independent healthy/incident labels for calibration. The preserved incident export is a replay fixture, not a labelled evaluation set; trace/log limits make some counts lower bounds.

## Objectives and calibration

Optional `objectives` entries in sources.yaml bind `family`, `service`, `availability` (a fraction strictly between zero and one), and `owner`. The coverage command displays them; this change does not create burn-rate pages or assert a 15-minute observation satisfies a long-window SLO. For example, an owner can review an objective and then add an explicit entry. No example objective is enabled by default.

Alex's statistical approach and Angel's service-definition work fit here: choose the service/journey and measurement, check data quality, assess a distribution using enough representative history, evaluate sensitivity/false positives on labelled periods, then version a threshold policy. A handful of daily samples cannot establish an empirical p99. Compare the existing count detector with seasonality-aware quantiles/overdispersion-aware alternatives in replay before switching production alert policy. Keep absolute urgent rules independent of model availability.

The next autonomy step is evidence-linked draft configuration/code PRs. Automatic production changes or merging fixes require a separate, explicitly scoped policy and approval.

## Reports and investigation lifecycle

`get_run` now renders historical monitor `output.json` when `answer.md` is absent, including evidence, uncertainty and blocking challenger objections. Existing agent/requester/admin visibility applies. Stored findings do not prove Slack delivery; historical reports say delivery is unknown.

Alert queue state and investigation completion are separate. A budget/admission skip stays pending without spending an attempt. A crash, failed run or uncovered row gets at most two model attempts, then a visible inconclusive outcome; accepted reports complete only the rows they actually cover. Material worsening starts new work. Four distinct healthy patrols reset recurrence; failed observations do not count. Pending Slack delivery still retries without repeating completed model work.

## Rollout

Review the operational thresholds and inventory gaps, merge/build the engine change, then update the image through the usual argo-cd PR. This change alone does not deploy. Existing webhook and bot configuration remain compatible. No new credentials, Slack scopes or live test messages are needed for this first change. Incident exports remain private/gitignored; no raw incident data belongs in the PR.
