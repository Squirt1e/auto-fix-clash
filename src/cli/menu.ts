import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { loadConfig } from '../config.ts';
import { materializeDomainsInConfigText, writeConfigText } from '../config-edit.ts';
import { isGroup, type ProxyInfo } from '../controller/client.ts';
import { describeEndpoint } from '../controller/http.ts';
import { parseEndpointString } from '../controller/discovery.ts';
import { currentProfile, inspectParty, verifyBindings, type Party } from '../bindings/party.ts';
import { readManifest, type Binding } from '../bindings/store.ts';
import { getScheduleBackend, scheduleLogFiles, type ScheduleStatus } from '../schedule/index.ts';
import { currentPlatform } from '../platform.ts';
import { parseDomainPattern } from '../targets/domain.ts';
import { resolveWritePath } from './commands/add.ts';
import { run as fix } from './commands/fix.ts';
import { run as doctor } from './commands/doctor.ts';
import { run as bind } from './commands/bind.ts';
import { run as schedule, resolveScheduleConfigArgument } from './commands/schedule.ts';
import { openRuntime, type Runtime } from './runtime.ts';
import { optString, type CommandContext } from './context.ts';
import { approve, ask, BACK, cancelled, choose, heading, line, pause, perform, pick } from './menu-ui.ts';
import { beginScreen, currentScreen, endScreen } from './menu-screen.ts';

const typeLabel = (info: ProxyInfo): string => info.type === 'Selector' ? '手动选择' : 'Clash 管理';

class Menu {
  private values: Record<string, unknown>;
  private party: Party | undefined;
  private scope: Pick<Party, 'root' | 'profile'> | undefined;
  private connectionLabel = '未连接，可在“设置”中连接';
  private timerLabel = '状态未知';

  constructor(context: CommandContext) {
    // 前台和后台默认使用同一份配置，避免在不同目录打开菜单后改错文件。
    const config = resolveScheduleConfigArgument(optString(context.values, 'config'));
    this.values = {
      ...(config ? { config } : {}),
      ...(optString(context.values, 'controller') ? { controller: context.values.controller } : {}),
      ...(optString(context.values, 'secret') ? { secret: context.values.secret } : {}),
      menu: true,
    };
  }

  private context(positionals: string[] = [], extra: Record<string, unknown> = {}): CommandContext {
    return { positionals, values: { ...this.values,
      'on-notice': (message: string) => currentScreen()?.progress(message), ...extra } };
  }

  private config() { return loadConfig(optString(this.values, 'config')); }
  private path() { return resolveWritePath(optString(this.values, 'config')); }

  private editConfig(edit: (doc: ReturnType<typeof parseDocument>) => void): void {
    const path = this.path();
    const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
    if (doc.errors.length) throw new Error(doc.errors[0]!.message);
    edit(doc);
    writeConfigText(path, doc.toString());
    this.values.config = path;
  }

  private async runtime(): Promise<Runtime> {
    try {
      const runtime = await openRuntime(this.context());
      this.connectionLabel = '已连接';
      return runtime;
    } catch (error) { this.connectionLabel = '未连接，可在“设置”中连接'; throw error; }
  }

  private async status(): Promise<ScheduleStatus> {
    try {
      const status = await (await getScheduleBackend()).status();
      this.timerLabel = status.installed && status.loaded
        ? `每 ${status.intervalSeconds ?? this.config().schedule.intervalSeconds} 秒` : '未开启';
      return status;
    } catch (error) { this.timerLabel = '状态未知'; throw error; }
  }

  private async command(work: () => Promise<number>, success?: string): Promise<boolean> {
    let completed = false;
    await perform(async () => {
      currentScreen()?.progress('处理中…');
      const code = await work();
      if (code !== 0) throw new Error(code === 2 ? '没有可用节点。' : '未全部完成，请查看上方结果。');
      completed = true;
    }, success);
    return completed;
  }

  async run(): Promise<void> {
    let previous: string | undefined;
    heading('首页');
    currentScreen()?.progress('正在读取状态…');
    await Promise.allSettled([this.runtime(), this.status()]);
    for (;;) {
      heading('首页');
      line(`客户端：${this.connectionLabel} · 定时：${this.timerLabel}`);
      const action = await choose('请选择', [
        { name: '代理组', value: 'groups' }, { name: '网站', value: 'sites' },
        { name: '定时', value: 'timer' }, { name: '设置', value: 'settings' },
        { name: '退出', value: BACK },
      ], previous);
      if (action === BACK) return;
      previous = action;
      // 子页面出错后返回首页，设置与定时入口始终可用。
      await perform(async () => {
        if (action === 'groups') await this.groups();
        if (action === 'sites') await this.sites();
        if (action === 'timer') await this.timer();
        if (action === 'settings') await this.settings();
      });
    }
  }

  private async groups(): Promise<void> {
    for (;;) {
      heading('代理组');
      currentScreen()?.progress('正在读取代理组…');
      const runtime = await this.runtime();
      const proxies = await runtime.controller.client.proxies();
      const rows = Object.entries(proxies).filter(([, info]) => isGroup(info));
      if (!rows.length) line('没有代理组。');
      const name = await pick('选择代理组', rows.map(([name, info]) => ({
        name: `${name} · ${info.now ?? '未选择'}${info.type === 'Selector' ? '' : ' · Clash 管理'}`, value: name,
      })));
      if (name === BACK) return;
      await perform(() => this.group(name));
    }
  }

  private async group(name: string): Promise<void> {
    for (;;) {
      heading(`代理组 / ${name}`);
      currentScreen()?.progress('正在读取代理组…');
      const runtime = await this.runtime();
      const info = (await runtime.controller.client.proxies())[name];
      if (!info || !isGroup(info)) { line('这个组已不存在，请重新选择。'); return; }
      line(`${typeLabel(info)} · 当前：${info.now ?? '未选择'}`);
      const action = await choose('请选择', [
        { name: '修复', value: 'fix', ...(info.type !== 'Selector' ? { disabled: '由 Clash 管理' } : {}) },
        { name: '检测节点', value: 'doctor' }, { name: '查看节点', value: 'nodes' },
        { name: '返回', value: BACK },
      ]);
      if (action === BACK) return;
      heading(`代理组 / ${name} / ${action === 'nodes' ? '节点' : action === 'fix' ? '修复' : '检测'}`);
      if (action === 'nodes') {
        for (const node of info.all ?? []) line(`${node === info.now ? '●' : ' '} ${node}`);
      } else {
        await this.command(() => (action === 'fix' ? fix : doctor)(this.context([], { group: name })),
          action === 'fix' ? '已完成，无需重启。' : '检测完成，未切换节点。');
      }
      await pause();
    }
  }

  private async refreshParty(): Promise<boolean> {
    try { this.party = await inspectParty(await this.runtime()); this.scope = this.party; return true; }
    catch { return false; }
  }

  private bindings(): Binding[] {
    const party = this.scope;
    return party ? readManifest().bindings.filter((b) => b.root === party.root && b.profile === party.profile) : [];
  }

  private async sites(): Promise<void> {
    for (;;) {
      heading('网站');
      currentScreen()?.progress('正在读取网站…');
      const online = await this.refreshParty();
      const config = this.config();
      const bindings = this.bindings();
      if (!online && this.scope) line('绑定：上次 Party 订阅，当前连接未确认。');
      const patterns = [...new Set([...config.domains.map((d) => d.pattern), ...bindings.map((b) => b.pattern)])];
      const action = await pick('选择网站', [
        ...patterns.map((pattern) => ({ name: `${pattern}${config.domains.some((d) => d.pattern === pattern) ? '' : ' · 未加入定时'}`, value: pattern })),
        { name: '添加网站', value: '__add' },
      ]);
      if (action === BACK) return;
      if (action === '__add') await perform(() => this.addSite());
      else await perform(() => this.site(action));
    }
  }

  private async addSite(): Promise<void> {
    heading('网站 / 添加');
    const domain = await ask('域名（默认包含子域名，留空返回）', {
      validate: (value) => {
        if (!value.trim()) return true;
        try { parseDomainPattern(value); return true; } catch { return '请输入域名，例如 example.com。'; }
      },
    });
    if (!domain.trim()) return;
    const parsed = parseDomainPattern(domain);
    const pattern = `*.${parsed.apex}`;
    if (this.config().domains.some((d) => d.pattern === pattern)) { line('网站已在定时列表中。'); await pause(); return; }
    if (!await this.command(() => schedule(this.context(['add', pattern])))) return;
    // schedule add 可能创建了此前不存在的用户配置。
    this.values.config = this.path();
    let enabled: boolean | undefined;
    try { const status = await this.status(); enabled = status.installed && status.loaded; } catch { /* 系统调度状态未知 */ }
    line(enabled === true ? '下次定时运行生效，无需重启。' : enabled === false ? '定时未开启，可在“定时”中开启。' : '定时状态未知，可在“定时”中查看。');
    await pause();
  }

  private async site(pattern: string): Promise<void> {
    for (;;) {
      heading(`网站 / ${pattern}`);
      const configured = this.config().domains.some((d) => d.pattern === pattern);
      const binding = this.bindings().find((b) => b.pattern === pattern);
      line(`定时：${configured ? '已加入' : '未加入'}`);
      line(`绑定：${binding ? `${binding.group}（待检查）` : '无'}`);
      const action = await choose('请选择', [
        { name: '修复', value: 'fix' },
        { name: '绑定代理组', value: 'bind' },
        ...(binding ? [{ name: '解除绑定', value: 'unbind' }, { name: '检查生效', value: 'check' }] : []),
        { name: configured ? '移出定时' : '加入定时', value: 'schedule' },
        { name: '返回', value: BACK },
      ]);
      if (action === BACK) return;
      heading(`网站 / ${pattern} / ${action === 'fix' ? '修复' : action === 'check' ? '检查生效'
        : action === 'bind' ? '绑定代理组' : action === 'unbind' ? '解除绑定' : '定时'}`);
      if (action === 'fix') await this.command(() => fix(this.context([pattern])), '已完成，无需重启。');
      if (action === 'check') await perform(() => this.checkBinding(pattern));
      if (action === 'bind' || action === 'unbind') await perform(() => this.binding(pattern, action === 'unbind'));
      if (action === 'schedule') {
        if (configured && !await approve(`将 ${pattern} 移出定时？绑定会保留。`)) continue;
        await this.command(async () => {
          if (!configured) return schedule(this.context(['add', pattern]));
          // 内置默认也可以直接移除，不要求用户先创建配置。
          const domains = this.config().domains.filter((d) => d.pattern !== pattern);
          const path = this.path();
          const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
          const doc = parseDocument(text);
          const sequence = doc.get('domains', true);
          if (isSeq(sequence)) {
            sequence.items = sequence.items.filter((item) => {
              const raw = isMap(item) ? item.get('pattern') : undefined;
              return typeof raw !== 'string' || parseDomainPattern(raw).input !== pattern;
            });
            writeConfigText(path, doc.toString());
          } else writeConfigText(path, materializeDomainsInConfigText(text, domains));
          this.values.config = path;
          return 0;
        }, configured ? '已移出定时，无需重启。' : '已加入，定时开启后自动运行。');
      }
      await pause();
    }
  }

  private async checkBinding(pattern: string): Promise<void> {
    const party = await inspectParty(await this.runtime());
    const binding = readManifest().bindings.filter((b) => b.root === party.root && b.profile === party.profile);
    if (!binding.some((b) => b.pattern === pattern)) throw new Error('当前订阅没有这个绑定。');
    const [rules, proxies] = await Promise.all([party.client.rules(), party.client.proxies()]);
    verifyBindings(binding, rules, proxies);
    this.party = party;
    this.scope = party;
    line('✓ 绑定已生效。');
  }

  private async binding(pattern: string, remove: boolean): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('绑定目前仅支持 macOS Clash Party。');
    const online = await this.refreshParty();
    let root = this.scope?.root;
    if (!root) {
      root = await ask('Clash Party 数据目录', { default: join(homedir(), 'Library/Application Support/mihomo-party') });
      if (root.startsWith('~/')) root = join(homedir(), root.slice(2));
      root = resolve(root);
    }
    root = realpathSync(root);
    const profile = currentProfile(root);
    this.scope = { root, profile };
    const old = readManifest().bindings.find((b) => b.root === root && b.profile === profile && b.pattern === pattern);
    let group = old?.group;
    let create = false;
    if (!remove) {
      const proxies = online && this.party ? await this.party.client.proxies() : {};
      const action = await pick('选择代理组', [
        ...Object.entries(proxies).filter(([, info]) => info.type === 'Selector').map(([name]) => ({ name, value: name })),
        ...(!online ? [{ name: '输入已有组名', value: '__name' }] : []),
        { name: '新建组', value: '__create' },
      ]);
      if (action === BACK) return;
      create = action === '__create';
      group = action.startsWith('__') ? await ask('组名', {
        validate: (value) => value.trim() && !/[,\r\n]/.test(value) ? true : '请填写组名，不能包含逗号或换行。',
      }) : action;
    }
    line(`${remove ? '解除绑定' : '绑定'}：${pattern}${group ? ` → ${group}` : ''}`);
    line(`订阅：${profile}`);
    line('请手动退出 Clash Party（仅关闭窗口不算退出）。保存后需手动启动。');
    if (!await approve('客户端已退出，保存？')) return;
    const code = await bind(this.context([pattern], {
      offline: true, 'client-dir': root, group, create, replace: !remove,
      ...(profile ? { 'expected-profile': profile } : {}),
      'restart-client': false,
    }), remove);
    if (code !== 0) throw new Error('未完成保存，请查看上方提示。');
    line(remove ? '已保存。请手动启动客户端，解除绑定后自建组会保留。' : '已保存。请手动启动客户端，再选择“检查生效”。');
  }

  private async timer(): Promise<void> {
    for (;;) {
      heading('定时');
      currentScreen()?.progress('正在读取定时状态…');
      const status = await this.status();
      line(status.installed ? `${status.loaded ? '已开启' : '未载入'} · 每 ${status.intervalSeconds ?? this.config().schedule.intervalSeconds} 秒` : '未开启');
      const action = await choose('请选择', [
        { name: status.installed ? '立即运行' : '开启定时', value: status.installed ? 'run' : 'enable' },
        ...(status.installed ? [{ name: '修改间隔', value: 'interval' }, { name: '关闭定时', value: 'disable' }] : []),
        { name: '查看结果', value: 'logs' }, { name: '返回', value: BACK },
      ]);
      if (action === BACK) return;
      heading(`定时 / ${action === 'logs' ? '运行结果' : action === 'run' ? '立即运行'
        : action === 'disable' ? '关闭定时' : action === 'enable' ? '开启定时' : '修改间隔'}`);
      if (action === 'run') await this.command(() => fix(this.context([], { scheduled: true })), '已完成，无需重启。');
      if (action === 'enable' || action === 'interval') await perform(async () => {
        const seconds = await ask('间隔（秒，留空返回）', {
          default: String(status.intervalSeconds ?? this.config().schedule.intervalSeconds),
          validate: (value) => !value.trim() || /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 60 ? true : '至少 60 秒，请填写整数。',
        });
        if (!seconds.trim()) return;
        this.editConfig((doc) => doc.setIn(['schedule', 'intervalSeconds'], Number(seconds)));
        line('间隔已保存，正在更新定时任务…');
        if (!await this.command(() => schedule(this.context(['install'], { interval: seconds })))) {
          line('定时任务尚未确认更新，可重新开启定时。');
        }
      });
      if (action === 'disable' && await approve('关闭定时？历史日志也会删除。')) {
        await this.command(() => schedule(this.context(['uninstall'])));
      }
      if (action === 'logs') {
        line(status.lastLogLine ?? '暂无运行记录。');
        const files = scheduleLogFiles(currentPlatform());
        for (const file of [files.out, files.err]) {
          if (existsSync(file)) {
            line(`\n${file}`);
            // 只读文件末尾，避免大日志一次占满内存。
            await this.tail(file);
          }
        }
      }
      await pause();
    }
  }

  private async tail(file: string): Promise<void> {
    const { open } = await import('node:fs/promises');
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 16 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      const rows = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (size > buffer.length) rows.shift();
      line(rows.slice(-21).join('\n').trim() || '暂无记录。');
    } finally { await handle.close(); }
  }

  private async settings(): Promise<void> {
    for (;;) {
      heading('设置');
      const action = await choose('请选择', [
        { name: '连接客户端', value: 'connect' }, { name: '检测设置', value: 'probe' }, { name: '返回', value: BACK },
      ]);
      if (action === BACK) return;
      await perform(async () => {
        if (action === 'connect') await this.connection();
        else await this.probeSettings();
      });
    }
  }

  private async connection(): Promise<void> {
    for (;;) {
      heading('设置 / 连接客户端');
      const action = await choose('请选择', [
        { name: '自动连接', value: 'auto' }, { name: '手动设置', value: 'manual' }, { name: '返回', value: BACK },
      ]);
      if (action === BACK) return;
      await perform(async () => {
        if (action === 'manual') {
          const endpoint = await ask('控制地址（留空返回）', {
            default: optString(this.values, 'controller') ?? this.config().controller.endpoint ?? '127.0.0.1:9097',
            validate: (value) => {
              if (!value.trim()) return true;
              try { parseEndpointString(value.trim()); return true; } catch { return '请输入 host:port、unix:路径 或 pipe:路径。'; }
            },
          });
          if (!endpoint.trim()) return;
          const secret = await ask('密钥（留空表示不设置）', { secret: true, validate: () => true });
          this.editConfig((doc) => {
            doc.setIn(['controller', 'endpoint'], endpoint.trim());
            if (secret) doc.setIn(['controller', 'secret'], secret);
            else doc.deleteIn(['controller', 'secret']);
          });
          delete this.values.controller;
          delete this.values.secret;
          this.party = undefined;
          this.scope = undefined;
          line('已保存，无需重启。');
        } else {
          // 自动连接会取消此前固定的地址和密钥，但保留自定义发现端口。
          this.editConfig((doc) => {
            doc.deleteIn(['controller', 'endpoint']); doc.deleteIn(['controller', 'secret']);
          });
          delete this.values.controller; delete this.values.secret;
          this.party = undefined;
          this.scope = undefined;
        }
        const runtime = await this.runtime();
        line(`✓ 已连接 ${describeEndpoint(runtime.controller.endpoint)}`);
      });
      await pause();
    }
  }

  private async probeSettings(): Promise<void> {
    for (;;) {
      heading('设置 / 检测设置');
      const config = this.config();
      line(`超时：${config.probe.timeoutMs / 1000} 秒 · 并发：${config.probe.concurrency}`);
      const action = await choose('请选择', [
        { name: '修改超时', value: 'timeoutMs' }, { name: '修改并发', value: 'concurrency' },
        { name: '指定内核', value: 'kernelPath' }, { name: '返回', value: BACK },
      ]);
      if (action === BACK) return;
      await perform(async () => {
        if (action === 'kernelPath') {
          const path = await ask('mihomo 路径（留空自动查找）', { default: config.probe.kernelPath ?? '', validate: () => true });
          this.editConfig((doc) => {
            if (path.trim()) doc.setIn(['probe', 'kernelPath'], path.trim().startsWith('~/') ? join(homedir(), path.trim().slice(2)) : resolve(path.trim()));
            else doc.deleteIn(['probe', 'kernelPath']);
          });
        } else {
          const timeout = action === 'timeoutMs';
          const value = await ask(timeout ? '超时（秒，留空返回）' : '并发（1–4，留空返回）', {
            default: String(timeout ? config.probe.timeoutMs / 1000 : config.probe.concurrency),
            validate: (text) => !text.trim() || Number.isSafeInteger(Number(text)) && Number(text) > 0 && (timeout || Number(text) <= 4) ? true : timeout ? '请填写正整数。' : '请填写 1–4。',
          });
          if (!value.trim()) return;
          this.editConfig((doc) => {
            doc.setIn(['probe', action], Number(value) * (timeout ? 1000 : 1));
            if (timeout && config.probe.screenTimeoutMs > Number(value) * 1000)
              doc.setIn(['probe', 'screenTimeoutMs'], Number(value) * 1000);
          });
        }
        line('✓ 已保存，后续运行生效，无需重启。');
      });
      await pause();
    }
  }
}

export async function runMenu(context: CommandContext): Promise<number> {
  beginScreen();
  try { await new Menu(context).run(); return 0; }
  catch (error) {
    if (cancelled(error)) { line('\n已退出。'); return 0; }
    throw error;
  } finally { endScreen(); }
}
