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

  return {
    host,
    port,
    wsProxy: `${host}:${port}/v2`,
    fetchEndpoint: `http://${host}:${port}/sql`,
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
}
