export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function createHttpError(statusCode, message) {
  return new HttpError(statusCode, message);
}

export function invalidJsonBodyError() {
  return createHttpError(400, "Invalid JSON body");
}

export function wrapDictationRequestError(error) {
  if (error instanceof HttpError) {
    return error;
  }

  return createHttpError(400, error instanceof Error ? error.message : "Invalid dictation request");
}

export function toErrorResponse(error) {
  if (error instanceof HttpError) {
    return {
      payload: {
        error: error.message
      },
      statusCode: error.statusCode
    };
  }

  return {
    payload: {
      error: error instanceof Error ? error.message : "Unknown error"
    },
    statusCode: 500
  };
}
