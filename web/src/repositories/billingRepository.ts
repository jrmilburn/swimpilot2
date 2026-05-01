import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type {
  BillingProfile,
  Credit,
  Invoice,
  InvoiceLine,
} from "../domain/types";
import type {
  BillingFrequency,
  BillingProfileStatus,
  InvoiceStatus,
  PaymentMethodType,
} from "../domain/enums";

// Billing is one aggregate spanning four tables (billing_profiles, invoices,
// invoice_lines, credits). One repository owns them all, per the
// "one repository per aggregate root" principle stated in Chunk 5's brief.
//
// This chunk ships:
//   - billing profile reads + create/update (Sprint 4 onboarding needs them)
//   - invoice and credit reads only
// Invoice creation, line generation, status transitions, credit creation,
// and credit application all live in Sprint 8. Seeds write invoices and
// credits via Prisma directly because they are seed data, not a production
// code path.

export type DbClient = TenantTx | typeof prisma;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Billing profiles
// ---------------------------------------------------------------------------

export type CreateBillingProfileInput = {
  familyId: string;
  billingFrequency: BillingFrequency;
  billingAnchorDate: Date;
  paymentMethodType: PaymentMethodType;
};

export type UpdateBillingProfileInput = Partial<{
  billingFrequency: BillingFrequency;
  billingAnchorDate: Date;
  paymentMethodType: PaymentMethodType;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  status: BillingProfileStatus;
  deletedAt: Date | null;
}>;

export type ListProfilesBySchoolOptions = {
  status?: BillingProfileStatus;
  limit?: number;
  cursor?: string | null;
};

export type BillingProfilePage = {
  items: BillingProfile[];
  nextCursor: string | null;
};

type BillingProfileRow = Prisma.BillingProfileGetPayload<Record<string, never>>;

function toBillingProfile(row: BillingProfileRow): BillingProfile {
  return {
    id: row.id,
    schoolId: row.schoolId,
    familyId: row.familyId,
    billingFrequency: row.billingFrequency as BillingProfile["billingFrequency"],
    billingAnchorDate: row.billingAnchorDate,
    paymentMethodType: row.paymentMethodType as BillingProfile["paymentMethodType"],
    stripeCustomerId: row.stripeCustomerId,
    stripePaymentMethodId: row.stripePaymentMethodId,
    status: row.status as BillingProfile["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getProfileById(
  db: DbClient,
  id: string,
): Promise<BillingProfile | null> {
  const row = await db.billingProfile.findUnique({ where: { id } });
  return row ? toBillingProfile(row) : null;
}

export async function getProfileByFamily(
  db: DbClient,
  familyId: string,
): Promise<BillingProfile | null> {
  const row = await db.billingProfile.findUnique({ where: { familyId } });
  return row ? toBillingProfile(row) : null;
}

export async function listProfilesBySchool(
  db: DbClient,
  options: ListProfilesBySchoolOptions = {},
): Promise<BillingProfilePage> {
  const limit = clampLimit(options.limit);
  const where: Prisma.BillingProfileWhereInput = {};
  if (options.status) where.status = options.status;

  const rows = await db.billingProfile.findMany({
    where,
    take: limit + 1,
    orderBy: { id: "asc" },
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return { items: page.map(toBillingProfile), nextCursor };
}

export async function createProfile(
  db: DbClient,
  input: CreateBillingProfileInput,
): Promise<BillingProfile> {
  // schoolId comes from AsyncLocalStorage. The billing_profiles_consistency
  // trigger refuses a write whose family belongs to a different school, so
  // we don't repeat the check here. Initial status is 'pending_setup' —
  // Sprint 8's Stripe flow promotes it to 'active' after the customer and
  // payment method have been attached.
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "billingRepository.createProfile: no schoolId in tenant context; call inside withTenant()",
    );
  }
  const data = {
    schoolId,
    familyId: input.familyId,
    billingFrequency: input.billingFrequency,
    billingAnchorDate: input.billingAnchorDate,
    paymentMethodType: input.paymentMethodType,
  } as unknown as Prisma.BillingProfileCreateInput;

  const row = await db.billingProfile.create({ data });
  return toBillingProfile(row);
}

export async function updateProfile(
  db: DbClient,
  id: string,
  input: UpdateBillingProfileInput,
): Promise<BillingProfile> {
  const row = await db.billingProfile.update({
    where: { id },
    data: input as Prisma.BillingProfileUpdateInput,
  });
  return toBillingProfile(row);
}

// ---------------------------------------------------------------------------
// Invoices (read-only this chunk)
// ---------------------------------------------------------------------------

export type ListInvoicesByFamilyOptions = {
  limit?: number;
  cursor?: string | null;
};

export type ListInvoicesBySchoolOptions = {
  status?: InvoiceStatus;
  limit?: number;
  cursor?: string | null;
};

export type InvoicePage = {
  items: Invoice[];
  nextCursor: string | null;
};

type InvoiceRow = Prisma.InvoiceGetPayload<Record<string, never>>;
type InvoiceLineRow = Prisma.InvoiceLineGetPayload<Record<string, never>>;

function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    schoolId: row.schoolId,
    familyId: row.familyId,
    invoiceNumber: row.invoiceNumber,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    subtotalCents: row.subtotalCents,
    gstCents: row.gstCents,
    totalCents: row.totalCents,
    status: row.status as Invoice["status"],
    issuedAt: row.issuedAt,
    paidAt: row.paidAt,
    dueAt: row.dueAt,
    stripeInvoiceId: row.stripeInvoiceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toInvoiceLine(row: InvoiceLineRow): InvoiceLine {
  return {
    id: row.id,
    schoolId: row.schoolId,
    invoiceId: row.invoiceId,
    studentId: row.studentId,
    enrolmentId: row.enrolmentId,
    description: row.description,
    amountExGstCents: row.amountExGstCents,
    gstAmountCents: row.gstAmountCents,
    quantity: row.quantity,
    lineTotalCents: row.lineTotalCents,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getInvoiceById(
  db: DbClient,
  id: string,
): Promise<Invoice | null> {
  const row = await db.invoice.findUnique({ where: { id } });
  return row ? toInvoice(row) : null;
}

export async function getInvoiceWithLines(
  db: DbClient,
  id: string,
): Promise<{ invoice: Invoice; lines: InvoiceLine[] } | null> {
  const invoiceRow = await db.invoice.findUnique({ where: { id } });
  if (!invoiceRow) return null;
  const lineRows = await db.invoiceLine.findMany({
    where: { invoiceId: id },
    orderBy: { id: "asc" },
  });
  return {
    invoice: toInvoice(invoiceRow),
    lines: lineRows.map(toInvoiceLine),
  };
}

export async function listInvoicesByFamily(
  db: DbClient,
  familyId: string,
  options: ListInvoicesByFamilyOptions = {},
): Promise<InvoicePage> {
  const limit = clampLimit(options.limit);
  const rows = await db.invoice.findMany({
    where: { familyId },
    take: limit + 1,
    orderBy: [{ periodStart: "desc" }, { id: "asc" }],
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return { items: page.map(toInvoice), nextCursor };
}

export async function listInvoicesBySchool(
  db: DbClient,
  options: ListInvoicesBySchoolOptions = {},
): Promise<InvoicePage> {
  const limit = clampLimit(options.limit);
  const where: Prisma.InvoiceWhereInput = {};
  if (options.status) where.status = options.status;

  const rows = await db.invoice.findMany({
    where,
    take: limit + 1,
    orderBy: { id: "asc" },
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return { items: page.map(toInvoice), nextCursor };
}

export async function listOverdue(
  db: DbClient,
  asOf: Date,
): Promise<Invoice[]> {
  // Invoices that are still 'issued' but whose due date has passed. The
  // actual transition to status='overdue' is a Sprint 8 concern (likely a
  // job); this read is the surface a UI uses to flag them.
  const rows = await db.invoice.findMany({
    where: {
      status: "issued",
      dueAt: { lt: asOf },
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toInvoice);
}

// ---------------------------------------------------------------------------
// Credits (read-only this chunk)
// ---------------------------------------------------------------------------

export type ListCreditsByFamilyOptions = {
  limit?: number;
  cursor?: string | null;
};

export type CreditPage = {
  items: Credit[];
  nextCursor: string | null;
};

type CreditRow = Prisma.CreditGetPayload<Record<string, never>>;

function toCredit(row: CreditRow): Credit {
  return {
    id: row.id,
    schoolId: row.schoolId,
    familyId: row.familyId,
    studentId: row.studentId,
    amountCents: row.amountCents,
    source: row.source as Credit["source"],
    expiresAt: row.expiresAt,
    status: row.status as Credit["status"],
    appliedToInvoiceId: row.appliedToInvoiceId,
    appliedAt: row.appliedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCreditById(
  db: DbClient,
  id: string,
): Promise<Credit | null> {
  const row = await db.credit.findUnique({ where: { id } });
  return row ? toCredit(row) : null;
}

export async function listAvailableCreditsForFamily(
  db: DbClient,
  familyId: string,
  asOf: Date,
): Promise<Credit[]> {
  // Status 'available' and either no expiry or expiry strictly in the
  // future. The (school_id, family_id, status) partial index on
  // status='available' serves this lookup cheaply during invoice
  // generation in Sprint 8.
  const rows = await db.credit.findMany({
    where: {
      familyId,
      status: "available",
      OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toCredit);
}

export async function listCreditsByFamily(
  db: DbClient,
  familyId: string,
  options: ListCreditsByFamilyOptions = {},
): Promise<CreditPage> {
  const limit = clampLimit(options.limit);
  const rows = await db.credit.findMany({
    where: { familyId },
    take: limit + 1,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return { items: page.map(toCredit), nextCursor };
}
