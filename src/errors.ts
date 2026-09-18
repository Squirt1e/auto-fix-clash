/**
 * 用户用法/配置选择类错误。
 *
 * 与「环境故障」区分开：组名写错、配置指向不存在的组、目标组类型不支持切换，
 * 这些都应该以「用法错误」退出码返回，而不是让脚本误判成控制端点或内核出了问题。
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
