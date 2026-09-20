import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { joinLike } from './platform.ts';

/**
 * WSL 里「Windows 那一侧」在哪 —— 让 afc 在 bash 里也能用。
 *
 * WSL2 默认是 NAT 网络：`127.0.0.1` 是 WSL 自己的回环，连不到 Windows 上 Clash 的控制端口；
 * 命名管道更是完全用不了。但 WSL 有两样东西是通的：
 *   1. 文件系统：Windows 盘挂载在 `/mnt/c`，于是**能读到 Windows 上客户端的运行时配置**
 *      （外部控制地址、密钥、甚至节点定义都在里面）；
 *   2. 宿主机地址：NAT 模式下宿主机是默认网关（`/proc/net/route`）或 DNS（`/etc/resolv.conf`）；
 *      镜像网络模式下 `127.0.0.1` 直接就是宿主机。
 * 因此 afc 在 WSL 里的做法是：从 Windows 那份配置里读出端口与密钥，再把主机名换成
 * 「127.0.0.1（镜像模式）+ 宿主机地址（NAT 且客户端允许局域网）」，两边都试一次。
 */

export interface WslProfile {
  /** Windows 盘挂载点（如 /mnt/c）。 */
  mountRoot: string;
  username: string;
}

export interface WslBridge {
  /** Windows 用户目录（POSIX 形式，如 /mnt/c/Users/x）。 */
  profiles: WslProfile[];
  /** 候选的宿主机地址，按「最可能先通」排序。 */
  hostAddresses: string[];
}

/** 读一个文件，读不到就返回空串。 */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** `/proc/net/route` 里的网关是 little-endian 十六进制，转成点分十进制。 */
export function hexRouteAddress(hex: string): string | undefined {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return undefined;
  const bytes = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const ip = [bytes[3], bytes[2], bytes[1], bytes[0]].join('.');
  return ip === '0.0.0.0' ? undefined : ip;
}

/** 解析默认网关（`/proc/net/route`：目标为 00000000 的那条）。 */
export function parseDefaultGateway(routeTable: string): string | undefined {
  for (const line of routeTable.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    if (cols[1] !== '00000000') continue;
    const ip = hexRouteAddress(cols[2] ?? '');
    if (ip) return ip;
  }
  return undefined;
}

/** 解析 `/etc/resolv.conf` 里的 nameserver（NAT 模式下就是宿主机）。 */
export function parseNameServers(resolvConf: string): string[] {
  const out: string[] = [];
  for (const line of resolvConf.split('\n')) {
    const match = /^\s*nameserver\s+(\S+)\s*$/.exec(line);
    const ip = match?.[1];
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !out.includes(ip)) out.push(ip);
  }
  return out;
}

/** 组装候选宿主机地址：先 127.0.0.1（镜像网络模式），再网关，再 DNS。 */
export function wslHostAddresses(resolvConf: string, routeTable: string): string[] {
  const out = ['127.0.0.1'];
  for (const ip of [parseDefaultGateway(routeTable), ...parseNameServers(resolvConf)]) {
    if (ip && !out.includes(ip)) out.push(ip);
  }
  return out;
}

/**
 * 给定 Windows 盘挂载点与用户名，列出该用户下的客户端运行时配置路径。
 *
 * 这些路径与 Windows 上我们找的是同一批（Verge 的 clash-verge.yaml / config.yaml、
 * Clash Party 的 config.yaml / work/config.yaml），只是换成从 /mnt/c 看过去。
 */
export function windowsClientConfigPaths(mountRoot: string, username: string): string[] {
  const profiles = ['AppData/Roaming', 'AppData/Local'].map((sub) => joinLike(mountRoot, 'Users', username, sub));
  const paths: string[] = [];
  for (const profile of profiles) {
    for (const id of ['io.github.clash-verge-rev.clash-verge-rev', 'io.github.clash-verge-rev.clash-verge', 'clash-verge']) {
      paths.push(joinLike(profile, id, 'clash-verge.yaml'));
      paths.push(joinLike(profile, id, 'config.yaml'));
    }
    paths.push(joinLike(profile, 'mihomo-party', 'config.yaml'));
    paths.push(joinLike(profile, 'mihomo-party', 'work', 'config.yaml'));
  }
  return paths;
}

/** 找出可能的 Windows 挂载点（默认 /mnt/c，也可能被 wsl.conf 改成别的）。 */
export function findWindowsMountRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = ['/mnt/c', '/c'];
  const fromEnv = env['WSL_WINDOWS_MOUNT'];
  if (fromEnv) candidates.unshift(fromEnv);
  return candidates.filter((root) => existsSync(joinLike(root, 'Users')));
}

/**
 * 找 Windows 用户名：优先问 interop 的 cmd（最准），失败就扫 /mnt/c/Users。
 *
 * 用 Windows 侧的真实用户名而不是 WSL 用户名：两者经常不一样（WSL 里是 john，Windows 上是 张三）。
 */
export function findWindowsUsernames(mountRoot: string): string[] {
  const fromInterop = windowsUserProfileFromInterop();
  if (fromInterop && existsSync(fromInterop)) {
    const name = fromInterop.slice(fromInterop.lastIndexOf('/') + 1);
    if (name) return [name];
  }
  const usersDir = joinLike(mountRoot, 'Users');
  let entries: string[];
  try {
    entries = readdirSync(usersDir);
  } catch {
    return [];
  }
  const skip = new Set(['public', 'default', 'default user', 'all users', 'defaultapppool', 'wdagutilityaccount']);
  return entries
    .filter((name) => !skip.has(name.toLowerCase()))
    .filter((name) => existsSync(joinLike(usersDir, name, 'AppData')))
    .slice(0, 5);
}

/** `cmd.exe /c echo %USERPROFILE%` → POSIX 路径。interop 不可用时返回 undefined。 */
export function windowsUserProfileFromInterop(): string | undefined {
  try {
    const raw = execFileSync('cmd.exe', ['/c', 'echo', '%USERPROFILE%'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return windowsPathToPosix(raw);
  } catch {
    return undefined;
  }
}

/** `C:\Users\x` → `/mnt/c/Users/x`。 */
export function windowsPathToPosix(winPath: string, mountRoot = '/mnt'): string | undefined {
  const match = /^([A-Za-z]):\\(.*)$/.exec(winPath.trim());
  if (!match) return undefined;
  const drive = match[1]!.toLowerCase();
  const rest = match[2]!.split('\\').filter((p) => p !== '');
  return joinLike(joinLike(mountRoot, drive), ...rest);
}

let bridgeCache: WslBridge | undefined;

/** 清掉缓存（测试用）。 */
export function clearWslCache(): void {
  bridgeCache = undefined;
}

/** WSL 侧的桥接信息：Windows 用户目录与候选宿主机地址。带缓存，最多算一次。 */
export function wslBridge(): WslBridge {
  if (bridgeCache) return bridgeCache;
  const profiles: WslProfile[] = [];
  for (const mountRoot of findWindowsMountRoots()) {
    for (const username of findWindowsUsernames(mountRoot)) {
      profiles.push({ mountRoot, username });
    }
  }
  bridgeCache = {
    profiles,
    hostAddresses: wslHostAddresses(readText('/etc/resolv.conf'), readText('/proc/net/route')),
  };
  return bridgeCache;
}

/** 给定桥接信息，列出 Windows 侧客户的运行时配置路径（已按存在性过滤）。 */
export function wslClientConfigPaths(bridge: WslBridge = wslBridge()): string[] {
  const paths: string[] = [];
  for (const profile of bridge.profiles) {
    for (const path of windowsClientConfigPaths(profile.mountRoot, profile.username)) {
      if (existsSync(path) && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}
