import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

/**
 * Community Neon local HTTP + WebSocket proxy image pinned by digest for deterministic CI runs.
 * Proxies HTTP (`/sql`) and WebSocket (`/v1`, `/v2`) traffic on port 4444 to an upstream Postgres.
 */
export const DEFAULT_NEON_PROXY_IMAGE: string =
  "ghcr.io/timowilhelm/local-neon-http-proxy@sha256:cd2ae14edf2feafbc3330492de5c80506f77274c3bd013154cdef697bdeb768a";

/** Options for starting the local Neon proxy container in front of the test Postgres cluster. */
export interface StartNeonProxyOptions {
  /** Override the container image (defaults to {@link DEFAULT_NEON_PROXY_IMAGE}). */
  readonly image?: string;
  /** Optional database name to include in `PG_CONNECTION_STRING` (defaults to the cluster maintenance DB). */
  readonly database?: string;
}

/** Minimal cluster network metadata required to connect the Neon proxy to the test Postgres server. */
export interface NeonProxyClusterTarget {
  readonly adminHost: string;
  readonly adminPort: number;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly maintenanceDb: string;
  readonly appUser: string;
  readonly appPassword: string;
  readonly pgNetworkAlias: string | null;
  readonly network: import("testcontainers").StartedNetwork | null;
}

/** Running local Neon proxy instance exposing HTTP and WebSocket endpoints for `@neondatabase/serverless`. */
export interface NeonProxyInstance {
  readonly host: string;
  readonly port: number;
  readonly wsProxy: string;
  readonly fetchEndpoint: string;
  urlFor(database: string, role?: "app" | "admin"): string;
  stop(): Promise<void>;
}

/** Options for polling a local Neon proxy until both HTTP (`/sql`) and WebSocket (`/v2`) endpoints accept traffic. */
export interface NeonProxyReadinessOptions {
  readonly fetchEndpoint: string;
  readonly wsProxy: string;
  readonly connectionString: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly attemptTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_INTERVAL_MS = 100;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === "object" && err !== null) {
    if ("message" in err && typeof err.message === "string" && err.message.length > 0) {
      return err.message;
    }
    if ("error" in err) {
      return describeError(err.error);
    }
  }
  return String(err);
}

async function probeNeonHttp(
  fetchEndpoint: string,
  connectionString: string,
  attemptTimeoutMs: number,
): Promise<void> {
  const response = await fetch(fetchEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": connectionString,
      "Neon-Raw-Text-Output": "true",
      "Neon-Array-Mode": "true",
    },
    body: JSON.stringify({ query: "SELECT 1", params: [] }),
    signal: AbortSignal.timeout(attemptTimeoutMs),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const detail = bodyText.trim().slice(0, 120);
    throw new Error(
      detail.length > 0 ? `HTTP ${response.status} (${detail})` : `HTTP ${response.status}`,
    );
  }

  await response.body?.cancel().catch(() => {});
}

function probeNeonWebSocket(wsProxy: string, attemptTimeoutMs: number): Promise<void> {
  const wsUrl =
    wsProxy.startsWith("ws://") || wsProxy.startsWith("wss://") ? wsProxy : `ws://${wsProxy}`;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);

    const cleanup = (): void => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };

    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // Ignore close errors on an already-failed socket.
      }
      reject(err instanceof Error ? err : new Error(describeError(err)));
    };

    const onOpen = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // Ignore close errors during teardown after a confirmed handshake.
      }
      resolve();
    };

    const onError = (event: unknown): void => {
      fail(new Error(`WebSocket handshake failed: ${describeError(event)}`));
    };

    const onClose = (): void => {
      fail(new Error("WebSocket closed before completing handshake"));
    };

    const timer = setTimeout(() => {
      fail(new Error(`WebSocket handshake timed out after ${attemptTimeoutMs}ms`));
    }, attemptTimeoutMs);

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function isAbortTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

async function pollUntilReady(
  label: string,
  probe: (attemptTimeoutMs: number) => Promise<void>,
  deadline: number,
  intervalMs: number,
  attemptTimeoutMs: number,
): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    try {
      await probe(Math.min(attemptTimeoutMs, remainingMs));
      return;
    } catch (err) {
      if (lastError === undefined || !isAbortTimeoutError(err)) {
        lastError = err;
      }
      const waitMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }
  throw new Error(
    `Neon proxy ${label} did not become ready in time: ${describeError(lastError ?? "timeout")}`,
  );
}

/**
 * Waits until a local Neon proxy's HTTP (`/sql`) and WebSocket (`/v2`) endpoints both accept traffic.
 *
 * `ghcr.io/timowilhelm/local-neon-http-proxy` opens TCP port 4444 before its upstream backend finishes
 * initializing, so `Wait.forListeningPorts()` alone races with early HTTP 502s and WebSocket handshake
 * drops.
 */
export async function waitForNeonProxyReady(options: NeonProxyReadinessOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  await pollUntilReady(
    `HTTP endpoint (${options.fetchEndpoint})`,
    (ms) => probeNeonHttp(options.fetchEndpoint, options.connectionString, ms),
    deadline,
    intervalMs,
    attemptTimeoutMs,
  );

  await pollUntilReady(
    `WebSocket endpoint (ws://${options.wsProxy})`,
    (ms) => probeNeonWebSocket(options.wsProxy, ms),
    deadline,
    intervalMs,
    attemptTimeoutMs,
  );
}

function formatPgUrl(
  user: string,
  password: string,
  host: string,
  port: number,
  database: string,
): string {
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${database}`;
}

/**
 * Starts `ghcr.io/timowilhelm/local-neon-http-proxy` pointing at the supplied test Postgres target.
 */
export async function startNeonProxyForCluster(
  cluster: NeonProxyClusterTarget,
  options: StartNeonProxyOptions = {},
): Promise<NeonProxyInstance> {
  const image = options.image ?? process.env.TEST_NEON_PROXY_IMAGE ?? DEFAULT_NEON_PROXY_IMAGE;
  const targetDb = options.database ?? cluster.maintenanceDb;

  const isLocalHost =
    cluster.adminHost === "localhost" ||
    cluster.adminHost === "127.0.0.1" ||
    cluster.adminHost === "::1";
  const upstreamHost =
    cluster.pgNetworkAlias ?? (isLocalHost ? "host.docker.internal" : cluster.adminHost);
  const upstreamPort = cluster.pgNetworkAlias ? 5432 : cluster.adminPort;
  const pgConnectionString = formatPgUrl(
    cluster.adminUser,
    cluster.adminPassword,
    upstreamHost,
    upstreamPort,
    targetDb,
  );

  let builder = new GenericContainer(image)
    .withEnvironment({
      PG_CONNECTION_STRING: pgConnectionString,
    })
    .withExposedPorts(4444)
    .withWaitStrategy(Wait.forListeningPorts());

  if (cluster.network) {
    builder = builder.withNetwork(cluster.network);
  } else if (isLocalHost) {
    builder = builder.withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }]);
  }

  const container: StartedTestContainer = await builder.start();
  const host = container.getHost();
  const port = container.getMappedPort(4444);
  const wsProxy = `${host}:${port}/v2`;
  const fetchEndpoint = `http://${host}:${port}/sql`;

  const instance: NeonProxyInstance = {
    host,
    port,
    wsProxy,
    fetchEndpoint,
    urlFor(database: string, role: "app" | "admin" = "app"): string {
      if (role === "admin") {
        return formatPgUrl(
          cluster.adminUser,
          cluster.adminPassword,
          "db.localtest.me",
          5432,
          database,
        );
      }
      return formatPgUrl(cluster.appUser, cluster.appPassword, "db.localtest.me", 5432, database);
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };

  try {
    await waitForNeonProxyReady({
      fetchEndpoint,
      wsProxy,
      connectionString: instance.urlFor(targetDb, "admin"),
    });
  } catch (err) {
    await container.stop().catch(() => {});
    throw err;
  }

  return instance;
}
