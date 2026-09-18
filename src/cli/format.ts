/** 按显示宽度对齐（中文按 2 列宽估算），避免表格错位。 */
export function pad(value: string, width: number): string {
  let length = 0;
  for (const ch of value) length += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return value + ' '.repeat(Math.max(0, width - length));
}

export function formatMs(ms: number | undefined): string {
  return ms === undefined ? '—' : `${ms}ms`;
}
