/**
 * 全局的「详细模式」开关（由 `--verbose` 打开）。
 *
 * 为什么要做成全局：报错文案散在 discovery / paths / probe 各处，而"要不要铺开细节"
 * 是用户这一次运行的偏好，不是每个函数各自该判断的事。
 * 规则：默认每条错误只留「发生了什么 + 一个能立刻执行的下一步」，长清单、平台差异、
 * 候选来源这些放进 --verbose。
 */
let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}
