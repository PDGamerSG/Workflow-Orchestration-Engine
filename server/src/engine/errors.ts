export class ValidationError extends Error {
  override name = "ValidationError";
  readonly issues: string[];

  constructor(issues: string[], message = "invalid request") {
    super(message);
    this.issues = issues;
  }
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}
