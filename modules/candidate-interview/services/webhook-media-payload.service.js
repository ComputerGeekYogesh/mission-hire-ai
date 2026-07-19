import { flagRepository } from '../repositories/flag.repository.js';
import { snapshotRepository } from '../repositories/snapshot.repository.js';
import { recordingRepository } from '../repositories/recording.repository.js';
import { recordingMetadataRepository } from '../repositories/recording-metadata.repository.js';
import {
  getBackendBaseUrl,
  publicSnapshotUrl,
  publicRecordingUrl,
  mediaFileExists,
} from './webhook-media-url.service.js';

/** Map internal flag_type → webhook summary bucket. */
const FLAG_BUCKET = {
  tab_switch: 'tab_switches',
  window_blur: 'tab_switches',
  no_face: 'face_not_detected',
  face_absent_duration: 'face_not_detected',
  excessive_head_movement: 'suspicious_activity',
  face_looking_away: 'face_rotation',
  face_rotation: 'face_rotation',
  suspicious_pattern: 'suspicious_activity',
  headphones_removed: 'suspicious_activity',
  mic_muted: 'suspicious_activity',
  camera_disabled: 'suspicious_activity',
  question_repeated: 'question_repeated',
  identity_mismatch: 'suspicious_activity',
};

/** Map internal flag_type → external `type` in flag_details. */
const FLAG_EXTERNAL_TYPE = {
  tab_switch: 'tab_switch',
  window_blur: 'tab_switch',
  no_face: 'face_not_detected',
  face_absent_duration: 'face_not_detected',
  excessive_head_movement: 'suspicious_activity',
  face_looking_away: 'face_rotation',
  face_rotation: 'face_rotation',
  suspicious_pattern: 'suspicious_activity',
  headphones_removed: 'suspicious_activity',
  mic_muted: 'suspicious_activity',
  camera_disabled: 'suspicious_activity',
  question_repeated: 'question_repeated',
  identity_mismatch: 'suspicious_activity',
};

function toIsoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function externalFlagType(flagType) {
  return FLAG_EXTERNAL_TYPE[flagType] || 'suspicious_activity';
}

function emptyFlagSummary() {
  return {
    total_flags: 0,
    tab_switches: 0,
    face_not_detected: 0,
    low_light_detected: 0,
    suspicious_activity: 0,
    flag_details: [],
  };
}

function buildFlagSummary(flags) {
  const summary = emptyFlagSummary();
  summary.flag_details = flags.map((f) => {
    const type = externalFlagType(f.flag_type);
    const bucket = FLAG_BUCKET[f.flag_type] || 'suspicious_activity';
    summary[bucket] = (summary[bucket] || 0) + 1;
    summary.total_flags += 1;

    return {
      type,
      timestamp: toIsoDate(f.created_at),
      description: f.message || `${f.flag_type} flagged during interview`,
      severity: f.severity,
      flag_type: f.flag_type,
    };
  });
  return summary;
}

/** Nearest flag within 2 minutes before snapshot capture (for flag_type metadata). */
function nearestFlagTypeForSnapshot(capturedAt, flags) {
  const snapMs = new Date(capturedAt).getTime();
  if (Number.isNaN(snapMs)) return null;

  let best = null;
  let bestDelta = Infinity;
  for (const f of flags) {
    const flagMs = new Date(f.created_at).getTime();
    if (Number.isNaN(flagMs) || flagMs > snapMs) continue;
    const delta = snapMs - flagMs;
    if (delta <= 120_000 && delta < bestDelta) {
      bestDelta = delta;
      best = externalFlagType(f.flag_type);
    }
  }
  return best;
}

function buildSnapshotsPayload(snapshots, flags) {
  const ordered = [...snapshots].sort(
    (a, b) => new Date(a.captured_at) - new Date(b.captured_at)
  );

  const images = ordered.map((s) => {
    return {
      snapshot_id: `snap_${String(s.id).padStart(3, '0')}`,
      captured_at: toIsoDate(s.captured_at),
      flag_type: nearestFlagTypeForSnapshot(s.captured_at, flags),
      url: publicSnapshotUrl(s.storage_key),
    };
  });

  return {
    total_count: images.length,
    images: images.filter((img) => img.url),
  };
}

async function buildRecordingPayload(merged, metadata, thumbnailUrl) {
  const recordingStatus = metadata?.recording_status || (metadata?.merge_status === 'partial' ? 'partial' : 'full');
  const availableChunks = metadata?.chunks_received ?? null;
  const totalChunksExpected = metadata?.total_chunks_expected ?? null;

  const fileSizeBytes =
    metadata?.merged_file_size_bytes ?? merged?.file_size_bytes ?? null;
  const fileSizeMb =
    fileSizeBytes != null
      ? Math.round((Number(fileSizeBytes) / 1024 / 1024) * 10) / 10
      : null;

  const mergedFileReady =
    metadata?.merged_file_path && mediaFileExists({ storage_key: metadata.merged_file_path });
  const mergedRowReady = merged && mediaFileExists(merged);

  if (!merged && !metadata?.signed_url && !mergedFileReady) {
    return {
      status: availableChunks > 0 ? 'processing' : 'unavailable',
      duration_seconds: merged?.duration_seconds ?? null,
      file_size_mb: fileSizeMb,
      url: null,
      thumbnail_url: thumbnailUrl || null,
      storage_backend: 'disk',
      recording_status: recordingStatus,
      available_chunks: availableChunks,
      total_chunks_expected: totalChunksExpected,
      merge_status: metadata?.merge_status ?? null,
    };
  }

  const url =
    metadata?.signed_url ||
    (merged ? publicRecordingUrl(merged) : null) ||
    (mergedFileReady && metadata?.session_id
      ? publicRecordingUrl({
          storage_key: metadata.merged_file_path,
          session_id: metadata.session_id,
          file_size_bytes: fileSizeBytes,
        })
      : null);

  const exists = mergedRowReady || mergedFileReady;

  const playbackStatus =
    exists && url
      ? recordingStatus === 'partial'
        ? 'partial'
        : 'available'
      : availableChunks > 0
        ? 'processing'
        : 'unavailable';

  if (url) {
    console.log(
      '[webhook-media] recording url',
      JSON.stringify({
        recording_id: merged?.id ?? null,
        session_id: merged?.session_id ?? metadata?.session_id ?? null,
        storage_backend: 'disk',
        recording_status: recordingStatus,
        url: url.slice(0, 120) + (url.length > 120 ? '…' : ''),
      })
    );
  }

  return {
    status: playbackStatus,
    duration_seconds: merged?.duration_seconds ?? null,
    file_size_mb: fileSizeMb,
    url: exists && url ? url : null,
    thumbnail_url: thumbnailUrl || null,
    storage_backend: 'disk',
    recording_status: recordingStatus,
    available_chunks: availableChunks,
    total_chunks_expected: totalChunksExpected,
    merge_status: metadata?.merge_status ?? null,
  };
}

/**
 * Flags, snapshots, and recording sections for completion webhook.
 * Telemetry is intentionally excluded — it bloated payloads and caused HTTP 413.
 */
export async function buildInterviewMediaWebhookSections(session) {
  const sessionId = session.id;
  const [flags, snapshots, merged, metadata] = await Promise.all([
    flagRepository.list({ session_id: sessionId, limit: 500 }),
    snapshotRepository.listBySession(sessionId, 500),
    recordingRepository.findMergedBySession(sessionId),
    recordingMetadataRepository.findBySessionId(sessionId),
  ]);

  console.log('[webhook-media] merged recording selection', {
    session_id: sessionId,
    merged_exists: Boolean(merged),
    merged_id: merged?.id ?? null,
    metadata_merge_status: metadata?.merge_status ?? null,
    metadata_recording_status: metadata?.recording_status ?? null,
    merged_file_size_bytes: metadata?.merged_file_size_bytes ?? merged?.file_size_bytes ?? null,
  });

  const flagsPayload = buildFlagSummary(flags);
  const snapshotsPayload = buildSnapshotsPayload(snapshots, flags);

  const firstSnap = snapshotsPayload.images[0];
  const thumbnailUrl = firstSnap?.url || null;

  const recordingPayload = await buildRecordingPayload(merged, metadata, thumbnailUrl);

  if (!getBackendBaseUrl()) {
    console.warn(
      `[api-webhook] HOST_URL is not set — media URLs for session ${sessionId} will be null`
    );
  }

  return {
    flags: flagsPayload,
    snapshots: snapshotsPayload,
    recording: recordingPayload,
  };
}
