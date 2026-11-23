// @effect-diagnostics nodeBuiltinImport:off - Node's built-in fetch inherits undici's 300 s headers/body timeouts, which abort long-blocking MCP calls such as request_secret.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toBodyBuffer(body: RequestInit["body"]): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError("Unsupported MCP HTTP request body.");
}

/**
 * Fetch-shaped HTTP/HTTPS transport over `node:http`/`node:https` for T3 Code's
 * MCP bridges. Unlike Node's built-in `fetch` (undici), it imposes no default
 * 300 s headers or body timeout, so blocking tools like `request_secret` can
 * wait up to their full server-side budget.
 */
export function mcpHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(new TypeError(`Unsupported MCP endpoint protocol: ${parsed.protocol}`));
  }
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  const payload = toBodyBuffer(init?.body);
  const requestHeaders: Record<string, string> = {};
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => {
      requestHeaders[key] = value;
    });
  }
  if (payload !== undefined && requestHeaders["content-length"] === undefined) {
    requestHeaders["content-length"] = String(payload.byteLength);
  }
  const transport = parsed.protocol === "https:" ? NodeHttps : NodeHttp;
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport.request(
      parsed,
      {
        method: init?.method ?? "GET",
        headers: requestHeaders,
        ...(signal === undefined ? {} : { signal }),
      },
      (incoming) => {
        if (settled) {
          incoming.resume();
          return;
        }
        settled = true;
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else {
            headers.append(name, value);
          }
        }
        const status = incoming.statusCode ?? 200;
        const statusText = incoming.statusMessage ?? "";
        if (NULL_BODY_STATUSES.has(status)) {
          incoming.on("error", () => undefined);
          incoming.resume();
          resolve(new Response(null, { status, statusText, headers }));
          return;
        }
        resolve(
          new Response(NodeStream.Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status,
            statusText,
            headers,
          }),
        );
      },
    );
    request.on("error", fail);
    if (payload !== undefined) {
      request.end(payload);
    } else {
      request.end();
    }
  });
}
