/** 退出码约定：便于脚本与定时任务区分「成功」「无可用节点」「环境故障」「用法错误」。 */
export const EXIT_OK = 0;
/** 体检/修复未能找到任何可用节点（节点侧问题）。 */
export const EXIT_NO_USABLE_NODE = 2;
/** 环境问题：控制端点不可达、内核缺失、配置读取失败等（非节点侧问题）。 */
export const EXIT_ENVIRONMENT = 3;
/** 用法错误：未知命令、参数缺失或非法。 */
export const EXIT_USAGE = 64;
