// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import { expect, it } from "@effect/vitest";

import { mcpHttpFetch } from "./mcpHttpFetch.ts";

async function startServer(handler: NodeHttp.RequestListener) {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP listener address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

it("streams SSE chunks before close and handles JSON and null-body responses", async () => {
  const releaseSecondChunk = Promise.withResolvers<void>();
  const receivedHeaders: Array<NodeHttp.IncomingHttpHeaders> = [];
  const server = await startServer((request, response) => {
    receivedHeaders.push(request.headers);
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/sse") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "mcp-session-id": "session-sse",
      });
      response.write('data: {"n":1}\n\n');
      void releaseSecondChunk.promise.then(() => {
        response.write('data: {"n":2}\n\n');
        response.end();
      });
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
  });

  try {
    const jsonResponse = await mcpHttpFetch(`${server.baseUrl}/json`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual({ hello: "world" });
    expect(receivedHeaders[0]?.authorization).toBe("Bearer token");

    const sseResponse = await mcpHttpFetch(`${server.baseUrl}/sse`, { method: "POST", body: "{}" });
    expect(sseResponse.headers.get("mcp-session-id")).toBe("session-sse");
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('data: {"n":1}\n\n');
    releaseSecondChunk.resolve();
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('data: {"n":2}\n\n');
    expect((await reader.read()).done).toBe(true);

    const deleteResponse = await mcpHttpFetch(`${server.baseUrl}/mcp`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toBeNull();
  } finally {
    await server.close();
  }
});

it("aborts requests before headers arrive and mid-stream when the signal aborts", async () => {
  const preHeaderSeen = Promise.withResolvers<void>();
  const preHeaderClosed = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  const server = await startServer((request, response) => {
    if (request.url === "/hang") {
      preHeaderSeen.resolve();
      response.on("close", () => preHeaderClosed.resolve());
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"n":1}\n\n');
    response.on("close", () => streamClosed.resolve());
  });

  try {
    const preAborted = new AbortController();
    preAborted.abort(new Error("already aborted"));
    await expect(
      mcpHttpFetch(`${server.baseUrl}/hang`, { method: "POST", signal: preAborted.signal }),
    ).rejects.toThrow("already aborted");

    const beforeHeaders = new AbortController();
    const pending = mcpHttpFetch(`${server.baseUrl}/hang`, {
      method: "POST",
      body: "{}",
      signal: beforeHeaders.signal,
    });
    await preHeaderSeen.promise;
    beforeHeaders.abort();
    await expect(pending).rejects.toThrow();
    await preHeaderClosed.promise;

    const midStream = new AbortController();
    const sse = await mcpHttpFetch(`${server.baseUrl}/sse`, {
      method: "POST",
      body: "{}",
      signal: midStream.signal,
    });
    const reader = sse.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const nextRead = reader.read();
    midStream.abort();
    await expect(nextRead).rejects.toThrow();
    await streamClosed.promise;
  } finally {
    await server.close();
  }
});
