# NextMove

A fictional mobile bank with a financial AI agent for personal and business decisions. The hackathon environment uses synthetic accounts, money, offers and merchant systems; model inference, deterministic calculations, browser interactions and persisted outcomes must actually run.

## Project status

Architecture and implementation brief are published first, as requested. Application implementation follows these decisions. This repository does not establish production banking readiness, legal certification or live merchant coverage.

## Start here

- [Implementation brief](docs/IMPLEMENTATION-BRIEF.md)
- [Architecture decisions](docs/adr/README.md)
- [Domain language](CONTEXT.md)
- [Accepted product scope](PRODUCT-SCOPE.md)
- [Security and scale contract](design/SECURITY-AND-SCALE.md)
- [Mobile UX](design/MOBILE-UX.md) and [design system](design/DESIGN-SYSTEM.md)
- [UI fixtures](design/ui-fixtures.json), [financial cases](demo/cases.json), [200-item acceptance fixture](demo/bulk-cancellations.json)

The mobile interface uses Home, Activity, Goals and Agent. NextMove has its own yellow/ink/white identity inspired by the supplied banking references; it claims no Raiffeisen affiliation.

## Collaboration

Main contains reviewable decisions and verified application changes. Collaborators should preserve unrelated work, use branches for concurrent code, keep credentials and runtime databases outside Git, and attach evidence to functional claims. There is no production deployment authorized by the current implementation task.

Local setup, test commands and evidence index will be added with the working application.
