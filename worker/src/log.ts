/** One JSON line per stage. Workers Logs picks these up when observability is enabled. */
export function logStage(stage: string, fields: Record<string, unknown> = {}): void {
  const payload: Record<string, unknown> = { stage };
  for (const [key, value] of Object.entries(fields)) {
    payload[key] = typeof value === "string"
      ? value.replace(/([?&](?:key|uploads|token)=)[^&\s]+/gi, "$1redacted")
      : value;
  }
  console.log(JSON.stringify(payload));
}
