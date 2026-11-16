import xterm from '@xterm/headless';
import type { IBufferCell } from '@xterm/headless';

const ESC = '\x1b[';
const NAVIGATION = '↑↓ 选择 · ← 返回 · →/Enter 确认 · PgUp/PgDn 翻页 · Ctrl+C 退出';

function color(cell: IBufferCell, background: boolean): string {
  const value = background ? cell.getBgColor() : cell.getFgColor();
  const prefix = background ? 48 : 38;
  if (background ? cell.isBgRGB() : cell.isFgRGB())
    return `${prefix};2;${value >> 16 & 255};${value >> 8 & 255};${value & 255}`;
  if (background ? cell.isBgPalette() : cell.isFgPalette()) return `${prefix};5;${value}`;
  return '';
}

function attributes(cell: IBufferCell): string {
  return [cell.isBold() ? '1' : '', cell.isDim() ? '2' : '', cell.isItalic() ? '3' : '',
    cell.isUnderline() ? '4' : '', cell.isInverse() ? '7' : '', cell.isInvisible() ? '8' : '',
    cell.isStrikethrough() ? '9' : '', color(cell, false), color(cell, true)].filter(Boolean).join(';');
}

/** 接住现有命令与 Inquirer 的输出，统一绘制当前画面，不改动命令的业务逻辑。 */
export class MenuScreen {
  readonly terminal: InstanceType<typeof xterm.Terminal>;
  path = '首页';
  private readonly stdoutWrite = process.stdout.write;
  private readonly stderrWrite = process.stderr.write;
  private readonly wasRaw = process.stdin.isRaw;
  private frame: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private pending = 0;
  private offset = 0;
  private cursorVisible = true;
  private footer = NAVIGATION;
  private activity = '';
  private readonly onResize = (): void => {
    this.terminal.resize(this.columns, this.bodyRows);
    this.frame = [];
    this.schedule();
  };
  private readonly onExit = (): void => this.close();
  private readonly onInterrupt = (): void => { this.close(); process.exit(130); };
  private readonly onTerminate = (): void => { this.close(); process.exit(143); };
  private readonly onHangup = (): void => { this.close(); process.exit(129); };

  get columns(): number { return Math.max(2, process.stdout.columns || 80); }
  get rows(): number { return Math.max(1, process.stdout.rows || 24); }
  get bodyRows(): number { return Math.max(1, this.rows - 4); }

  constructor() {
    this.terminal = new xterm.Terminal({ cols: this.columns, rows: this.bodyRows,
      scrollback: 2000, allowProposedApi: true, convertEol: true });
    for (const final of ['h', 'l']) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(25)) this.cursorVisible = final === 'h';
        return false;
      });
    }
    this.raw(`${ESC}?1049h${ESC}H${ESC}2J`);
    for (const stream of [process.stdout, process.stderr]) {
      stream.write = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
        const callback = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
        this.write(chunk, callback);
        return true;
      }) as typeof stream.write;
    }
    process.stdout.on('resize', this.onResize);
    process.once('exit', this.onExit);
    process.once('SIGINT', this.onInterrupt);
    process.once('SIGTERM', this.onTerminate);
    process.once('SIGHUP', this.onHangup);
    this.schedule();
  }

  private raw(text: string): void { this.stdoutWrite.call(process.stdout, text); }

  private write(text: string | Uint8Array, callback?: () => void): void {
    if (this.closed) { callback?.(); return; }
    this.pending++;
    this.terminal.write(text, () => {
      this.pending--;
      callback?.();
      this.schedule();
    });
  }

  async ready(): Promise<void> {
    if (!this.closed) await new Promise<void>((resolve) => this.write('', resolve));
  }

  page(path: string): void {
    this.path = path;
    this.offset = 0;
    this.footer = NAVIGATION;
    this.activity = '';
    this.cursorVisible = false;
    // 清除虚拟画面与它的历史，而不是清空用户原有的终端。
    this.write(`${ESC}0m${ESC}2J${ESC}3J${ESC}H`);
  }

  rename(path: string): void { this.path = path; this.schedule(); }

  text(): string {
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: buffer.baseY + buffer.cursorY + 1 }, (_, i) =>
      buffer.getLine(i)?.translateToString(true) ?? '').join('\n').trimEnd();
  }

  hint(text = NAVIGATION): void { this.footer = text; this.schedule(); }
  cursor(visible: boolean): void { this.cursorVisible = visible; this.schedule(); }
  progress(text: string): void {
    this.activity = text;
    if (text) this.cursorVisible = false;
    this.schedule();
  }

  scroll(pages: number): void {
    const base = this.terminal.buffer.active.baseY;
    this.offset = Math.max(0, Math.min(base, this.offset + pages * Math.max(1, this.bodyRows - 2)));
    this.schedule();
  }

  bottom(): void { if (this.offset) { this.offset = 0; this.schedule(); } }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 16);
  }

  private plain(text: string): string {
    let width = 0;
    let result = '';
    for (const char of text.replace(/[\x00-\x1f\x7f]/g, ' ')) {
      const size = /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
      if (width + size > this.columns - 1) break;
      width += size;
      result += char;
    }
    return result;
  }

  private bodyLine(index: number): string {
    const buffer = this.terminal.buffer.active;
    const row = buffer.getLine(index);
    if (!row) return '';
    const cell = buffer.getNullCell();
    let end = this.columns;
    while (end > 0) {
      row.getCell(end - 1, cell);
      if (cell.getChars().trim() || !cell.isAttributeDefault()) break;
      end--;
    }
    let result = '';
    let style = '';
    for (let x = 0; x < end; x++) {
      row.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      const next = attributes(cell);
      if (next !== style) { result += `${ESC}0${next ? `;${next}` : ''}m`; style = next; }
      result += cell.getChars() || ' ';
    }
    return result + (style ? `${ESC}0m` : '');
  }

  private render(): void {
    if (this.closed || this.pending) return;
    const buffer = this.terminal.buffer.active;
    const base = Math.max(0, buffer.baseY - this.offset);
    const rule = '─'.repeat(Math.max(1, this.columns - 1));
    const rows = this.rows < 6 ? [this.plain('请放大终端窗口，或按 Ctrl+C 退出。')]
      : [this.plain(`AFC / ${this.path}`), this.activity ? this.plain(this.activity) : rule,
      ...Array.from({ length: this.bodyRows }, (_, i) => this.bodyLine(base + i)),
      rule, this.plain(this.footer)];
    let output = '';
    for (const [index, row] of rows.entries()) {
      if (this.frame[index] !== row) output += `${ESC}${index + 1};1H${ESC}0m${row}${ESC}0m${ESC}K`;
    }
    const visible = this.rows >= 6 && this.cursorVisible && this.offset === 0;
    const y = Math.max(1, Math.min(this.rows - 2, buffer.cursorY + 3));
    const x = Math.min(this.columns, buffer.cursorX + 1);
    // 绝对定位且不写换行，最后一行不会把整页顶走。
    this.raw(`${ESC}?25l${ESC}?7l${output}${ESC}?7h${ESC}${y};${x}H${visible ? `${ESC}?25h` : ''}`);
    this.frame = rows;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    process.stdout.write = this.stdoutWrite;
    process.stderr.write = this.stderrWrite;
    process.stdout.removeListener('resize', this.onResize);
    process.removeListener('exit', this.onExit);
    process.removeListener('SIGINT', this.onInterrupt);
    process.removeListener('SIGTERM', this.onTerminate);
    process.removeListener('SIGHUP', this.onHangup);
    if (process.stdin.isTTY) process.stdin.setRawMode(this.wasRaw === true);
    this.raw(`${ESC}0m${ESC}?7h${ESC}?25h${ESC}?1049l`);
    this.terminal.dispose();
  }
}

let active: MenuScreen | undefined;
export function currentScreen(): MenuScreen | undefined { return active; }
export function beginScreen(): void { active = new MenuScreen(); }
export function endScreen(): void { active?.close(); active = undefined; }
