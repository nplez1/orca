import { describe, expect, it } from 'vitest'
import { moneyToNumber } from '../../../shared/money-amount'
import {
  decodeFireworksAccountNames,
  decodeFireworksBalance,
  encodeGetBalanceRequest,
  encodeVarint
} from './fireworks-balance-protobuf'

/** Encodes a field-1 length-delimited message the way the gateway frames `money`. */
function wrapFieldOne(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x0a]), encodeVarint(payload.length), payload])
}

function money({ currency, units, nanos }: { currency?: string; units: number; nanos: number }) {
  const parts: Buffer[] = []
  if (currency !== undefined) {
    const code = Buffer.from(currency, 'utf8')
    parts.push(Buffer.from([0x0a]), encodeVarint(code.length), code)
  }
  parts.push(Buffer.from([0x10]), encodeVarint(units))
  if (nanos !== 0) {
    parts.push(Buffer.from([0x18]), encodeVarint(nanos))
  }
  return Buffer.concat(parts)
}

describe('encodeGetBalanceRequest', () => {
  it('frames the account name as field 1', () => {
    const encoded = encodeGetBalanceRequest('accounts/acme')
    // 0x0a = field 1, length-delimited; 0x0d = 13-byte payload.
    expect(encoded.toString('hex')).toBe(`0a0d${Buffer.from('accounts/acme').toString('hex')}`)
  })

  it('length-prefixes a name longer than 127 bytes with a two-byte varint', () => {
    const encoded = encodeGetBalanceRequest(`accounts/${'x'.repeat(200)}`)
    expect(encoded[0]).toBe(0x0a)
    // 209 = 0xd1, which needs a continuation byte: 0xd1 0x01.
    expect(encoded.subarray(1, 3).toString('hex')).toBe('d101')
  })
})

describe('decodeFireworksBalance', () => {
  it('decodes the google.type.Money the gateway returns', () => {
    // The shape a live gateway response was observed to carry.
    const decoded = decodeFireworksBalance(
      wrapFieldOne(money({ currency: 'USD', units: 9, nanos: 694_293_840 }))
    )
    expect(decoded).toEqual({ currencyCode: 'USD', units: '9', nanos: 694_293_840 })
    expect(moneyToNumber(decoded!)).toBeCloseTo(9.69429384, 8)
  })

  it('treats an omitted nanos as zero', () => {
    const decoded = decodeFireworksBalance(
      wrapFieldOne(money({ currency: 'USD', units: 20, nanos: 0 }))
    )
    expect(decoded).toEqual({ currencyCode: 'USD', units: '20', nanos: 0 })
  })

  it('keeps a currency other than USD verbatim', () => {
    const decoded = decodeFireworksBalance(
      wrapFieldOne(money({ currency: 'CNY', units: 70, nanos: 0 }))
    )
    expect(decoded?.currencyCode).toBe('CNY')
  })

  it('returns null when the response carries no money field', () => {
    expect(decodeFireworksBalance(Buffer.alloc(0))).toBeNull()
    // A money message with no currency code is not a usable balance.
    expect(decodeFireworksBalance(wrapFieldOne(money({ units: 5, nanos: 0 })))).toBeNull()
  })

  it('throws rather than misreading a truncated varint', () => {
    // Continuation bit set with no following byte.
    expect(() => decodeFireworksBalance(Buffer.from([0x0a, 0x80]))).toThrow(/truncated/)
  })

  it('skips fields it does not know, so added gateway fields do not break the read', () => {
    // Field 4 (unknown), varint, then the real money field.
    const withUnknown = Buffer.concat([
      Buffer.from([0x20, 0x2a]),
      wrapFieldOne(money({ currency: 'USD', units: 1, nanos: 0 }))
    ])
    expect(decodeFireworksBalance(withUnknown)?.units).toBe('1')
  })
})

describe('decodeFireworksAccountNames', () => {
  it('reads every repeated account name in order', () => {
    const account = (name: string): Buffer => {
      const bytes = Buffer.from(name, 'utf8')
      return wrapFieldOne(Buffer.concat([Buffer.from([0x0a]), encodeVarint(bytes.length), bytes]))
    }
    const response = Buffer.concat([account('accounts/first'), account('accounts/second')])
    expect(decodeFireworksAccountNames(response)).toEqual(['accounts/first', 'accounts/second'])
  })

  it('returns nothing for an empty response', () => {
    expect(decodeFireworksAccountNames(Buffer.alloc(0))).toEqual([])
  })
})

describe('encodeVarint', () => {
  it.each([
    [0, '00'],
    [1, '01'],
    [127, '7f'],
    [128, '8001'],
    [300, 'ac02']
  ])('encodes %i', (value, hex) => {
    expect(encodeVarint(value).toString('hex')).toBe(hex)
  })
})
