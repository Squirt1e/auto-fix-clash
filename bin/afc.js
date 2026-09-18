#!/usr/bin/env node
// 可执行入口。
//
// 优先用编译产物 dist/（npm 安装后的形态，不依赖 Node 的类型擦除能力），
// 没有构建过时回退到源码（本地开发时 node_modules/.bin/afc 也能直接用）。
//
// 这里显式调用 main，而不是依赖 index 里的入口判断 ——
// 通过全局符号链接/垫片调用时 argv[1] 不是真实模块路径，靠它判断会静默不执行。
import { existsSync } from 'node:fs';

const built = new URL('../dist/cli/index.js', import.meta.url);
const source = new URL('../src/cli/index.ts', import.meta.url);
const entry = existsSync(built) ? built : source;

const { main } = await import(entry.href);
process.exitCode = await main(process.argv.slice(2));
