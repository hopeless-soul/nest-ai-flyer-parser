/** Liveness of this API process and reachability of its database */
export class HealthDto {
  /** Always `ok`; failures are answered with 503 and the same shape (`status: 'error'`) */
  status!: 'ok';

  /** Seconds since this process started */
  uptimeSeconds!: number;

  /** Result of a `SELECT 1` against Postgres */
  database!: 'up';
}
