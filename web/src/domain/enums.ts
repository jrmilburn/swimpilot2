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
