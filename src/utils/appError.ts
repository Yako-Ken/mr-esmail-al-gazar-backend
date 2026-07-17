// Thrown by services to signal an HTTP-meaningful failure; controllers translate
// it to a status code via the shared handleControllerError helper instead of each
// one re-implementing 404/403/400 branching around a bare Error.
export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}
