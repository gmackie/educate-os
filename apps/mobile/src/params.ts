/** One route/search param as a string ('' when absent or repeated). */
export function param(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}
