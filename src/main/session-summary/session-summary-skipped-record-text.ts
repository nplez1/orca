import {
  MAX_SESSION_TRANSCRIPT_RECORD_BYTES,
  type SkippedTranscriptRecord
} from '../ai-vault/transcripts/session-transcript-record-budget'

const DESCRIBED_SKIPPED_RECORDS = 3

// Why local: upstream dropped this from the record budget once Session History stopped warning on it;
// the fold still names each skipped record as a gap in the summary.
export function describeSkippedTranscriptRecords(
  records: readonly SkippedTranscriptRecord[]
): string | null {
  if (records.length === 0) {
    return null
  }
  const sizes = records
    .slice(0, DESCRIBED_SKIPPED_RECORDS)
    .map((record) => `${formatMebibytes(record.approximateBytes)} at byte ${record.byteOffset}`)
  if (records.length > DESCRIBED_SKIPPED_RECORDS) {
    sizes.push(`${records.length - DESCRIBED_SKIPPED_RECORDS} more`)
  }
  const plural = records.length === 1 ? 'record' : 'records'
  return `Skipped ${records.length} oversized transcript ${plural} over the ${formatMebibytes(
    MAX_SESSION_TRANSCRIPT_RECORD_BYTES
  )} limit (${sizes.join(', ')}). The rest of the session was read.`
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
