import type { MoneyAmount } from './money-amount'

/**
 * A money-denominated usage readout for providers that expose no percentage
 * quota. DeepSeek publishes only an account balance and Fireworks only rated
 * spend, so neither can be expressed as a `RateLimitWindow.usedPercent`.
 */
export type ProviderCreditsKind = 'balance' | 'spend'

/** Window a `spend` headline covers. Renderer-localized, never a raw label. */
export type ProviderCreditsPeriod = 'current-month' | 'last-30-days'

/** Breakdown bucket. A key rather than a label so the renderer owns wording. */
export type ProviderCreditsItemKey = 'granted' | 'topped-up'

export type ProviderCreditsItem = {
  key: ProviderCreditsItemKey
  amount: MoneyAmount
}

export type ProviderCredits = {
  kind: ProviderCreditsKind
  /** Headline amount: remaining balance, or spend across `period`. */
  amount: MoneyAmount
  /** Breakdown the headline is drawn from, when the provider offers one. */
  items?: ProviderCreditsItem[]
  period?: ProviderCreditsPeriod
  /**
   * False when the provider reports the balance cannot fund further calls.
   * Deliberately NOT folded into `status: 'unavailable'`: that value means
   * "not configured" and is the signal that hides a provider entirely, which
   * would hide an exhausted-but-configured account the user needs to top up.
   */
  available?: boolean
}
