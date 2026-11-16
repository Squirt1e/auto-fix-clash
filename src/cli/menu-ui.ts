import { input, password } from '@inquirer/prompts';
import { createPrompt, useState, useEffect, useKeypress, usePagination } from '@inquirer/core';
import type { Key } from 'node:readline';
import { ControllerDiscoveryError } from '../controller/discovery.ts';
import { currentScreen } from './menu-screen.ts';

export const BACK = '__back';
export const line = (text: string): void => { process.stdout.write(`${text}\n`); };
export const heading = (path: string): void => {
  const screen = currentScreen();
  if (screen) screen.page(path);
  else line(`\nAFC / ${path}\n`);
};

export function cancelled(error: unknown): boolean {
  return error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name);
}

export interface Choice { name: string; value: string; disabled?: string | boolean }

interface Selection { value?: string; term: string }
interface MenuPrompt { message: string; choices: Choice[]; state: Selection; searchable: boolean }
const selections = new Map<string, Selection>();

// 复用 Inquirer 的输入生命周期与列表分页，额外保存每页的搜索和选中项。
const menuPrompt = createPrompt<string, MenuPrompt>((config, done) => {
  const screen = currentScreen();
  const [term, setTerm] = useState(config.state.term);
  const [selected, setSelected] = useState(config.state.value);
  const [focus, setFocus] = useState<'options' | 'search'>('options');
  const [caret, setCaret] = useState(Array.from(term).length);
  const [finished, setFinished] = useState(false);
  const [height, setHeight] = useState(screen?.bodyRows ?? 20);
  const [startY] = useState(screen?.terminal.buffer.active.cursorY ?? 0);
  const choices = config.choices.filter((choice) => !config.searchable || choice.value === BACK ||
    choice.name.toLowerCase().includes(term.toLowerCase()));
  let active = choices.findIndex((choice) => choice.value === selected && !choice.disabled);
  if (active < 0) active = choices.findIndex((choice) => !choice.disabled);
  const current = choices[active];
  useEffect(() => {
    const resize = (): void => setHeight(screen?.bodyRows ?? 20);
    process.stdout.on('resize', resize);
    return () => { process.stdout.removeListener('resize', resize); };
  }, []);
  useKeypress((event, rl) => {
    if (finished) return;
    const key = event as Key;
    rl.clearLine(0);
    if (screen && screen.rows < 6) return;
    if (key.name === 'pageup' || key.name === 'pagedown') {
      screen?.scroll(key.name === 'pageup' ? 1 : -1); return;
    }
    screen?.bottom();
    if (key.name === 'up' || key.name === 'down') {
      setFocus('options');
      const step = key.name === 'up' ? -1 : 1;
      for (let next = active + step; next >= 0 && next < choices.length; next += step) {
        const choice = choices[next]!;
        if (!choice.disabled) {
          setSelected(choice.value);
          if (choice.value !== BACK) config.state.value = choice.value;
          break;
        }
      }
      return;
    }
    if (key.name === 'tab' && config.searchable) {
      setFocus(focus === 'options' ? 'search' : 'options'); return;
    }
    if (focus === 'options' && key.name === 'left') {
      if (config.choices.some((choice) => choice.value === BACK && choice.name !== '退出')) {
        setFinished(true); done(BACK);
      }
      return;
    }
    if (key.name === 'return' || key.name === 'enter' || focus === 'options' && key.name === 'right') {
      if (current) {
        if (current.value !== BACK) config.state.value = current.value;
        setFinished(true); done(current.value);
      }
      return;
    }
    if (!config.searchable || key.ctrl || key.meta) return;
    const chars = Array.from(term);
    if (focus === 'search' && (key.name === 'left' || key.name === 'right')) {
      setCaret(Math.max(0, Math.min(chars.length, caret + (key.name === 'left' ? -1 : 1)))); return;
    }
    let next = term;
    if (key.name === 'backspace' && caret > 0) {
      chars.splice(caret - 1, 1); next = chars.join(''); setCaret(caret - 1);
    } else if (key.name === 'delete') {
      chars.splice(caret, 1); next = chars.join('');
    } else if (key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) {
      chars.splice(caret, 0, key.sequence); next = chars.join(''); setCaret(caret + Array.from(key.sequence).length);
    } else return;
    setFocus('search'); setTerm(next); config.state.term = next;
  });
  const body = usePagination({ items: choices, active: Math.max(0, active), loop: false,
    pageSize: Math.max(1, Math.min(10, height - startY - 3)),
    renderItem: ({ item, isActive }) => item.disabled
      ? `  ${item.name}（${typeof item.disabled === 'string' ? item.disabled : '不可用'}）`
      : isActive ? `\x1b[36m❯ ${item.name}\x1b[0m` : `  ${item.name}` });
  const chars = Array.from(term);
  const search = config.searchable ? `搜索：${focus === 'search'
    ? `${chars.slice(0, caret).join('')}▏${chars.slice(caret).join('')}` : term || '输入可筛选'}` : '';
  return [config.message === '请选择' ? '' : config.message, search, body].filter(Boolean).join('\n') + '\x1b[?25l';
});

async function selectMenu(message: string, choices: Choice[], searchable: boolean, initial?: string): Promise<string> {
  const screen = currentScreen();
  await screen?.ready();
  screen?.progress('');
  const key = JSON.stringify([screen?.path, message]);
  const state = selections.get(key) ?? { term: '' };
  if (initial !== undefined) state.value = initial;
  selections.set(key, state);
  screen?.hint(searchable ? '输入搜索 · Tab 切换焦点 · ↑↓ 选择 · ← 返回 · →/Enter 确认 · PgUp/PgDn 翻页' : undefined);
  try { return await menuPrompt({ message, choices, state, searchable }, { clearPromptOnDone: true }); }
  finally { screen?.hint(); }
}

export async function choose(message: string, choices: Choice[], initial?: string): Promise<string> {
  return selectMenu(message, choices, false, initial);
}

export async function pick(message: string, choices: Choice[]): Promise<string> {
  return selectMenu(message, [...choices, { name: '返回', value: BACK }], true);
}

export async function ask(message: string, options: {
  default?: string; secret?: boolean; validate?: (text: string) => string | true;
} = {}): Promise<string> {
  const prompt = options.secret ? password : input;
  const screen = currentScreen();
  await screen?.ready();
  screen?.hint('输入内容 · Enter 确认 · Ctrl+C 退出');
  screen?.cursor(true);
  try {
    return await prompt({ message, ...(!options.secret && options.default !== undefined ? { default: options.default } : {}),
      validate: (value: string) => screen && screen.rows < 6 ? '请放大终端窗口。'
        : (options.validate ?? ((text: string) => text.trim() ? true : '请填写内容。'))(value) }, { clearPromptOnDone: true });
  } finally { screen?.hint(); }
}

export async function approve(message: string): Promise<boolean> {
  return await choose(message, [{ name: '取消', value: BACK }, { name: '确认', value: 'yes' }]) === 'yes';
}

export async function pause(): Promise<void> {
  await choose('下一步', [{ name: '返回', value: BACK }]);
}

/** 失败留在原处；只有用户选择重试，才重新执行操作。 */
export async function perform(work: () => Promise<void>, success?: string): Promise<void> {
  const path = currentScreen()?.path;
  for (;;) {
    try {
      await work();
      if (success) line(`✓ ${success}`);
      return;
    } catch (error) {
      if (cancelled(error)) throw error;
      const screen = currentScreen();
      await screen?.ready();
      const output = screen?.text();
      const detail = error instanceof Error ? error.message : String(error);
      const summary = error instanceof ControllerDiscoveryError
        ? error.reason === 'unauthorized' ? '连接密钥不正确。' : '无法连接客户端，请检查“设置 → 连接客户端”。'
        : detail.split('\n')[0] ?? '操作失败。';
      if (path) screen?.rename(`${path} / 失败`);
      line(`✗ ${summary}`);
      for (;;) {
        const action = await choose('下一步', [
          { name: '重试', value: 'retry' }, { name: '查看详情', value: 'detail' }, { name: '返回', value: BACK },
        ], BACK);
        if (action === BACK) return;
        if (action === 'retry') { if (path) heading(path); break; }
        if (path) heading(`${path} / 详情`);
        if (output) line(output);
        line(detail);
      }
    }
  }
}
