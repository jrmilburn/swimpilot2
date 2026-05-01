import { z } from "zod";

// Shared zod field schema for the per-row location actions. Each field
// is optional except `name`. Length caps are app-side: the DB columns
// are TEXT with no CHECK constraints (see migration preamble for the
// AU-first / international-expansion rationale).
//
// Why pull these into one module: `addLocation` and `updateLocation`
// share the field shape exactly, and the partial nature of update is a
// single `.partial()` away from the create schema. If the shapes
// diverge in Sprint 6, split them; until then DRY is the right call.
export const LocationNameField = z
  .string({ message: "Name is required" })
  .trim()
  .min(1, "Name is required")
  .max(200, "Name is too long");

export const LocationAddressLineField = z
  .string()
  .trim()
  .max(200, "Address is too long")
  .nullable();

export const LocationSuburbField = z
  .string()
  .trim()
  .max(120, "Suburb is too long")
  .nullable();

export const LocationStateField = z
  .string()
  .trim()
  .max(60, "State is too long")
  .nullable();

export const LocationPostcodeField = z
  .string()
  .trim()
  .max(20, "Postcode is too long")
  .nullable();

export const LocationTimezoneField = z
  .string()
  .trim()
  .max(80, "Timezone is too long")
  .nullable();

export const LocationNotesField = z
  .string()
  .trim()
  .max(2000, "Notes are too long")
  .nullable();

export const CreateLocationSchema = z.object({
  name: LocationNameField,
  addressLine: LocationAddressLineField,
  suburb: LocationSuburbField,
  state: LocationStateField,
  postcode: LocationPostcodeField,
  timezone: LocationTimezoneField,
  notes: LocationNotesField,
});

export const UpdateLocationSchema = CreateLocationSchema.partial();

export type CreateLocationFormInput = z.infer<typeof CreateLocationSchema>;
export type UpdateLocationFormInput = z.infer<typeof UpdateLocationSchema>;
