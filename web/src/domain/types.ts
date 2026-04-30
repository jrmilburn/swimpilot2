// Domain types for the families / students aggregates. Plain TypeScript —
// nothing is imported from `@prisma/client` here. Repositories own the
// mapping from Prisma rows to these shapes.
//
// Audit fields (createdBy/updatedBy/deletedAt) are intentionally absent.
// They're populated by the audit extension and read by infrastructure;
// surfacing them on the domain type would invite callers to depend on
// internals that may be queried separately later.

import type {
  CommunicationPreference,
  StudentStatus,
} from "./enums";

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
