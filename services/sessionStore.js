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
      lastError: null,
    })),
  }));
}

export function markSegmentFailed(id, { segmentIndex, requestId, completedAt, processingMs, error }) {
  return updateSession(id, (s) => ({
    ...s,
    segmentRegistry: upsertSegmentRegistryEntry(s, segmentIndex, (entry) => ({
      ...entry,
      state: "failed",
      requestId: requestId ?? entry.requestId ?? null,
      completedAt: completedAt ?? new Date().toISOString(),
      processingMs: Number.isFinite(processingMs) ? processingMs : entry.processingMs ?? null,
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
