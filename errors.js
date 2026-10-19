'use strict';

/** An error that maps directly onto an HTTP response with a stable machine-readable code. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'VALIDATION_FAILED', message, details);
const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
const forbidden = (message = 'You do not have permission to do that') => new AppError(403, 'FORBIDDEN', message);
// Items in teams you cannot see are reported as "not found" so their existence is not leaked.
const notFound = (what = 'Work item') => new AppError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (code, message, details) => new AppError(409, code, message, details);
const unprocessable = (code, message, details) => new AppError(422, code, message, details);

module.exports = { AppError, badRequest, unauthenticated, forbidden, notFound, conflict, unprocessable };
