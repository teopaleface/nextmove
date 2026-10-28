# Exact authority and durable per-action execution

The server derives identity and current resource ownership, freezes a proposal manifest and creates execution authority only through an authenticated first-party confirmation. Each mutation is bound to exact accounts, operation, terms/input versions, consequences, cost limits and expiry; the model cannot grant approval. Batch approval covers a fixed inspectable list, with child outcomes persisted separately and conflicts serialized by canonical contract/account identity.

Persist attempts before external effects and fence workers at the dispatch gate. A timeout after a possible merchant commit becomes outcome-unknown and reconciles before retry; local uniqueness is not a distributed exactly-once guarantee. Stop prevents new dispatch authority while already-started requests may finish. The 200-item fixture defines partial outcomes and exclusions, not universal merchant coverage or measured capacity.
