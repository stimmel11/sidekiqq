import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { MissingEnvError } from "./env";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json<T>(body: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(body, init);
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400 },
    );
  }
  if (err instanceof MissingEnvError) {
    console.error(err.message);
    return NextResponse.json({ error: "Server is not configured", code: "not_configured" }, { status: 503 });
  }
  console.error("Unhandled error", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
  return schema.parse(body);
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
