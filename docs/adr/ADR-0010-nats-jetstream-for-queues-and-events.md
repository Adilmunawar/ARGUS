# ADR-0010 — NATS JetStream for queues and events

**Decision.** NATS server (Apache-2.0, Windows binary) with JetStream, 3-node cluster across the Service Fabric nodes. Subjects: `argus.ingest.*` (shapefile uploads), `argus.export.*`, `argus.ai.*`, `argus.sentinel.scene.landed`, `argus.pipeline.*`.

**Why.** One binary gives pub/sub, durable work queues, key-value and object store; MSMQ is legacy; Kafka is far too heavy for these volumes; RabbitMQ is fine but does not run natively as well on Windows and lacks JetStream's KV.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
