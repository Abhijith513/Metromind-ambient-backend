// services/sessionStore.js
import { randomUUID } from "crypto";

const sessions = new Map();

function normalizeOptionalText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function createSession(metadata = {}) {
  const id = randomUUID();

  const session = {
    id,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    segmentCount: 0,
    receivedSegmentCount: 0,
    transcribedSegmentCount: 0,
    failedSegmentCount: 0,
    lastProcessedSegmentIndex: null,
    transcriptParts: [],
    errors: [],
    finalNote: null,
    finalizedAt: null,
    patientName: normalizeOptionalText(metadata.patientName),
    chiefComplaint: normalizeOptionalText(metadata.chiefComplaint),
    preferredLanguage: normalizeOptionalText(metadata.preferredLanguage),
    segmentRegistry: {},
    segmentQueue: [],
  };

  sessions.set(id, session);
  return session;
}

function upsertSegmentRegistryEntry(session, segmentIndex, updater) {
  const key = String(segmentIndex);
  const existing = session.segmentRegistry?.[key] ?? {
    segmentIndex,
    state: "queued",
    attemptCount: 0,
    maxAttempts: 3,
    lastError: null,
    requestId: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    processingMs: null,
    transcript: null,
    localFilePath: null,
    mimeType: null,
    size: null,
  };
  const next = updater(existing);

  return {
    ...session.segmentRegistry,
    [key]: {
      ...next,
      segmentIndex,
    },
  };
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

export function getSegmentEntry(id, segmentIndex) {
  const session = getSession(id);
  if (!session) return null;
  return session.segmentRegistry?.[String(segmentIndex)] ?? null;
}

export function updateSession(id, updater) {
  const existing = sessions.get(id);
  if (!existing) return null;
  const next = updater(existing);
  next.updatedAt = new Date().toISOString();
  sessions.set(id, next);
  return next;
}

export function appendTranscriptPart(id, part) {
  return updateSession(id, (s) => ({
    ...s,
    transcriptParts: [...s.transcriptParts, part],
    segmentCount: s.segmentCount + 1,
    transcribedSegmentCount: s.transcribedSegmentCount + 1,
    lastProcessedSegmentIndex: part?.index ?? s.lastProcessedSegmentIndex,
    status: "recording",
  }));
}

export function addSessionError(id, error) {
  const isSegmentError = error?.stage === "segment_transcription";
  const hasSegmentIndex = Number.isInteger(error?.segmentIndex);

  return updateSession(id, (s) => ({
    ...s,
    errors: [...s.errors, error],
    failedSegmentCount: isSegmentError ? s.failedSegmentCount + 1 : s.failedSegmentCount,
    lastProcessedSegmentIndex: hasSegmentIndex ? error.segmentIndex : s.lastProcessedSegmentIndex,
    status: "failed",
  }));
}

export function markSegmentReceived(id) {
  return updateSession(id, (s) => ({
    ...s,
    receivedSegmentCount: s.receivedSegmentCount + 1,
  }));
}

export function markSegmentQueued(id, { segmentIndex, requestId, queuedAt, maxAttempts = 3 }) {
  return updateSession(id, (s) => ({
    ...s,
    segmentRegistry: upsertSegmentRegistryEntry(s, segmentIndex, (entry) => ({
      ...entry,
      state: "queued",
      requestId: requestId ?? entry.requestId ?? null,
      queuedAt: queuedAt ?? entry.queuedAt ?? new Date().toISOString(),
      maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : entry.maxAttempts,
      lastError: null,
    })),
  }));
}

export function enqueueSegmentForProcessing(
  id,
  { segmentIndex, requestId, queuedAt, maxAttempts = 3, localFilePath, mimeType, size }
) {
  const existing = getSession(id);
  if (!existing) {
    return { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found." };
  }

  const currentEntry = existing.segmentRegistry?.[String(segmentIndex)] ?? null;
  const currentState = currentEntry?.state ?? null;

  if (currentState === "processing") {
    return {
      ok: false,
      code: "SEGMENT_ALREADY_PROCESSING",
      message: "Segment is already being processed.",
      state: currentState,
    };
  }

  if (currentState === "transcribed") {
    return {
      ok: false,
      code: "SEGMENT_ALREADY_TRANSCRIBED",
      message: "Segment already has a transcript.",
      state: currentState,
    };
  }

  const replacedFilePath = currentState === "queued" ? currentEntry?.localFilePath ?? null : null;
  const enqueueResult = updateSession(id, (s) => {
    const key = String(segmentIndex);
    const previous = s.segmentRegistry?.[key] ?? null;

    const nextEntry = {
      ...(previous ?? {}),
      segmentIndex,
      state: "queued",
      requestId: requestId ?? previous?.requestId ?? null,
      queuedAt: queuedAt ?? new Date().toISOString(),
      maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : previous?.maxAttempts ?? 3,
      lastError: null,
      completedAt: null,
      processingMs: null,
      transcript: null,
      localFilePath: localFilePath ?? previous?.localFilePath ?? null,
      mimeType: mimeType ?? previous?.mimeType ?? null,
      size: Number.isFinite(size) ? size : previous?.size ?? null,
      attemptCount: previous?.attemptCount ?? 0,
      startedAt: null,
    };

    const queueWithoutIndex = (s.segmentQueue ?? []).filter((idx) => idx !== segmentIndex);

    return {
      ...s,
      segmentRegistry: {
        ...s.segmentRegistry,
        [key]: nextEntry,
      },
      segmentQueue: [...queueWithoutIndex, segmentIndex],
    };
  });

  if (!enqueueResult) {
    return { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found." };
  }

  return {
    ok: true,
    state: "queued",
    replacedExistingQueueItem: currentState === "queued",
    replacedFilePath: replacedFilePath && replacedFilePath !== localFilePath ? replacedFilePath : null,
  };
}

export function claimNextQueuedSegmentJob() {
  let claimedJob = null;

  for (const [sessionId, session] of sessions.entries()) {
    const queue = session.segmentQueue ?? [];
    if (!queue.length) continue;

    const segmentIndex = queue[0];
    const key = String(segmentIndex);
    const entry = session.segmentRegistry?.[key];
    if (!entry || entry.state !== "queued" || !entry.localFilePath) {
      updateSession(sessionId, (s) => ({
        ...s,
        segmentQueue: (s.segmentQueue ?? []).slice(1),
      }));
      continue;
    }

    const startedAt = new Date().toISOString();
    updateSession(sessionId, (s) => {
      const current = s.segmentRegistry?.[key];
      if (!current || current.state !== "queued") return s;

      return {
        ...s,
        segmentQueue: (s.segmentQueue ?? []).slice(1),
        segmentRegistry: {
          ...s.segmentRegistry,
          [key]: {
            ...current,
            state: "processing",
            startedAt,
            completedAt: null,
            processingMs: null,
            attemptCount: (current.attemptCount ?? 0) + 1,
            lastError: null,
          },
        },
      };
    });

    claimedJob = {
      sessionId,
      segmentIndex,
      requestId: entry.requestId ?? null,
      localFilePath: entry.localFilePath,
      mimeType: entry.mimeType,
      size: entry.size,
      startedAt,
    };
    break;
  }

  return claimedJob;
}

export function retryFailedSegmentForProcessing(id, { segmentIndex, requestId, queuedAt }) {
  const session = getSession(id);
  if (!session) {
    return { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found." };
  }

  const key = String(segmentIndex);
  const entry = session.segmentRegistry?.[key];
  if (!entry) {
    return { ok: false, code: "SEGMENT_NOT_FOUND", message: "Segment not found in registry." };
  }

  if (entry.state !== "failed") {
    return {
      ok: false,
      code: "SEGMENT_NOT_FAILED",
      message: `Segment cannot be retried from state '${entry.state}'.`,
      state: entry.state,
    };
  }

  if (!entry.localFilePath) {
    return {
      ok: false,
      code: "SEGMENT_SOURCE_MISSING",
      message: "Retry source audio is no longer available for this failed segment.",
      state: entry.state,
    };
  }

  const nextSession = updateSession(id, (s) => ({
    ...s,
    segmentRegistry: {
      ...s.segmentRegistry,
      [key]: {
        ...s.segmentRegistry[key],
        state: "queued",
        requestId: requestId ?? s.segmentRegistry[key].requestId ?? null,
        queuedAt: queuedAt ?? new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        processingMs: null,
        lastError: null,
      },
    },
    segmentQueue: [...(s.segmentQueue ?? []).filter((idx) => idx !== segmentIndex), segmentIndex],
  }));

  if (!nextSession) {
    return { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found." };
  }

  return {
    ok: true,
    state: "queued",
    segmentIndex,
    attemptCount: nextSession.segmentRegistry?.[key]?.attemptCount ?? entry.attemptCount ?? 0,
    maxAttempts: nextSession.segmentRegistry?.[key]?.maxAttempts ?? entry.maxAttempts ?? 3,
  };
}

export function markSegmentProcessing(id, { segmentIndex, requestId, startedAt }) {
  return updateSession(id, (s) => ({
    ...s,
    segmentRegistry: upsertSegmentRegistryEntry(s, segmentIndex, (entry) => ({
      ...entry,
      state: "processing",
      requestId: requestId ?? entry.requestId ?? null,
      startedAt: startedAt ?? new Date().toISOString(),
      attemptCount: (entry.attemptCount ?? 0) + 1,
      completedAt: null,
      processingMs: null,
      lastError: null,
    })),
  }));
}

export function markSegmentTranscribed(id, { segmentIndex, requestId, completedAt, processingMs, transcript }) {
  return updateSession(id, (s) => ({
    ...s,
    segmentRegistry: upsertSegmentRegistryEntry(s, segmentIndex, (entry) => ({
      ...entry,
      state: "transcribed",
      requestId: requestId ?? entry.requestId ?? null,
      completedAt: completedAt ?? new Date().toISOString(),
      processingMs: Number.isFinite(processingMs) ? processingMs : entry.processingMs ?? null,
      transcript: typeof transcript === "string" ? transcript : entry.transcript ?? null,
      localFilePath: null,
      lastError: null,
    })),
  }));
}

export function markSegmentFailed(id, { segmentIndex, requestId, completedAt, processingMs, error, localFilePath }) {
  return updateSession(id, (s) => ({
    ...s,
    segmentRegistry: upsertSegmentRegistryEntry(s, segmentIndex, (entry) => ({
      ...entry,
      state: "failed",
      requestId: requestId ?? entry.requestId ?? null,
      completedAt: completedAt ?? new Date().toISOString(),
      processingMs: Number.isFinite(processingMs) ? processingMs : entry.processingMs ?? null,
      localFilePath: localFilePath ?? entry.localFilePath ?? null,
      lastError: error
        ? {
            stage: error.stage ?? "segment_transcription",
            message: error.message ?? "Unknown error",
            at: error.at ?? new Date().toISOString(),
          }
        : entry.lastError,
    })),
  }));
}

export function setSessionStatus(id, status) {
  return updateSession(id, (s) => ({
    ...s,
    status,
  }));
}

export function setFinalNote(id, finalNote) {
  return updateSession(id, (s) => ({
    ...s,
    finalNote,
    finalizedAt: new Date().toISOString(),
    status: "completed",
  }));
}
