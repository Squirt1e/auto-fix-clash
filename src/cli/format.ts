/** 按显示宽度对齐（中文按 2 列宽估算），避免表格错位。 */
export function pad(value: string, width: number): string {
  let length = 0;
  for (const ch of value) length += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return value + ' '.repeat(Math.max(0, width - length));
}

export function formatMs(ms: number | undefined): string {
  return ms === undefined ? '—' : `${ms}ms`;
}

/** 是否连到终端：非终端（管道/日志）时不输出进度这类交互信息。 */
export function interactive(): boolean {
  return process.stderr.isTTY === true;
}

/** 清掉一行进度（用于覆盖式进度输出）。 */
export function clearProgressLine(width = 72): void {
  if (interactive()) process.stderr.write(`\r${' '.repeat(width)}\r`);
}
