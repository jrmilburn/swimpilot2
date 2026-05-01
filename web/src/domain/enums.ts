// Domain enums. Mirror the Prisma-generated enum string values so repository
// mappers can cast in/out without translation tables. Prisma's generated enum
// types stay inside `src/repositories/**` per the architecture rule — these
// const objects are what the rest of the app sees.

export const StudentStatus = {
  Active: "active",
  Paused: "paused",
  Withdrawn: "withdrawn",
} as const;
export type StudentStatus = (typeof StudentStatus)[keyof typeof StudentStatus];

export const CommunicationPreference = {
  Email: "email",
  Sms: "sms",
  Both: "both",
} as const;
export type CommunicationPreference =
  (typeof CommunicationPreference)[keyof typeof CommunicationPreference];

export const WeekDay = {
  Monday: "monday",
  Tuesday: "tuesday",
  Wednesday: "wednesday",
  Thursday: "thursday",
  Friday: "friday",
  Saturday: "saturday",
  Sunday: "sunday",
} as const;
export type WeekDay = (typeof WeekDay)[keyof typeof WeekDay];

export const ClassStatus = {
  Active: "active",
  Cancelled: "cancelled",
} as const;
export type ClassStatus = (typeof ClassStatus)[keyof typeof ClassStatus];

export const EnrolmentFrequency = {
  Weekly: "weekly",
  FortnightlyA: "fortnightly_a",
  FortnightlyB: "fortnightly_b",
  OneOff: "one_off",
} as const;
export type EnrolmentFrequency =
  (typeof EnrolmentFrequency)[keyof typeof EnrolmentFrequency];

export const EnrolmentStatus = {
  Active: "active",
  Paused: "paused",
  Withdrawn: "withdrawn",
} as const;
export type EnrolmentStatus =
  (typeof EnrolmentStatus)[keyof typeof EnrolmentStatus];

export const ClassSessionStatus = {
  Scheduled: "scheduled",
  Cancelled: "cancelled",
  Completed: "completed",
} as const;
export type ClassSessionStatus =
  (typeof ClassSessionStatus)[keyof typeof ClassSessionStatus];

export const AttendanceStatus = {
  Present: "present",
  Absent: "absent",
  Late: "late",
} as const;
export type AttendanceStatus =
  (typeof AttendanceStatus)[keyof typeof AttendanceStatus];

export const SkillStatus = {
  NotIntroduced: "not_introduced",
  WorkingOn: "working_on",
  Achieved: "achieved",
} as const;
export type SkillStatus = (typeof SkillStatus)[keyof typeof SkillStatus];

export const BillingFrequency = {
  Weekly: "weekly",
  Fortnightly: "fortnightly",
} as const;
export type BillingFrequency =
  (typeof BillingFrequency)[keyof typeof BillingFrequency];

export const PaymentMethodType = {
  Card: "card",
  Becs: "becs",
} as const;
export type PaymentMethodType =
  (typeof PaymentMethodType)[keyof typeof PaymentMethodType];

export const BillingProfileStatus = {
  PendingSetup: "pending_setup",
  Active: "active",
  PaymentFailed: "payment_failed",
  Cancelled: "cancelled",
} as const;
export type BillingProfileStatus =
  (typeof BillingProfileStatus)[keyof typeof BillingProfileStatus];

export const InvoiceStatus = {
  Draft: "draft",
  Issued: "issued",
  Paid: "paid",
  Overdue: "overdue",
  Void: "void",
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const CreditSource = {
  SchoolCancellation: "school_cancellation",
  NotifiedAbsence: "notified_absence",
  Refund: "refund",
  Manual: "manual",
} as const;
export type CreditSource = (typeof CreditSource)[keyof typeof CreditSource];

export const CreditStatus = {
  Available: "available",
  Applied: "applied",
  Expired: "expired",
  Void: "void",
} as const;
export type CreditStatus = (typeof CreditStatus)[keyof typeof CreditStatus];
