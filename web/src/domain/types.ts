// Domain types for the families / students aggregates. Plain TypeScript —
// nothing is imported from `@prisma/client` here. Repositories own the
// mapping from Prisma rows to these shapes.
//
// Audit fields (createdBy/updatedBy/deletedAt) are intentionally absent.
// They're populated by the audit extension and read by infrastructure;
// surfacing them on the domain type would invite callers to depend on
// internals that may be queried separately later.

import type {
  AttendanceStatus,
  BillingFrequency,
  BillingProfileStatus,
  ClassSessionStatus,
  ClassStatus,
  CommunicationPreference,
  CreditSource,
  CreditStatus,
  EnrolmentFrequency,
  EnrolmentStatus,
  InvoiceStatus,
  OnboardingStep,
  PaymentMethodType,
  SkillStatus,
  StudentStatus,
  WeekDay,
} from "./enums";
import type { StepStatusMap } from "./onboarding";

export interface Family {
  id: string;
  schoolId: string;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  communicationPreference: CommunicationPreference;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Student {
  id: string;
  schoolId: string;
  familyId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  medicalNotes: string | null;
  photoUrl: string | null;
  status: StudentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClassLevel {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  ratio: number;
  orderIndex: number;
  minAgeMonths: number | null;
  maxAgeMonths: number | null;
  defaultProgressionThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

// `startTime` is wall-clock 'HH:MM:SS' in the location's timezone — not a
// calendar instant. The Class repository converts to/from the Postgres
// `time` column at the boundary so callers never see a `Date`. See
// docs/architecture.md → "Domain model — Class levels and classes".
export interface Class {
  id: string;
  schoolId: string;
  locationId: string;
  levelId: string;
  teacherId: string | null;
  dayOfWeek: WeekDay;
  startTime: string;
  durationMinutes: number;
  capacity: number;
  status: ClassStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Calendar-date fields (`startDate`, `endDate`, `pauseFrom`, `pauseTo`,
// `sessionDate`) are mapped from Postgres `date` to a JS `Date` at UTC
// midnight. The time component is meaningless — consumers should treat
// these as wall-clock calendar dates, not instants. See
// docs/architecture.md → "Domain model — Enrolments and sessions".
export interface Enrolment {
  id: string;
  schoolId: string;
  studentId: string;
  classId: string;
  frequency: EnrolmentFrequency;
  startDate: Date;
  endDate: Date | null;
  pauseFrom: Date | null;
  pauseTo: Date | null;
  status: EnrolmentStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClassSession {
  id: string;
  schoolId: string;
  classId: string;
  sessionDate: Date;
  teacherId: string | null;
  status: ClassSessionStatus;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttendanceRecord {
  id: string;
  schoolId: string;
  classSessionId: string;
  enrolmentId: string;
  studentId: string;
  status: AttendanceStatus;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Skill {
  id: string;
  schoolId: string;
  levelId: string;
  name: string;
  description: string | null;
  orderIndex: number;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StudentSkill {
  id: string;
  schoolId: string;
  studentId: string;
  skillId: string;
  status: SkillStatus;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Billing primitives. Schema only this sprint — invoice generation, credit
// application, and Stripe wiring are Sprint 8. All money fields are integer
// cents; floats never appear on the billing path. GST values on invoice
// lines are snapshotted at issue time and immutable thereafter.

export interface BillingProfile {
  id: string;
  schoolId: string;
  familyId: string;
  billingFrequency: BillingFrequency;
  billingAnchorDate: Date;
  paymentMethodType: PaymentMethodType;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  status: BillingProfileStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Invoice {
  id: string;
  schoolId: string;
  familyId: string;
  invoiceNumber: string;
  periodStart: Date;
  periodEnd: Date;
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
  status: InvoiceStatus;
  issuedAt: Date | null;
  paidAt: Date | null;
  dueAt: Date | null;
  stripeInvoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceLine {
  id: string;
  schoolId: string;
  invoiceId: string;
  studentId: string;
  enrolmentId: string | null;
  description: string;
  amountExGstCents: number;
  gstAmountCents: number;
  quantity: number;
  lineTotalCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OnboardingProgress {
  schoolId: string;
  currentStep: OnboardingStep;
  stepStatuses: StepStatusMap;
  lastActivityAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Credit {
  id: string;
  schoolId: string;
  familyId: string;
  studentId: string | null;
  amountCents: number;
  source: CreditSource;
  expiresAt: Date | null;
  status: CreditStatus;
  appliedToInvoiceId: string | null;
  appliedAt: Date | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}
