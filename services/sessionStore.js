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
  };

  sessions.set(id, session);
  return session;
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
