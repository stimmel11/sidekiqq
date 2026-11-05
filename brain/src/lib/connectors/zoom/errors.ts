/**
 * Errors from the Zoom API, in their own module so the assistant can map them to spoken messages
 * without importing ./meetings.ts (only lib/deps.ts may import that; see test/no-send.test.ts).
 */
export class ZoomApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ZoomApiError";
  }
}
