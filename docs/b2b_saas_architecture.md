# The B2B SaaS reference architecture: a multi-tenant quant platform

Status: reference shape, not a spec or a deployment guide. This is the concrete target
`VISION_2035.md`'s bandwidth thesis and `docs/LLM_BANDWIDTH_AND_PROMPT_TO_SAAS.md` build toward:
the shape of service Lumen is meant to let a model author, prove, and ship in the fewest tokens
and the tightest loop. Distilled from a private production blueprint; deployment specifics
(hosting, vendor choice, cost) stay private and are deliberately absent here. Vendor-neutral by
design: the shape below is expressible over any cloud's queue, database, and compute primitives,
because Lumen reaches them through capabilities, not through a framework tied to one vendor.

## The shape

A multi-tenant service that accepts a unit of work, runs it asynchronously, and lets the caller
poll for the result: the submit-then-poll job contract. Concretely:

- **Submit.** An authenticated, tenant-scoped request enqueues a job onto a message queue.
- **Work.** A pool of autoscaling workers dequeues jobs, executes them, and writes the result to
  a result store, tagged by tenant and job id.
- **Poll.** The caller polls a status endpoint until the job resolves, then reads the result.
- **Job lifecycle.** A stdlib sum type (`Pending | Running | Done | Failed`), not a database enum
  or a string status field, so an exhaustive `match` is the only way to handle it.
- **Wire codec.** Every request and response is a record with an auto-derived, deterministic
  JSON codec: the same value always serializes to the same bytes, so replay and audit are exact.

## The capability set, honestly

The mechanism is one thing Lumen already ships: a capability as an ordinary typed parameter. The
specific capabilities this shape needs, `Http`, `Sql`, `Queue`, `Auth`, `Tenant`, and `Secret`,
are a **design**, not a shipped feature: they are the primordial-plus-service set in
`docs/rfcs/0001-capabilities-v1.md` (status draft), scheduled as wave W2 implementation work.
Today the only capability that exists in the language is `Console`. Until Capabilities v1 lands,
every claim below is the RFC's worked example, not a running guarantee.

The isolation claim is the sharpest one, so it gets said plainly: a handler that never receives
a `Tenant` parameter should not be able to construct a tenant-scoped `Sql` or `Queue` handle, so
cross-tenant data access becomes a compile error rather than a runtime audit finding. That is the
**future gate**, checked by a CI test once Capabilities v1 ships. It is not a property this
platform, or Lumen, can claim today.
