import * as mysql from 'mysql2/promise';
import * as pg from 'pg';
import * as mssql from 'mssql';

const supportedDrivers = ['mysql', 'postgres', 'mssql'] as const;

export type DriverKey = typeof supportedDrivers[number];

export interface Pool {
  getConnection: () => Promise<Conn>;
  end: () => void;
}

// ExecutionResult can represent the output of multiple queries,
// any of which can be `exec`, schema changes, `select`, etc.
export type ExecutionResult = TabularResult[];

// TabularResult represents a table of data capable of marshalling into human readable output.
export type TabularResult = Row[];

// Row represents an arbitrary map of data with marshallable values.
export type Row = { [key: string]: string | number | null };

// Conn is an abstraction over driver-specific connection interfaces.
interface Conn {
  release: () => void;
  query: (q: string) => Promise<ExecutionResult>;
  destroy: () => void;
}

// PoolConfig exposes general and driver-specific configuration options for opening database pools.
export type PoolConfig = MySQLConfig | MSSQLConfig | PostgresConfig;

// BaseConfig describes driver configuration options common between all implementations.
// Driver-specific options are included in extensions that inherit this.
interface BaseConfig {
  driver: DriverKey;
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
}

interface MySQLConfig extends BaseConfig {
  driver: 'mysql';
  multipleStatements: boolean;
}

export async function getPool(c: PoolConfig): Promise<Pool> {
  switch (c.driver) {
    case 'mysql':
      return createMySQLPool(c);
    case 'mssql':
      return createMSSQLPool(c);
    case 'postgres':
      return createPostgresPool(c);
    default:
      throw Error('invalid driver key');
  }
}

async function createMySQLPool({
  host,
  port,
  user,
  password,
  database,
  multipleStatements,
}: MySQLConfig): Promise<Pool> {
  return mysqlPool(
    mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      multipleStatements,
    })
  );
}

function mysqlPool(pool: mysql.Pool): Pool {
  return {
    async getConnection(): Promise<Conn> {
      return mysqlConn(await pool.getConnection());
    },
    end() {
      pool.end();
    },
  };
}

function mysqlConn(conn: mysql.PoolConnection): Conn {
  return {
    destroy() {
      conn.destroy();
    },
    async query(q: string): Promise<ExecutionResult> {
      const [result, ok] = (await conn.query(q)) as any;
      console.debug('mysql query result', { result, ok });

      if (!result.length) {
        // this is a singleton exec query result
        return [[result]];
      }

      // this reliably indicates whether there are results for multiple distinct queries
      const hasMultipleResults = ok.length > 1;
      if (hasMultipleResults) {
        // when we have `ResultSetHeader`, which is the result of an exec request,
        // we want to nest that into an array so that is display as a single row table
        return result.map((res: any) =>
          res.length !== undefined ? res : [res]
        );
      }
      return [result];
    },
    release() {
      conn.release();
    },
  };
}

interface PostgresConfig extends BaseConfig {
  driver: 'postgres';
}

async function createPostgresPool({
  host,
  port,
  user,
  password,
  database,
}: PostgresConfig): Promise<Pool> {
  const pool = new pg.Pool({
    host,
    port,
    password,
    database,
    user,
  });
  return postgresPool(pool);
}

function postgresPool(pool: pg.Pool): Pool {
  return {
    async getConnection(): Promise<Conn> {
      const conn = await pool.connect();
      return postgresConn(conn);
    },
    end() {
      pool.end();
    },
  };
}

function postgresConn(conn: pg.PoolClient): Conn {
  return {
    async query(q: string): Promise<ExecutionResult> {
      const response = (await conn.query(q)) as any as pg.QueryResult<any>[];
      console.debug('pg query response', { response });

      // Typings for pg unfortunately miss that `query` may return an array of
      // results when the query strings contains multiple sql statements.
      const maybeResponses = !!response.length
        ? response
        : ([response] as any as pg.QueryResult<any>[]);

      return maybeResponses.map(({ rows, rowCount }) => {
        if (!rows.length) {
          return rowCount !== null ? [{ rowCount: rowCount }] : [];
        }
        return rows;
      });
    },
    destroy() {
      // TODO: verify
      conn.release();
    },
    release() {
      conn.release();
    },
  };
}

interface MSSQLConfig extends BaseConfig {
  driver: 'mssql';
  encrypt: boolean;
  trustServerCertificate: boolean;
}

async function createMSSQLPool(config: MSSQLConfig): Promise<Pool> {
  const conn = await mssql.connect({
    server: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
    },
  });
  return mssqlPool(conn);
}

function mssqlPool(pool: mssql.ConnectionPool): Pool {
  return {
    async getConnection(): Promise<Conn> {
      const req = new mssql.Request();
      return mssqlConn(req);
    },
    end() {
      pool.close();
    },
  };
}

function mssqlConn(req: mssql.Request): Conn {
  return {
    destroy() {
      req.cancel();
    },
    async query(q: string): Promise<ExecutionResult> {
      // TODO: support multiple queries
      const res = await req.query(q);
      if (res.recordsets.length < 1) {
        return [[{ rows_affected: `${res.rowsAffected}` }]];
      }
      return [res.recordsets[0]];
    },
    release() {
      // TODO: verify correctness
    },
  };
}
