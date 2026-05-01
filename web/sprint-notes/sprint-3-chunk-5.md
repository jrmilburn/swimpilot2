# Sprint 3 / Chunk 5 — handoff

## What landed

- Four billing tables — `billing_profiles`, `invoices`,
  `invoice_lines`, `credits` — plus `billing_counters`, the per-school
  sequential allocator that Sprint 8 will use to assign human-readable
  invoice numbers. All five are FORCE ROW LEVEL SECURITY scoped on
  `current_setting('app.school_id')` with `tenant_isolation` policies
  in the same shape as every other tenant table.
- Migration `20260501110000_add_billing_primitives` — five tables,
  six enums (`billing_frequency`, `payment_method_type`,
  `billing_profile_status`, `invoice_status`, `credit_source`,
  `credit_status`), header / line / credit CHECK constraints (period
  ordering, non-negative money, `total = subtotal + gst`,
  `line_total = (amount + gst) * quantity`, applied-state
  equivalence), partial indexes for the two read paths Sprint 8 cares
  about (`credits` filtered to `status = 'available'`; `invoice_lines`
  filtered to `enrolment_id IS NOT NULL`), and four SECURITY DEFINER
  consistency triggers.
- Six new domain enums (`BillingFrequency`, `PaymentMethodType`,
  `BillingProfileStatus`, `InvoiceStatus`, `CreditSource`,
  `CreditStatus`) and four new domain types (`BillingProfile`,
  `Invoice`, `InvoiceLine`, `Credit`). Four new Prisma models added to
  the audit-extension `DOMAIN_MODELS` set so `created_by` /
  `updated_by` are stamped automatically. `BillingCounter` is
  intentionally *not* in that set — it has no audit columns, by
  design.
- `billingRepository` (new — single aggregate-root repo spanning all
  four tables):
  - Profiles: `getProfileById`, `getProfileByFamily`,
    `listProfilesBySchool` (paginated, optional status filter),
    `createProfile` (initial status `pending_setup`,
    `schoolId` from `getSchoolId()`), `updateProfile` (partial,
    used by Sprint 8 to attach Stripe ids and promote to `active`).
  - Invoices (read-only): `getInvoiceById`, `getInvoiceWithLines`,
    `listInvoicesByFamily` (newest period first), `listInvoicesBySchool`
    (paginated, optional status filter), `listOverdue(asOf)`.
  - Credits (read-only): `getCreditById`,
    `listAvailableCreditsForFamily(familyId, asOf)` (filters expired
    + applied + void), `listCreditsByFamily`.
- 7 integration test files: `billingProfiles.test.ts`,
  `billingProfileConsistency.test.ts`, `invoiceConsistency.test.ts`,
  `invoiceLineConsistency.test.ts`, `creditConsistency.test.ts`,
  `invoiceReads.test.ts`, `creditReads.test.ts`,
  `crossTenantBilling.test.ts`. Coverage spans repository CRUD, the
  one-profile-per-family rule, trigger rejections (foreign-school
  family / invoice / student / mismatched student-family),
  applied-credit structural equivalence, period ordering, total
  arithmetic, quantity, listing happy paths, and per-table RLS
  isolation under `withTenant`.
- Seed extended (`prisma/seed.ts → seedBilling`) — every active family
  in both reference schools gets a billing profile (mix of `active` /
  `pending_setup` / `payment_failed`, alternating frequencies and
  payment methods); active families get three historical invoices
  (oldest two `paid`, newest `issued`) with one line per active
  student at $25 ex GST + $2.50 GST; pending/failed-status families
  get a single `draft` invoice. Every family gets at least one
  credit; every fourth family gets a second one. Per-school
  `billing_counters` row is upserted with the highest invoice number
  seed allocated, so Sprint 8's counter-allocator picks up
  sequentially without colliding with seed numbers. Invoice numbers
  use the prefix `RIV-` / `COA-` plus a six-digit zero-padded
  sequence, e.g. `RIV-000001`.
- `docs/architecture.md` extended with a "Domain model — Billing
  primitives" section: money-as-cents rule, GST snapshotting,
  one-profile-per-family enforcement, family-vs-student credit
  semantics, applied-state structural CHECK, the invoice numbering
  choice (with the Postgres-sequence and `MAX()+1` alternatives
  written down so future engineers don't have to rediscover the
  trade-off), and an explicit list of what this chunk does *not* do.

## Decisions worth flagging

### Invoice numbering

Picked `billing_counters` (per-school counter row, intended for
`SELECT … FOR UPDATE` allocation in Sprint 8) over a Postgres
`SEQUENCE` per school or a `MAX(invoice_number) + 1` read. Reasoning
in `docs/architecture.md → Invoice numbering` and worth re-reading
before Sprint 8 starts allocating from the row. Key constraints:
allocation must happen inside the invoice-create transaction; the row
lock is per-school so different schools allocate in parallel; the
allocator never sees a `billing_counters` row from another school
because RLS scopes it.

### Applied-credit consistency as one CHECK, not two columns and a trigger

`(status = 'applied') = (applied_to_invoice_id IS NOT NULL AND
applied_at IS NOT NULL)` is structurally what we want — the three
columns must move together. A single boolean equivalence captures
both directions of the implication and is cheaper than a trigger.
Sprint 8 will need to write all three columns in the same UPDATE; if
it forgets one, Postgres will raise `credits_applied_consistency_check`.

### Status transitions are not DB-enforced

`billing_profile_status`, `invoice_status`, and `credit_status` are
all just enums. The DB does not enforce which transitions are legal
(e.g. `paid → draft` is currently writable). This is deliberate —
Sprint 8 owns the state machine and putting a half-formed version of
it in the DB now would lock us into the wrong shape. The CHECK
constraints enforce *structural* invariants (totals add up; periods
are ordered; applied credits are linked to an invoice); statuses are
checked at the application layer.

## What Sprint 8 needs to wire up

- `allocateInvoiceNumber(schoolId, prefix)` — opens (or finds) the
  `billing_counters` row for the school, locks it via `SELECT … FOR
  UPDATE`, increments `last_invoice_number`, returns the formatted
  number. Must be called inside the same transaction as the
  `invoices` insert.
- `createInvoiceForPeriod(familyId, periodStart, periodEnd)` —
  enumerates active enrolments + applicable attendance, builds
  `invoice_lines`, snapshots GST, computes header totals, calls
  `allocateInvoiceNumber`, inserts the invoice + lines atomically.
- `applyCreditToInvoice(creditId, invoiceId)` — updates the credit
  row to set `status = 'applied'`, `applied_to_invoice_id`, and
  `applied_at` together (the CHECK enforces that all three move
  together).
- The Stripe attach flow that promotes a profile from `pending_setup`
  → `active` and writes `stripe_customer_id` /
  `stripe_payment_method_id`. The repository surface
  (`updateProfile`) is already there.
- The `paid` and `overdue` transitions — likely a webhook handler
  for `paid` and a periodic job for `overdue`. Neither is wired in
  this chunk.

## What Sprint 4 onboarding needs to wire up

- Call `billingRepository.createProfile` from the family-onboarding
  flow at the moment a family signs up. Initial status will be
  `pending_setup`; Sprint 8's Stripe attach flow promotes it later.
- Optionally seed the per-school `billing_counters` row alongside the
  first profile creation if Sprint 4 wants to render an "invoices
  will be numbered XXX-000001" hint to the school admin. The seed
  already creates the row; production schools need it created on
  demand.

## Verification

- `npx prisma generate` succeeded after the schema changes.
- `npx tsc --noEmit` is clean.
- Integration tests are written but were not executed in-session —
  Docker daemon was not running. Run with the existing harness
  (`npm run test:integration` or whatever the project uses) once the
  db is up.
