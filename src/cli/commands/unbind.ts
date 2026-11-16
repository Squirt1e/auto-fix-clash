import { run as bind } from './bind.ts';
import type { CommandContext } from '../context.ts';
export const run = (context: CommandContext): Promise<number> => bind(context, true);
