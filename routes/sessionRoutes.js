// routes/sessionRoutes.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import {
  createSession,
  getSession,
  appendTranscriptPart,
  setSessionStatus,
  setFinalNote,
  addSessionError,
} from "../services/sessionStore.js";
import {
  transcribeSegment,
  generateSoapFromTranscript,
} from "../services/geminiService.js";

const router = express.Router();

const UPLOAD_DIR = path.resolve("uploads/sessions");

await fs.mkdir(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".webm";
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // per segment, not whole session
  },
});

router.post("/sessions", (_req, res) => {
  const session = createSession();
  return res.status(201).json({
    sessionId: session.id,
    status: session.status,
  });
});

router.post("/sessions/:sessionId/segments", upload.single("audio"), async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    return res.status(404).json({ error: "Session not found." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No audio segment received." });
  }

  try {
    setSessionStatus(sessionId, "processing_segments");

    const transcript = await transcribeSegment(req.file.path, req.file.mimetype);

    appendTranscriptPart(sessionId, {
      index: session.segmentCount,
      transcript,
      receivedAt: new Date().toISOString(),
    });

    return res.status(202).json({
      ok: true,
      status: "recording",
      segmentIndex: session.segmentCount,
    });
  } catch (err) {
    addSessionError(sessionId, {
      stage: "segment_transcription",
      message: err instanceof Error ? err.message : "Unknown error",
      at: new Date().toISOString(),
    });

    return res.status(500).json({
      error: "Failed to process segment.",
    });
  }
});

router.get("/sessions/:sessionId/status", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  return res.json({
    sessionId: session.id,
    status: session.status,
    segmentCount: session.segmentCount,
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

    const fullTranscript = session.transcriptParts
      .sort((a, b) => a.index - b.index)
      .map((p) => p.transcript)
      .join("\n");

    const finalNote = await generateSoapFromTranscript(fullTranscript);

    setFinalNote(sessionId, finalNote);

    return res.status(200).json({
      ok: true,
      status: "completed",
    });
  } catch (err) {
    addSessionError(sessionId, {
      stage: "final_note_generation",
      message: err instanceof Error ? err.message : "Unknown error",
      at: new Date().toISOString(),
    });

    return res.status(500).json({
      error: "Failed to finalize session.",
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