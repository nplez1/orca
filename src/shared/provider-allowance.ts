/**
 * A provider-declared allowance: an amount consumed against a ceiling, in a unit the
 * provider picks.
 *
 * Why this is not `ProviderCredits`: that type is money-only and expresses a running
 * balance or spend. Enterprise and usage-billed plans instead report "consumed N of a
 * ceiling of M", where the unit is not always money — Claude's monthly spend cap is
 * dollars, while Codex's group-based spend control is denominated in its own `credit`
 * unit. A currency code cannot represent the latter.
 */
export type ProviderAllowanceUnit =
  | { kind: 'money'; currencyCode: string }
  /** Provider-defined count, carrying the provider's own unit string (e.g. `credit`). */
  | { kind: 'count'; label: string }

export type ProviderAllowance = {
  unit: ProviderAllowanceUnit
  /**
   * Display figures only. The percentage shown to the user comes from the provider's
   * own reported percent, never from dividing these, so float precision here is fine.
   */
  used: number
  limit: number
  /** Unix ms, or null when the provider reports no reset for this allowance. */
  resetsAt: number | null
}
