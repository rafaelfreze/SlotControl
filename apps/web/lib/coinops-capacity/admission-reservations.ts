/** Binance admission budgets are separate for every fixed-IP shard/environment.
 * CPU/RAM are measured executor-wide; they never become fictional API weight. */
export function shardReservedWeight(shardId: string, environment: "REAL" | "TESTNET",
  reservations: readonly { shard_id: string; environment: string; reserved_weight: number | string }[]) {
  return reservations.filter((row) => row.shard_id === shardId && row.environment === environment)
    .reduce((sum, row) => sum + Number(row.reserved_weight), 0);
}
