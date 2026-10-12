/**
 * A length of time as a clock shows it: `0:07`, `1:05`, `1:02:03`. For a
 * video's length beside its placeholder and for the player's own times.
 */
export function clock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(whole / 60);
  const hours = Math.floor(minutes / 60);
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes % 60)}:${two(whole % 60)}`
    : `${minutes}:${two(whole % 60)}`;
}
