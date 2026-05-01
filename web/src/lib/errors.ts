export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Thrown by server-action bodies (or anything called from one) to signal
 * a validation failure that should land as a `VALIDATION` ActionResult
 * code at the boundary.
 *
 * `fieldErrors` is optional. Forms that want inline per-field error
 * rendering can pass a `{ fieldName: message }` map; `tenantAction`
 * surfaces it on the result so the form bridge can read it directly
 * instead of substring-matching on the global message. When omitted,
 * the existing single-message contract is unchanged — older call sites
 * continue to work without modification.
 */
export class ValidationError extends Error {
  readonly fieldErrors?: Record<string, string>;

  constructor(message = "Invalid input", fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "ValidationError";
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}
