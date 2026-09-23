/**
 * Deterministic direct-versus-ORC activation guard.
 *
 * The Supervisor tool calls {@link classifyRequest} before implementation,
 * alongside a model-visible policy. This function is intentionally narrow: it
 * is pure and deterministic (no clock, randomness, or I/O) and applies one
 * ordered policy rather than claiming to infer semantics from free text.
 *
 * The policy is fail-closed. High-impact paths and discovered risk always
 * start ORC even when the diff is small; explicit planning/review, an
 * architectural change, and any scope other than exactly one planned file
 * also start ORC. Only one-file, low-risk work stays direct.
 */

/** The observed request facts the Supervisor classifies. */
export interface RiskInput {
  /** The user's request text. */
  text: string
  /** Paths the request already touches; the classifier only reads them. */
  touchedPaths: readonly string[]
  /** Planned file count; any value other than exactly 1 is treated as ORC. */
  plannedFiles: number
  hasArchitectureChange: boolean
  explicitPlanOrReview: boolean
  /** Set when a direct task reveals substantial risk before implementation. */
  discoveredRisk?: boolean
}

/** Whether the request runs directly or starts an ORC workflow. */
export type RiskPath = 'direct' | 'orc'

/** `high` marks money, balances, payments, auth, or security-sensitive work. */
export type RiskLevel = 'low' | 'high'

/** The classification result and its stable reason codes. */
export interface RiskDecision {
  path: RiskPath
  risk: RiskLevel
  reasons: string[]
}

const highImpact = /\b(balance(?:s)?|payment(?:s)?|transfer(?:s)?|money|withdrawal(?:s)?|wallet|ledger|billing|auth(?:entication|orization)?|permission(?:s)?|password|security)\b/i

/**
 * Classify a request as `direct` or `orc` using the ordered policy.
 *
 * Reason codes are a stable contract: `high-impact`, `explicit-review`,
 * `substantial`, `scope-escalation`, and `isolated-low-risk`.
 */
export function classifyRequest(x: RiskInput): RiskDecision {
  if (x.discoveredRisk || highImpact.test(x.text) || x.touchedPaths.some(p => highImpact.test(p)))
    return { path: 'orc', risk: 'high', reasons: ['high-impact'] }
  if (x.explicitPlanOrReview)
    return { path: 'orc', risk: 'low', reasons: ['explicit-review'] }
  if (x.hasArchitectureChange)
    return { path: 'orc', risk: 'low', reasons: ['substantial'] }
  if (x.plannedFiles !== 1)
    return { path: 'orc', risk: 'low', reasons: ['scope-escalation'] }
  return { path: 'direct', risk: 'low', reasons: ['isolated-low-risk'] }
}
