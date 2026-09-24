/**
 * ORC settings copy.
 *
 * One namespace (`settings.orc`) owns every string the ORC page renders, in
 * English and Chinese. The English dictionary is the key authority: its keys
 * are the `OrcLocaleKey` union merged into the slots package's
 * `LocaleNamespaceMap`, so the page's `t` seat is typed against exactly these
 * keys and a missing Chinese key is a compile error.
 *
 * Two strings are contract text, not decoration:
 *
 * - `probeWarning` is the exact provider-quota/cost warning the design
 *   requires before a connection test sends its harmless request.
 * - `cliRequired` renders the exact minimum-version refusal, for example
 *   `Codex CLI 0.156.1 required`.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by the ORC client plugin. */
export const ORC_LOCALE_NS = 'settings.orc'

/** English dictionary; its keys are the namespace's key union. */
export const en = {
  title: 'ORC workflow',
  loading: 'Loading ORC settings…',
  sessionBehavior: 'Session behavior',
  sessionAdaptive: 'Adaptive',
  sessionAlways: 'Always run ORC',
  codeRoute: 'Code route',
  codeRouteNone: 'None',
  codeRouteHint: 'Applies to an explicit code dispatch only. The run’s Lead and Peers inherit the route you selected in the chat.',
  analysisRouting: 'Analysis routing',
  analysisManual: 'Manual',
  analysisAuto: 'Auto',
  specRoute: 'Spec route',
  planRoute: 'Plan route',
  reviewRoute: 'Review route',
  auditRoute: 'Audit route',
  unassigned: 'Unassigned',
  routeEntry: 'Add a route',
  routeEntryHint: 'Type a route the live catalog cannot discover yet, then allowlist it. This works before any backend is discoverable.',
  routeEntryLabel: 'Route',
  routeEntryPlaceholder: 'provider:<provider>:<model>:<effort>',
  routeEntryAdd: 'Allowlist route',
  routeEntryEmpty: 'Type a route to allowlist',
  routeEntryInvalid: 'A route reads provider:<provider>:<model>:<effort> or codex|claude:<model>:<effort>',
  routeEntryPresent: 'That route is already on the allowlist',
  routeEntryAdded: 'Allowlisted {route}',
  writeFailed: 'The host refused the change: {message}',
  allowedBackends: 'Allowed backends',
  allowedBackendsEmpty: 'No backend is discoverable yet; type a route above to allowlist one.',
  cliHealth: 'CLI health and authentication',
  cliPath: '{product} path',
  cliNotFound: 'Not found on PATH; set an explicit path below',
  cliVersion: 'Version {version}',
  cliVersionUnknown: 'Version unknown',
  cliRequired: '{product} {version} required',
  cliAuthOk: 'Authenticated',
  cliAuthFailed: 'Not authenticated',
  cliAuthUnknown: 'Authentication unknown',
  policy: 'Automatic routing policy',
  maxCost: 'Maximum cost (USD)',
  maxCostHint: 'Optional ceiling; Auto never lowers a quality floor to meet it.',
  catalogAge: 'Catalog maximum age (days)',
  catalogObserved: 'Catalog observed {age} ago',
  catalogNotLoaded: 'Catalog not loaded',
  connection: 'Connection test',
  probeCodeRoute: 'Test code route connection',
  probeWarning: 'This test may use provider quota or incur cost',
  connected: 'Connected',
  notTested: 'Not tested',
  stale: 'Configuration changed; retest required',
  testFailed: 'Test failed',
  route: 'Route {route}',
  revision: 'Revision {revision}',
  version: 'Version {version}',
  testedAt: 'Tested {time}',
  save: 'Save',
  saved: 'Saved',
  saveHint: 'Saves the executable paths, the cost ceiling, and the catalog age.',
  invalidCost: 'Maximum cost must be a non-negative number',
  invalidAge: 'Catalog maximum age must be a positive number',
  unavailable: 'The ORC remote face is unavailable in this profile',
  settingsUnavailable: 'ORC settings are unavailable in this profile',
  noCodeRoute: 'Select a code route before testing',
  ageNow: 'just now',
  ageMinutes: '{n} minutes',
  ageHours: '{n} hours',
  ageDays: '{n} days',
} as const

/** Every dictionary key the `settings.orc` namespace owns. */
export type OrcLocaleKey = keyof typeof en

/** Chinese dictionary; the `Record` type enforces key parity with English. */
export const zh: Record<OrcLocaleKey, string> = {
  title: 'ORC 工作流',
  loading: '正在加载 ORC 设置…',
  sessionBehavior: '会话行为',
  sessionAdaptive: '自适应',
  sessionAlways: '始终运行 ORC',
  codeRoute: '代码路由',
  codeRouteNone: '无',
  codeRouteHint: '仅适用于显式的代码调度。运行中的 Lead 与 Peer 继承你在对话中选择的路由。',
  analysisRouting: '分析路由',
  analysisManual: '手动',
  analysisAuto: '自动',
  specRoute: '规格路由',
  planRoute: '计划路由',
  reviewRoute: '评审路由',
  auditRoute: '审计路由',
  unassigned: '未分配',
  routeEntry: '添加路由',
  routeEntryHint: '输入实时目录尚无法发现的路由，然后将其加入允许列表。在任何后端可被发现之前即可使用。',
  routeEntryLabel: '路由',
  routeEntryPlaceholder: 'provider:<提供商>:<模型>:<推理强度>',
  routeEntryAdd: '加入允许列表',
  routeEntryEmpty: '请输入要加入允许列表的路由',
  routeEntryInvalid: '路由格式为 provider:<提供商>:<模型>:<推理强度> 或 codex|claude:<模型>:<推理强度>',
  routeEntryPresent: '该路由已在允许列表中',
  routeEntryAdded: '已将 {route} 加入允许列表',
  writeFailed: '主机拒绝了该更改：{message}',
  allowedBackends: '允许的后端',
  allowedBackendsEmpty: '暂无可发现的后端；请在上方输入路由以加入允许列表。',
  cliHealth: 'CLI 健康状况与身份验证',
  cliPath: '{product} 路径',
  cliNotFound: '未在 PATH 中找到；请在下方填写显式路径',
  cliVersion: '版本 {version}',
  cliVersionUnknown: '版本未知',
  cliRequired: '需要 {product} {version}',
  cliAuthOk: '已通过身份验证',
  cliAuthFailed: '未通过身份验证',
  cliAuthUnknown: '身份验证状态未知',
  policy: '自动路由策略',
  maxCost: '最高成本（美元）',
  maxCostHint: '可选上限；Auto 不会为满足上限而降低质量下限。',
  catalogAge: '目录最长有效期（天）',
  catalogObserved: '目录观测于 {age} 前',
  catalogNotLoaded: '目录未加载',
  connection: '连接测试',
  probeCodeRoute: '测试代码路由连接',
  probeWarning: '此测试可能消耗提供商配额或产生费用',
  connected: '已连接',
  notTested: '未测试',
  stale: '配置已更改；需要重新测试',
  testFailed: '测试失败',
  route: '路由 {route}',
  revision: '修订 {revision}',
  version: '版本 {version}',
  testedAt: '测试于 {time}',
  save: '保存',
  saved: '已保存',
  saveHint: '保存可执行文件路径、成本上限与目录有效期。',
  invalidCost: '最高成本必须是非负数',
  invalidAge: '目录最长有效期必须为正数',
  unavailable: '此配置中 ORC 远程接口不可用',
  settingsUnavailable: '此配置中 ORC 设置不可用',
  noCodeRoute: '请先选择代码路由再测试',
  ageNow: '刚刚',
  ageMinutes: '{n} 分钟',
  ageHours: '{n} 小时',
  ageDays: '{n} 天',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** ORC settings page copy. */
    'settings.orc': OrcLocaleKey
  }
}

/** The dictionary for one active locale id; anything but `zh` reads English. */
export function dictionary(locale: string): Record<OrcLocaleKey, string> {
  return locale === 'zh' ? zh : en
}

/**
 * Resolve one dictionary key, substituting `{name}` template parameters.
 *
 * An unknown key resolves to the key itself, so a missing string is visible
 * rather than silent.
 */
export function translate(
  dict: Record<string, string>,
  key: string,
  params?: Record<string, unknown>,
): string {
  const template = dict[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}
