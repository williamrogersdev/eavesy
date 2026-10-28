/**
 * An error whose message is written for the person calling the tool. `status`
 * is what the REST API answers with it.
 */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
