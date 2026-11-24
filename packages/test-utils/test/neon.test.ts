import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { waitForNeonProxyReady } from "../src/neon.js";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface MockProxyBehavior {
  readonly httpFailuresBeforeOk: number;
  readonly wsFailuresBeforeOk: number;
}

interface MockProxyServer {
  readonly fetchEndpoint: string;
  readonly wsProxy: string;
  readonly stats: {
    httpAttempts: number;
    wsAttempts: number;
    lastConnectionHeader: string | undefined;
    lastSqlBody: string;
  };
  close(): Promise<void>;
}

async function startMockNeonProxy(behavior: MockProxyBehavior): Promise<MockProxyServer> {
  const stats = {
    httpAttempts: 0,
    wsAttempts: 0,
    lastConnectionHeader: undefined as string | undefined,
    lastSqlBody: "",
  };
  const openSockets = new Set<Duplex>();

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/sql") {
      res.writeHead(404).end();
      return;
    }

    stats.httpAttempts += 1;
    const header = req.headers["neon-connection-string"];
    stats.lastConnectionHeader = Array.isArray(header) ? header[0] : header;

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      stats.lastSqlBody = Buffer.concat(chunks).toString("utf8");
      if (stats.httpAttempts <= behavior.httpFailuresBeforeOk) {
        res.writeHead(502, { "Content-Type": "text/plain" }).end("Bad Gateway");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ rows: [["1"]] }));
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));

    if (req.url !== "/v2") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    stats.wsAttempts += 1;
    if (stats.wsAttempts <= behavior.wsFailuresBeforeOk) {
      // Simulate upstream proxy closing the socket mid-handshake (HTTP 502 / EOF).
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = createHash("sha1").update(`${key}${WS_MAGIC_GUID}`).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Expected TCP server address");
  }

  return {
    fetchEndpoint: `http://127.0.0.1:${addr.port}/sql`,
    wsProxy: `127.0.0.1:${addr.port}/v2`,
    stats,
    async close(): Promise<void> {
      for (const socket of openSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("waitForNeonProxyReady()", () => {
  const servers: MockProxyServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it("retries transient HTTP 502 and WebSocket handshake drops until both /sql and /v2 succeed", async () => {
    const mock = await startMockNeonProxy({
      httpFailuresBeforeOk: 2,
      wsFailuresBeforeOk: 2,
    });
    servers.push(mock);

    const connectionString = "postgresql://user:pass@db.localtest.me:5432/testdb";
    await waitForNeonProxyReady({
      fetchEndpoint: mock.fetchEndpoint,
      wsProxy: mock.wsProxy,
      connectionString,
      timeoutMs: 5_000,
      intervalMs: 20,
      attemptTimeoutMs: 1_000,
    });

    expect(mock.stats.httpAttempts).toBe(3);
    expect(mock.stats.wsAttempts).toBe(3);
    expect(mock.stats.lastConnectionHeader).toBe(connectionString);
    expect(JSON.parse(mock.stats.lastSqlBody)).toEqual({ query: "SELECT 1", params: [] });
  });

  it("rejects with diagnostic context when /sql never becomes healthy before timeout", async () => {
    const mock = await startMockNeonProxy({
      httpFailuresBeforeOk: Number.POSITIVE_INFINITY,
      wsFailuresBeforeOk: 0,
    });
    servers.push(mock);

    await expect(
      waitForNeonProxyReady({
        fetchEndpoint: mock.fetchEndpoint,
        wsProxy: mock.wsProxy,
        connectionString: "postgresql://user:pass@db.localtest.me:5432/testdb",
        timeoutMs: 300,
        intervalMs: 25,
        attemptTimeoutMs: 500,
      }),
    ).rejects.toThrow(/\/sql.*502/);
  });

  it("rejects with diagnostic context when /sql succeeds but /v2 WebSocket handshake keeps failing", async () => {
    const mock = await startMockNeonProxy({
      httpFailuresBeforeOk: 0,
      wsFailuresBeforeOk: Number.POSITIVE_INFINITY,
    });
    servers.push(mock);

    await expect(
      waitForNeonProxyReady({
        fetchEndpoint: mock.fetchEndpoint,
        wsProxy: mock.wsProxy,
        connectionString: "postgresql://user:pass@db.localtest.me:5432/testdb",
        timeoutMs: 300,
        intervalMs: 25,
        attemptTimeoutMs: 500,
      }),
    ).rejects.toThrow(/\/v2/);
  });
});
