/** An error caused by the request rather than the organizer; the API returns `status`. */
export class UserError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}
