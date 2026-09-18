#!/usr/bin/env node
// 可执行入口：Node >= 22.6 可直接执行 TypeScript（类型擦除）。
// 这里显式调用 main，而不是依赖 index.ts 里的入口判断 ——
// 通过全局符号链接（pnpm link --global）调用时 argv[1] 是链接路径，
// 靠文件名后缀判断会静默不执行。
import { main } from '../src/cli/index.ts';

process.exitCode = await main(process.argv.slice(2));
