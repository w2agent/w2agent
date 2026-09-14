// Minimal next/server stand-in: middleware results are marked the way Next.js marks them,
// and the test's request pipeline acts on the markers.
export class NextRequest extends Request {
  readonly nextUrl: URL;
  constructor(input: string, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(input);
  }
}

export class NextResponse extends Response {
  static next() {
    return new NextResponse(null, { headers: { "x-middleware-next": "1" } });
  }

  static rewrite(destination: URL | string) {
    return new NextResponse(null, { headers: { "x-middleware-rewrite": String(destination) } });
  }

  static json(body: unknown, init?: ResponseInit) {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    return new NextResponse(JSON.stringify(body), { ...init, headers });
  }
}
