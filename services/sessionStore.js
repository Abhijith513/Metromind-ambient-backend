// services/sessionStore.js
import { randomUUID } from "crypto";

const sessions = new Map();

export function createSession() {
  const id = randomUUID();

  const session = {
    id,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    segmentCount: 0,
    transcriptParts: [],
    errors: [],
    finalNote: null,
    finalizedAt: null,
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
    status: "recording",
  }));
}

export function addSessionError(id, error) {
  return updateSession(id, (s) => ({
    ...s,
    errors: [...s.errors, error],
    status: "failed",
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