import type { MoneyAmount } from '../../../shared/money-amount'
import { moneyFromUnitsAndNanos } from '../../../shared/money-amount'

/**
 * Hand-rolled protobuf for the three messages `gateway.Gateway` needs, so Orca
 * does not ship `@grpc/grpc-js` + `@grpc/proto-loader` for one readout.
 *
 * Recovered shapes (see fireworks-balance-client.ts for provenance):
 *   GetBalanceRequest { string name = 1; }                      // "accounts/<id>"
 *   Balance           { Money money = 1; }
 *   Money             { string currency_code = 1; int64 units = 2; int32 nanos = 3; }
 */
const WIRE_LENGTH_DELIMITED = 2
const WIRE_VARINT = 0
/** Protobuf field tags are `(field << 3) | wireType`. */
const FIELD_SHIFT = 3n
/** Field 1's tag byte: (1 << 3) | 2. */
const FIELD_ONE_LENGTH_DELIMITED_TAG = 0x0a

export function encodeVarint(value: bigint | number): Buffer {
  const bytes: number[] = []
  let remaining = BigInt(value)
  while (remaining > 0x7fn) {
    bytes.push(Number(remaining & 0x7fn) | 0x80)
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
  return Buffer.from(bytes)
}

function readVarint(buf: Buffer, at: number): { value: bigint; next: number } {
  let shift = 0n
  let value = 0n
  let index = at
  while (index < buf.length) {
    const byte = buf[index]
    if (byte === undefined) {
      break
    }
    index += 1
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return { value, next: index }
    }
    shift += 7n
  }
  throw new Error('truncated protobuf varint')
}

/** Field number to every occurrence, so repeated fields survive decoding. */
function readFields(buf: Buffer): Map<number, (Buffer | bigint)[]> {
  const fields = new Map<number, (Buffer | bigint)[]>()
  let index = 0
  while (index < buf.length) {
    const tag = readVarint(buf, index)
    index = tag.next
    const field = Number(tag.value >> FIELD_SHIFT)
    const wire = Number(tag.value & 0x7n)
    let value: Buffer | bigint
    if (wire === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(buf, index)
      index = length.next
      value = buf.subarray(index, index + Number(length.value))
      index += Number(length.value)
    } else if (wire === WIRE_VARINT) {
      const decoded = readVarint(buf, index)
      value = decoded.value
      index = decoded.next
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
    const existing = fields.get(field)
    if (existing) {
      existing.push(value)
    } else {
      fields.set(field, [value])
    }
  }
  return fields
}

export function encodeGetBalanceRequest(accountName: string): Buffer {
  const name = Buffer.from(accountName, 'utf8')
  // Field 1, length-delimited.
  return Buffer.concat([
    Buffer.from([FIELD_ONE_LENGTH_DELIMITED_TAG]),
    encodeVarint(name.length),
    name
  ])
}

/** Null when the response carried no `money` field at all. */
export function decodeFireworksBalance(message: Buffer): MoneyAmount | null {
  const moneyBytes = readFields(message).get(1)?.[0]
  if (!(moneyBytes instanceof Buffer)) {
    return null
  }
  const money = readFields(moneyBytes)
  const currency = money.get(1)?.[0]
  if (!(currency instanceof Buffer)) {
    return null
  }
  const units = money.get(2)?.[0] ?? 0n
  const nanos = money.get(3)?.[0] ?? 0n
  return moneyFromUnitsAndNanos(currency.toString('utf8'), String(units), Number(nanos))
}

/** Account names (`accounts/<id>`) in the order the gateway listed them. */
export function decodeFireworksAccountNames(message: Buffer): string[] {
  const accounts = readFields(message).get(1) ?? []
  const names: string[] = []
  for (const account of accounts) {
    if (!(account instanceof Buffer)) {
      continue
    }
    const name = readFields(account).get(1)?.[0]
    if (name instanceof Buffer) {
      names.push(name.toString('utf8'))
    }
  }
  return names
}
