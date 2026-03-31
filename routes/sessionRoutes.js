import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import {
  createSession,
  getSession,
  appendTranscriptPart,
  markSegmentReceived,
  markSegmentQueued,
  markSegmentProcessing,
  markSegmentTranscribed,
  markSegmentFailed,
  setSessionStatus,
  setFinalNote,
  addSessionError,
} from "../services/sessionStore.js";
import {
  transcribeSegment,
  generateSoapFromTranscript,
  sanitizeFullTranscript,
} from "../services/geminiService.js";

const router = express.Router();

const UPLOAD_DIR = path.resolve("uploads/sessions");
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".webm";
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

async function cleanupUploadedFile(filePath) {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => {});
}

function buildSegmentError({ stage, segmentIndex, message }) {
  return {
    stage,
    segmentIndex,
    message,
  };
}

function formatDurationMs(startMs) {
  return Math.max(0, Date.now() - startMs);
}

function logSegmentLifecycle({
  phase,
  requestId,
  sessionId,
  segmentIndex,
  mimeType,
  size,
  durationMs,
  transcriptLength,
  message,
}) {
  const fields = [
    `[Segment ${phase}]`,
    `req=${requestId}`,
    `session=${sessionId}`,
    `index=${segmentIndex}`,
  ];

  if (mimeType) fields.push(`mime=${mimeType}`);
  if (Number.isFinite(size)) fields.push(`size=${size}`);
  if (Number.isFinite(durationMs)) fields.push(`ms=${durationMs}`);
  if (Number.isFinite(transcriptLength)) fields.push(`chars=${transcriptLength}`);
  if (message) fields.push(`message=${message}`);

  console.log(fields.join(" "));
}

function toSortedSegmentEntries(session) {
  const entries = Object.values(session.segmentRegistry ?? {});
  return entries.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
}

function buildSegmentLifecycleSummary(segmentEntries) {
  const summary = {
    queuedCount: 0,
    processingCount: 0,
    transcribedCount: 0,
    failedCount: 0,
    retryScheduledCount: 0,
  };

  for (const entry of segmentEntries) {
    if (entry?.state === "queued") summary.queuedCount += 1;
    else if (entry?.state === "processing") summary.processingCount += 1;
    else if (entry?.state === "transcribed") summary.transcribedCount += 1;
    else if (entry?.state === "failed") summary.failedCount += 1;
    else if (entry?.state === "retry_scheduled") summary.retryScheduledCount += 1;
  }

  return summary;
}

router.post("/sessions", (req, res) => {
  const session = createSession({
    patientName: req.body?.patientName,
    chiefComplaint: req.body?.chiefComplaint,
    preferredLanguage: req.body?.preferredLanguage,
  });

  return res.status(201).json({
    sessionId: session.id,
    status: session.status,
    preSession: {
      patientName: session.patientName,
      chiefComplaint: session.chiefComplaint,
      preferredLanguage: session.preferredLanguage,
    },
  });
});

router.post("/sessions/:sessionId/segments", upload.single("audio"), async (req, res) => {
  const { sessionId } = req.params;
  const requestId = randomUUID();
  const receivedAtMs = Date.now();
  const rawSegmentIndex = req.body?.segmentIndex;
  const parsedProvidedSegmentIndex =
    rawSegmentIndex !== undefined && rawSegmentIndex !== null && rawSegmentIndex !== ""
      ? Number(rawSegmentIndex)
      : null;
  const providedSegmentIndex = Number.isFinite(parsedProvidedSegmentIndex)
    ? parsedProvidedSegmentIndex
    : null;
  const session = getSession(sessionId);

  if (!session) {
    await cleanupUploadedFile(req.file?.path);
    return res.status(404).json({
      error: buildSegmentError({
        stage: "session_lookup",
        segmentIndex: providedSegmentIndex,
        message: "Session not found.",
      }),
    });
  }

  if (!req.file) {
    return res.status(400).json({
      error: buildSegmentError({
        stage: "request_validation",
        segmentIndex: providedSegmentIndex ?? session.segmentCount,
        message: "No audio segment received.",
      }),
    });
  }

  const segmentIndex =
    rawSegmentIndex !== undefined && rawSegmentIndex !== null && rawSegmentIndex !== ""
      ? Number(rawSegmentIndex)
      : session.segmentCount;

  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    await cleanupUploadedFile(req.file?.path);
    return res.status(400).json({
      error: buildSegmentError({
        stage: "request_validation",
        segmentIndex: providedSegmentIndex,
        message: "Invalid segmentIndex. Expected a non-negative integer.",
      }),
    });
  }

  logSegmentLifecycle({
    phase: "received",
    requestId,
    sessionId,
    segmentIndex,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });

  markSegmentQueued(sessionId, {
    segmentIndex,
    requestId,
    queuedAt: new Date(receivedAtMs).toISOString(),
  });

  try {
    markSegmentReceived(sessionId);
    setSessionStatus(sessionId, "processing_segments");
    markSegmentProcessing(sessionId, {
      segmentIndex,
      requestId,
      startedAt: new Date().toISOString(),
    });

    logSegmentLifecycle({
      phase: "transcription_started",
      requestId,
      sessionId,
      segmentIndex,
      mimeType: req.file.mimetype,
      size: req.file.size,
      durationMs: formatDurationMs(receivedAtMs),
    });

    const transcript = await transcribeSegment(req.file.path, req.file.mimetype);

    const processingMs = formatDurationMs(receivedAtMs);
    logSegmentLifecycle({
      phase: "transcription_finished",
      requestId,
      sessionId,
      segmentIndex,
      durationMs: processingMs,
      transcriptLength: transcript?.length ?? 0,
    });
    console.log(transcript || "[EMPTY TRANSCRIPT]");

    appendTranscriptPart(sessionId, {
      index: segmentIndex,
      transcript,
      receivedAt: new Date().toISOString(),
    });
    markSegmentTranscribed(sessionId, {
      segmentIndex,
      requestId,
      completedAt: new Date().toISOString(),
      processingMs,
      transcript,
    });

    return res.status(202).json({
      ok: true,
      status: "recording",
      segmentIndex,
      transcriptLength: transcript?.length ?? 0,
      processingMs,
    });
  } catch (err) {
    logSegmentLifecycle({
      phase: "failed",
      requestId,
      sessionId,
      segmentIndex,
      durationMs: formatDurationMs(receivedAtMs),
      message: err instanceof Error ? err.message : "Unknown error",
    });
    console.error(`[Segment failure] req=${requestId} session=${sessionId} index=${segmentIndex}`, err);

    addSessionError(sessionId, {
      stage: "segment_transcription",
      message: err instanceof Error ? err.message : "Unknown error",
      segmentIndex,
      at: new Date().toISOString(),
    });
    markSegmentFailed(sessionId, {
      segmentIndex,
      requestId,
      completedAt: new Date().toISOString(),
      processingMs: formatDurationMs(receivedAtMs),
      error: {
        stage: "segment_transcription",
        message: err instanceof Error ? err.message : "Unknown error",
        at: new Date().toISOString(),
      },
    });

    return res.status(500).json({
      error: buildSegmentError({
        stage: "segment_transcription",
        segmentIndex,
        message: err instanceof Error ? err.message : "Failed to process segment.",
      }),
    });
  } finally {
    await cleanupUploadedFile(req.file?.path);
  }
});

router.get("/sessions/:sessionId/status", (req, res) => {
  const session = getSession(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  const segmentEntries = toSortedSegmentEntries(session);

  return res.json({
    sessionId: session.id,
    status: session.status,
    segmentCount: session.segmentCount,
    preSession: {
      patientName: session.patientName ?? null,
      chiefComplaint: session.chiefComplaint ?? null,
      preferredLanguage: session.preferredLanguage ?? null,
    },
    segmentProcessing: {
      receivedSegmentCount: session.receivedSegmentCount ?? session.segmentCount ?? 0,
      transcribedSegmentCount: session.transcribedSegmentCount ?? session.segmentCount ?? 0,
      failedSegmentCount: session.failedSegmentCount ?? 0,
      lastProcessedSegmentIndex: session.lastProcessedSegmentIndex ?? null,
      inFlightSegmentCount: Math.max(
        0,
        (session.receivedSegmentCount ?? session.segmentCount ?? 0) -
          (session.transcribedSegmentCount ?? session.segmentCount ?? 0) -
          (session.failedSegmentCount ?? 0)
      ),
    },
    segmentLifecycleSummary: buildSegmentLifecycleSummary(segmentEntries),
    segments: segmentEntries.map((entry) => ({
      segmentIndex: entry.segmentIndex,
      state: entry.state,
      attemptCount: entry.attemptCount ?? 0,
      maxAttempts: entry.maxAttempts ?? 3,
      requestId: entry.requestId ?? null,
      queuedAt: entry.queuedAt ?? null,
      startedAt: entry.startedAt ?? null,
      completedAt: entry.completedAt ?? null,
      processingMs: entry.processingMs ?? null,
      hasTranscript: typeof entry.transcript === "string",
      transcriptLength: entry.transcript?.length ?? 0,
      lastError: entry.lastError ?? null,
    })),
    hasResult: !!session.finalNote,
    errors: session.errors,
  });
});

router.post("/sessions/:sessionId/finalize", async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  if (!session.transcriptParts.length) {
    return res.status(400).json({ error: "No transcript segments available." });
  }

  try {
    setSessionStatus(sessionId, "finalizing");

    const orderedParts = session.transcriptParts
      .slice()
      .sort((a, b) => a.index - b.index);

    const rawFullTranscript = orderedParts
      .map((p) => p.transcript)
      .filter(Boolean)
      .join("\n");

    const sanitizedFullTranscript = sanitizeFullTranscript(rawFullTranscript);

    console.log(
      `[Finalize] session=${sessionId} parts=${orderedParts.length} rawFullTranscriptChars=${rawFullTranscript.length} sanitizedFullTranscriptChars=${sanitizedFullTranscript.length}`
    );
    console.log("[RAW FULL TRANSCRIPT START]");
    console.log(rawFullTranscript || "[EMPTY RAW FULL TRANSCRIPT]");
    console.log("[RAW FULL TRANSCRIPT END]");
    console.log("[SANITIZED FULL TRANSCRIPT START]");
    console.log(sanitizedFullTranscript || "[EMPTY SANITIZED FULL TRANSCRIPT]");
    console.log("[SANITIZED FULL TRANSCRIPT END]");

    const finalNote = await generateSoapFromTranscript(sanitizedFullTranscript);

    console.log("[FINAL SOAP NOTE]");
    console.log(JSON.stringify(finalNote, null, 2));

    setFinalNote(sessionId, finalNote);

    return res.status(200).json({
      ok: true,
      status: "completed",
    });
  } catch (err) {
    console.error(`[Finalize failure] session=${sessionId}`, err);

    addSessionError(sessionId, {
      stage: "final_note_generation",
      message: err instanceof Error ? err.message : "Unknown error",
      at: new Date().toISOString(),
    });

    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to finalize session.",
    });
  }
});

router.get("/sessions/:sessionId/result", (req, res) => {
  const session = getSession(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  if (!session.finalNote) {
    return res.status(409).json({ error: "Result not ready yet." });
  }

  return res.json(session.finalNote);
});

export default router;
