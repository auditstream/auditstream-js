import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import {
  DEFAULT_NEON_PROXY_IMAGE,
  type NeonProxyInstance,
  type NeonProxyReadinessOptions,
  type StartNeonProxyOptions,
  startNeonProxyForCluster,
  waitForNeonProxyReady,
} from "./neon.js";
import { buildRoleSetupSql, PROTOTYPE_SCHEMA_SQL } from "./schema.js";

/** Application role created once per cluster for adapter capture tests. */
export const APP_USER: "app_user" = "app_user";

/** Password assigned to `app_user` in the test cluster. */
export const APP_PASSWORD: string = "auditstream_app_pw";

const DEFAULT_PG_IMAGE = "postgres:16-alpine";
const DEFAULT_PGBOUNCER_IMAGE = "edoburu/pgbouncer:v1.26.1-p0";
// Cluster-wide advisory lock serializing role DDL and `template1` cloning when
// multiple test workers share an external Postgres via `TEST_DATABASE_URL`.
const CLUSTER_INIT_LOCK_KEY = 7842109356123;

/** Connection URLs and cleanup handle for an isolated per-test Postgres database. */
export interface TestDatabase {
  readonly database: string;
  readonly adminUrl: string;
  readonly appUrl: string;
  drop(): Promise<void>;
}

/** Options for starting a transaction-mode PgBouncer container in front of the test cluster. */
export interface StartPgBouncerOptions {
  readonly image?: string;
  readonly poolMode?: "transaction" | "session" | "statement";
  readonly defaultPoolSize?: number;
  readonly maxPreparedStatements?: number;
}

/** Running PgBouncer instance exposing URL builders for any database on the test cluster. */
export interface PgBouncerInstance {
  readonly host: string;
  readonly port: number;
  urlFor(database: string, role?: "app" | "admin"): string;
  stop(): Promise<void>;
}

interface ClusterState {
  readonly adminHost: string;
  readonly adminPort: number;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly maintenanceDb: string;
  readonly templateDb: string;
  readonly pgNetworkAlias: string | null;
  readonly network: StartedNetwork | null;
  readonly pgContainer: StartedPostgreSqlContainer | null;
}

let clusterPromise: Promise<ClusterState> | null = null;
let dbSequence = 0;

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

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

function uniqueSuffix(): string {
  return randomBytes(4).toString("hex");
}

async function initCluster(): Promise<ClusterState> {
  const externalUrl = process.env.TEST_DATABASE_URL;
  let adminHost: string;
  let adminPort: number;
  let adminUser: string;
  let adminPassword: string;
  let maintenanceDb: string;
  let network: StartedNetwork | null = null;
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let pgNetworkAlias: string | null = null;

  if (externalUrl) {
    const parsed = new URL(externalUrl);
    adminHost = parsed.hostname;
    adminPort = parsed.port ? Number(parsed.port) : 5432;
    adminUser = decodeURIComponent(parsed.username || "postgres");
    adminPassword = decodeURIComponent(parsed.password || "");
    maintenanceDb = parsed.pathname.replace(/^\//, "") || "postgres";
  } else {
    const pgImage = process.env.TEST_PG_IMAGE || DEFAULT_PG_IMAGE;
    network = await new Network().start();
    pgNetworkAlias = "auditstream-pg";
    pgContainer = await new PostgreSqlContainer(pgImage)
      .withNetwork(network)
      .withNetworkAliases(pgNetworkAlias)
      .withDatabase("postgres")
      .withUsername("postgres")
      .withPassword("postgres")
      .start();

    adminHost = pgContainer.getHost();
    adminPort = pgContainer.getMappedPort(5432);
    adminUser = pgContainer.getUsername();
    adminPassword = pgContainer.getPassword();
    maintenanceDb = pgContainer.getDatabase();
  }

  const templateDb = `auditstream_tpl_${uniqueSuffix()}`;
  const adminClient = new pg.Client({
    connectionString: formatPgUrl(adminUser, adminPassword, adminHost, adminPort, maintenanceDb),
  });
  await adminClient.connect();
  try {
    await adminClient.query("SELECT pg_advisory_lock($1)", [CLUSTER_INIT_LOCK_KEY]);
    try {
      await adminClient.query(buildRoleSetupSql(APP_PASSWORD));
      await adminClient.query(`CREATE DATABASE ${quoteIdent(templateDb)}`);
    } finally {
      await adminClient.query("SELECT pg_advisory_unlock($1)", [CLUSTER_INIT_LOCK_KEY]);
    }
  } finally {
    await adminClient.end();
  }

  const templateClient = new pg.Client({
    connectionString: formatPgUrl(adminUser, adminPassword, adminHost, adminPort, templateDb),
  });
  await templateClient.connect();
  try {
    await templateClient.query(PROTOTYPE_SCHEMA_SQL);
  } finally {
    await templateClient.end();
  }

  return {
    adminHost,
    adminPort,
    adminUser,
    adminPassword,
    maintenanceDb,
    templateDb,
    pgNetworkAlias,
    network,
    pgContainer,
  };
}

async function getCluster(): Promise<ClusterState> {
  if (!clusterPromise) {
    clusterPromise = initCluster();
  }
  return clusterPromise;
}

/**
 * Creates a fresh Postgres database cloned from the prototype-schema template.
 * Uses `TEST_DATABASE_URL` when set, otherwise starts a container via `@testcontainers/postgresql`.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const cluster = await getCluster();
  dbSequence += 1;
  const database = `auditstream_t_${dbSequence}_${uniqueSuffix()}`;

  const adminClient = new pg.Client({
    connectionString: formatPgUrl(
      cluster.adminUser,
      cluster.adminPassword,
      cluster.adminHost,
      cluster.adminPort,
      cluster.maintenanceDb,
    ),
  });
  await adminClient.connect();
  try {
    await adminClient.query(
      `CREATE DATABASE ${quoteIdent(database)} WITH TEMPLATE ${quoteIdent(cluster.templateDb)}`,
    );
  } finally {
    await adminClient.end();
  }

  const adminUrl = formatPgUrl(
    cluster.adminUser,
    cluster.adminPassword,
    cluster.adminHost,
    cluster.adminPort,
    database,
  );
  const appUrl = formatPgUrl(
    APP_USER,
    APP_PASSWORD,
    cluster.adminHost,
    cluster.adminPort,
    database,
  );

  return {
    database,
    adminUrl,
    appUrl,
    async drop(): Promise<void> {
      const cleanupClient = new pg.Client({
        connectionString: formatPgUrl(
          cluster.adminUser,
          cluster.adminPassword,
          cluster.adminHost,
          cluster.adminPort,
          cluster.maintenanceDb,
        ),
      });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [database],
        );
        await cleanupClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`);
      } finally {
        await cleanupClient.end();
      }
    },
  };
}

/**
 * Starts a PgBouncer 1.26+ container in transaction mode pointing at the test cluster.
 */
export async function startPgBouncer(
  options: StartPgBouncerOptions = {},
): Promise<PgBouncerInstance> {
  const cluster = await getCluster();
  const image = options.image ?? process.env.TEST_PGBOUNCER_IMAGE ?? DEFAULT_PGBOUNCER_IMAGE;
  const poolMode = options.poolMode ?? "transaction";
  const defaultPoolSize = options.defaultPoolSize ?? 3;
  const maxPreparedStatements = options.maxPreparedStatements ?? 200;

  const isLocalHost =
    cluster.adminHost === "localhost" ||
    cluster.adminHost === "127.0.0.1" ||
    cluster.adminHost === "::1";
  const upstreamHost =
    cluster.pgNetworkAlias ?? (isLocalHost ? "host.docker.internal" : cluster.adminHost);
  const upstreamPort = cluster.pgNetworkAlias ? 5432 : cluster.adminPort;

  const pgbouncerIni = [
    "[databases]",
    `* = host=${upstreamHost} port=${upstreamPort}`,
    "",
    "[pgbouncer]",
    "listen_addr = 0.0.0.0",
    "listen_port = 6432",
    "auth_type = scram-sha-256",
    "auth_file = /etc/pgbouncer/userlist.txt",
    `pool_mode = ${poolMode}`,
    `default_pool_size = ${defaultPoolSize}`,
    `max_prepared_statements = ${maxPreparedStatements}`,
    "max_client_conn = 200",
    "ignore_startup_parameters = extra_float_digits,options",
    "",
  ].join("\n");

  const escapeIniVal = (val: string): string => val.replaceAll('"', '""');
  const userlist = [
    `"${escapeIniVal(APP_USER)}" "${escapeIniVal(APP_PASSWORD)}"`,
    `"${escapeIniVal(cluster.adminUser)}" "${escapeIniVal(cluster.adminPassword)}"`,
    "",
  ].join("\n");

  let builder = new GenericContainer(image)
    .withEntrypoint(["pgbouncer"])
    .withCommand(["/etc/pgbouncer/pgbouncer.ini"])
    .withCopyContentToContainer([
      { content: pgbouncerIni, target: "/etc/pgbouncer/pgbouncer.ini" },
      { content: userlist, target: "/etc/pgbouncer/userlist.txt" },
    ])
    .withExposedPorts(6432)
    .withWaitStrategy(Wait.forListeningPorts());

  if (cluster.network) {
    builder = builder.withNetwork(cluster.network);
  } else if (isLocalHost) {
    builder = builder.withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }]);
  }

  const container: StartedTestContainer = await builder.start();
  const host = container.getHost();
  const port = container.getMappedPort(6432);

  return {
    host,
    port,
    urlFor(database: string, role: "app" | "admin" = "app"): string {
      if (role === "admin") {
        return formatPgUrl(cluster.adminUser, cluster.adminPassword, host, port, database);
      }
      return formatPgUrl(APP_USER, APP_PASSWORD, host, port, database);
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}

/**
 * Stops the shared testcontainer Postgres cluster (or drops the template database on external Postgres).
 */
export async function stopTestCluster(): Promise<void> {
  if (!clusterPromise) {
    return;
  }
  const cluster = await clusterPromise;
  clusterPromise = null;

  if (cluster.pgContainer) {
    await cluster.pgContainer.stop();
  } else {
    const adminClient = new pg.Client({
      connectionString: formatPgUrl(
        cluster.adminUser,
        cluster.adminPassword,
        cluster.adminHost,
        cluster.adminPort,
        cluster.maintenanceDb,
      ),
    });
    await adminClient.connect();
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(cluster.templateDb)}`);
    } finally {
      await adminClient.end();
    }
  }

  if (cluster.network) {
    await cluster.network.stop();
  }
}

/**
 * Starts a local Neon HTTP + WebSocket proxy container in front of the test Postgres cluster.
 */
export async function startNeonProxy(
  options: StartNeonProxyOptions = {},
): Promise<NeonProxyInstance> {
  const cluster = await getCluster();
  return startNeonProxyForCluster(
    {
      ...cluster,
      appUser: APP_USER,
      appPassword: APP_PASSWORD,
    },
    options,
  );
}

export { buildRoleSetupSql, PROTOTYPE_SCHEMA_SQL } from "./schema.js";
export {
  DEFAULT_NEON_PROXY_IMAGE,
  type NeonProxyInstance,
  type NeonProxyReadinessOptions,
  type StartNeonProxyOptions,
  waitForNeonProxyReady,
};
