/**
 * Strict review/audit report normalization and the blocking-finding gate.
 *
 * Reviewers and security auditors are models, so their output is untrusted.
 * {@link parseReport} is the single gate that turns that output into a typed
 * {@link Report}. It is fail-closed: anything that is not an object record
 * with an exact `clean`/`findings` status and exactly the required finding
 * fields throws a {@link ReportError} whose message is labelled `blocking`.
 * A failed, malformed, unavailable, or unrecognized report can therefore never
 * be normalized to a clean result.
 */

/** Finding severity. `critical`, `high`, and `medium` block completion. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** Lifecycle of a finding inside a run. */
export type FindingStatus = 'open' | 'fixed' | 'dismissed'

/** The stage whose report raised a finding. */
export type ReportStage = 'review' | 'audit'

/** The only accepted report statuses. */
export type ReportStatus = 'clean' | 'findings'

/** One normalized finding, opened by the report that raised it. */
export interface Finding {
  id: string
  severity: Severity
  stage: ReportStage
  file: string
  line: number
  evidence: string
  remediation: string
  status: FindingStatus
}

/** A normalized review or audit report. */
export interface Report {
  status: ReportStatus
  findings: Finding[]
  /** True when any finding has a blocking severity, regardless of status. */
  blocking: boolean
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info']

const BLOCKING_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium']

const REPORT_FIELDS: readonly string[] = ['status', 'findings']

const FINDING_FIELDS: readonly string[] = ['id', 'severity', 'file', 'line', 'evidence', 'remediation']

/** Whether a severity blocks completion until it is fixed and re-reviewed. */
export function isBlocking(severity: Severity): boolean {
  return BLOCKING_SEVERITIES.includes(severity)
}

/**
 * A rejected report.
 *
 * Every message is prefixed with `blocking` so callers and tests can treat any
 * `ReportError` as a blocking outcome without inspecting the specific reason.
 */
export class ReportError extends Error {
  constructor(message: string) {
    super(`blocking: ${message}`)
    this.name = 'ReportError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function requireText(value: unknown, subject: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ReportError(`${subject} is missing ${field}`)
  return value
}

function parseSeverity(value: unknown, id: string): Severity {
  if (typeof value !== 'string' || !SEVERITIES.includes(value as Severity))
    throw new ReportError(`finding ${id} has an invalid or missing severity ${JSON.stringify(value)}`)
  return value as Severity
}

function parseFinding(raw: unknown, index: number, stage: ReportStage): Finding {
  if (!isRecord(raw)) throw new ReportError(`finding at index ${index} is not an object record`)
  for (const key of Object.keys(raw))
    if (!FINDING_FIELDS.includes(key)) throw new ReportError(`finding at index ${index} has unknown field "${key}"`)
  const id = requireText(raw.id, `finding at index ${index}`, 'id')
  const severity = parseSeverity(raw.severity, id)
  const file = requireText(raw.file, `finding ${id}`, 'file')
  const line = raw.line
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0)
    throw new ReportError(`finding ${id} has an invalid line`)
  const evidence = requireText(raw.evidence, `finding ${id}`, 'evidence')
  const remediation = requireText(raw.remediation, `finding ${id}`, 'remediation')
  return { id, severity, stage, file, line, evidence, remediation, status: 'open' }
}

/**
 * Normalize one untrusted review or audit report.
 *
 * @param input The raw model or dispatcher output.
 * @param stage The stage that produced it; stamped onto every finding.
 * @throws {@link ReportError} for anything that is not exactly a valid report.
 */
export function parseReport(input: unknown, stage: ReportStage): Report {
  if (!isRecord(input)) throw new ReportError('report is unavailable or not an object record')
  for (const key of Object.keys(input))
    if (!REPORT_FIELDS.includes(key)) throw new ReportError(`report has unknown field "${key}"`)
  const status = input.status
  if (status !== 'clean' && status !== 'findings')
    throw new ReportError(`unrecognized report status ${JSON.stringify(status)}; expected "clean" or "findings"`)
  if (!Array.isArray(input.findings)) throw new ReportError('report findings must be an array')
  const findings: Finding[] = []
  const ids = new Set<string>()
  for (let index = 0; index < input.findings.length; index += 1) {
    const finding = parseFinding(input.findings[index], index, stage)
    if (ids.has(finding.id)) throw new ReportError(`duplicate finding id ${finding.id}`)
    ids.add(finding.id)
    findings.push(finding)
  }
  if (status === 'clean' && findings.length > 0)
    throw new ReportError(`contradictory report: status is "clean" with ${findings.length} finding(s)`)
  if (status === 'findings' && findings.length === 0)
    throw new ReportError('contradictory report: status is "findings" with no findings')
  return { status, findings, blocking: findings.some(finding => isBlocking(finding.severity)) }
}
