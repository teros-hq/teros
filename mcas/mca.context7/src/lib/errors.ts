export class Context7Error extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'Context7Error';
  }
}

export class Context7AuthError extends Context7Error {
  constructor(message = 'Invalid or expired Context7 API key') {
    super(message, 401);
    this.name = 'Context7AuthError';
  }
}

export class Context7RateLimitError extends Context7Error {
  constructor(message = 'Context7 rate limit reached. Add a CONTEXT7_API_KEY in user secrets to increase your quota.') {
    super(message, 429);
    this.name = 'Context7RateLimitError';
  }
}

export class Context7NotFoundError extends Context7Error {
  constructor(message = 'Library not found in Context7 index') {
    super(message, 404);
    this.name = 'Context7NotFoundError';
  }
}
