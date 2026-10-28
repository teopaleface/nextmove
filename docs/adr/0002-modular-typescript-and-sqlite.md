# One TypeScript application and durable local workflow storage

Use a phone-first Next.js/React/TypeScript application with deep modules for financial calculation, authority, task execution and evidence. SQLite on persistent local disk owns session-scoped records, proposals, grants, child jobs, attempts, receipts and events; a long-lived worker processes jobs independently of the phone. This avoids a distributed platform for the local build while retaining transactional checkpoints and a clear later move to bank-hosted shared storage/workers.

Keep fake merchant state logically independent of bank state. Expose its rendered pages on a controlled local origin so a browser claim can be proved through page interaction and independent read-back, rather than a direct mutation followed by a decorative screenshot. Resolve and lock compatible dependencies against the installed Node runtime; use the SQLite adapter that actually passes restart and concurrency checks.
