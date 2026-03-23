/**
 * POST /api/transcribe
 *
 * Accepts a multipart audio upload, stages it via the Gemini File API,
 * generates a structured psychiatric SOAP note, then immediately deletes
 * the local file (HIPAA / DPDP compliance).
 *
 * Dependencies:
 *   npm install express multer @google/genai uuid
 *
 * Environment variables:
 *   GEMINI_API_KEY   – your Google AI Studio / Vertex key
 */

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { GoogleGenAI } from "@google/genai";

// ─── Router ──────────────────────────────────────────────────────────────────

const router = express.Router();

// ─── Gemini client ────────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Multer – disk storage (we need a real path for uploadFile) ───────────────

const UPLOAD_DIR = path.resolve("tmp_uploads"); // ephemeral, never committed

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    // Preserve original extension; randomise name to prevent collisions / path traversal
    const ext = path.extname(file.originalname).toLowerCase() || ".webm";
    cb(null, `${randomUUID()}${ext}`);
  },
});

const ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/aac",
]);

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (Gemini File API limit)

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        Object.assign(new Error("Unsupported audio format."), {
          status: 415,
        })
      );
    }
  },
});

// ─── System instruction ───────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `
You are a board-certified neuropsychiatrist's clinical assistant. Your task is to produce a structured Psychiatric SOAP note in valid JSON based on the clinical audio recording provided (which may contain a mix of English, Malayalam, and Manglish).

**CRITICAL PSYCHOMETRIC INSTRUCTIONS:**
You must actively listen for symptoms mapping to the following scales: ASRS-v1.1, BSL-23, HAM-A, HAM-D, Y-BOCS, Young Mania Rating Scale (YMRS), and ACE-III. 
Do NOT invent numerical scores unless the clinician explicitly dictates them. Instead, map the endorsed symptoms to the relevant scale, estimate severity based on the narrative, and list what domains the clinician still needs to assess. Note: ACE-III involves physical drawing/reading which cannot be captured via audio; only document verbal cognitive assessments.

Return ONLY a valid JSON object matching this exact schema:

{
  "soap_note": {
    "subjective": {
      "hpi": {
        "chief_complaint": "string",
        "onset": "string",
        "duration": "string",
        "precipitating_factors": ["string"],
        "symptoms": ["string"],
        "psychiatric_history": "string",
        "substance_use": "string",
        "social_history": "string",
        "family_psychiatric_history": "string",
        "medications": ["string"],
        "allergies": ["string"]
      }
    },
    "objective": {
      "mental_status_exam": {
        "appearance": "string",
        "behavior": "string",
        "speech": "string",
        "mood": "string",
        "affect": "string",
        "thought_process": "string",
        "thought_content": "string",
        "perceptual_disturbances": "string",
        "cognition": "string",
        "insight": "string",
        "judgment": "string"
      }
    },
    "assessment": {
      "diagnoses": [
        { "icd10_code": "string", "description": "string", "status": "primary | secondary | rule_out" }
      ],
      "risk_assessment": {
        "suicidal_ideation": { "present": "boolean as string: true/false", "plan": "string", "intent": "string", "protective_factors": ["string"] },
        "homicidal_ideation": { "present": "boolean as string: true/false", "detail": "string" },
        "self_harm": { "present": "boolean as string: true/false", "detail": "string" },
        "overall_risk_level": "low | moderate | high | imminent",
        "clinical_rationale": "string"
      },
      "psychometric_analysis": [
        {
          "scale_name": "ASRS-v1.1 | BSL-23 | HAM-A | HAM-D | Y-BOCS | YMRS | ACE-III",
          "relevance_to_session": "High | Medium | Low",
          "symptoms_mapped_to_scale": ["string (e.g., 'Insomnia (HAM-D Item 4)', 'Motor tension (HAM-A)')"],
          "narrative_severity_estimate": "Subclinical | Mild | Moderate | Severe",
          "missing_domains_to_evaluate": ["string (e.g., 'Did not assess for somatic anxiety or weight loss')"]
        }
      ]
    },
    "plan": {
      "medications": [
        { "name": "string", "dose": "string", "frequency": "string", "instructions": "string", "action": "start | continue | adjust | discontinue" }
      ],
      "psychotherapy": "string",
      "safety_plan": "string",
      "referrals": ["string"],
      "labs_or_diagnostics": ["string"],
      "patient_education": "string",
      "follow_up": "string",
      "disposition": "string"
    }
  },
  "transcription_confidence": "high | medium | low",
  "clinician_review_required": true,
  "disclaimer": "AI-generated draft. Must be reviewed, edited, and co-signed by a licensed clinician before use in any medical record."
}

If a field cannot be inferred from the audio, use null.
Never invent clinical information; flag uncertainty with "[Unclear – clinician review required]".
`.trim();

// ─── Polling helper: wait for Gemini file to become ACTIVE ───────────────────

async function waitForFileActive(fileResource, { maxWaitMs = 120_000, pollMs = 3_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const refreshed = await ai.files.get({ name: fileResource.name });
    if (refreshed.state === "ACTIVE") return refreshed;
    if (refreshed.state === "FAILED") throw new Error(`Gemini file processing failed: ${refreshed.name}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error("Timed out waiting for Gemini file to become ACTIVE.");
}

// ─── Route handler ────────────────────────────────────────────────────────────

router.post(
  "/transcribe",
  upload.single("audio"), // field name must be "audio" in the multipart form
  async (req, res) => {
    const localPath = req.file?.path;

    // Wrap everything so we can guarantee local file deletion in all paths
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No audio file received." });
      }

      // ── 1. Upload to Gemini File API ────────────────────────────────────────
      let uploadedFile;
      try {
        uploadedFile = await ai.files.upload({
          file: localPath,                      // path on disk
          config: {
            mimeType: req.file.mimetype,
            displayName: `psych-session-${randomUUID()}`, // no PHI in display name
          },
        });
      } catch (uploadErr) {
        console.error("[Gemini] File upload error:", uploadErr);
        return res.status(502).json({ error: "Failed to stage audio with Gemini File API." });
      }

      // ── 2. Poll until the file is ACTIVE (virus-scan + transcoding) ─────────
      try {
        uploadedFile = await waitForFileActive(uploadedFile);
      } catch (pollErr) {
        console.error("[Gemini] File activation error:", pollErr);
        // Best-effort: try to delete the remote file even if it failed
        await ai.files.delete({ name: uploadedFile.name }).catch(() => {});
        return res.status(504).json({ error: "Audio processing timed out on Gemini side." });
      }

      // ── 3. Generate the SOAP note ────────────────────────────────────────────
      let geminiResponse;
      try {
        geminiResponse = await ai.models.generateContent({
          model: "gemini-2.5-flash",           // swap to gemini-1.5-pro for higher accuracy
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            temperature: 0.1,                  // low temp for clinical determinism
            responseMimeType: "application/json",
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    fileUri: uploadedFile.uri,
                    mimeType: req.file.mimetype,
                  },
                },
                {
                  text: "Generate the psychiatric SOAP note JSON for this session recording.",
                },
              ],
            },
          ],
        });
      } catch (genErr) {
        console.error("[Gemini] generateContent error:", genErr);
        await ai.files.delete({ name: uploadedFile.name }).catch(() => {});
        return res.status(502).json({ error: "Gemini content generation failed." });
      }

      // ── 4. Delete remote Gemini file (no PHI retained on Google's staging) ──
      await ai.files.delete({ name: uploadedFile.name }).catch((e) =>
        console.warn("[Gemini] Remote file deletion warning:", e.message)
      );

      // ── 5. Parse and validate the JSON response ──────────────────────────────
      let soapNote;
      try {
        const rawText = geminiResponse.text;
        // Strip accidental markdown fences that may slip through
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        soapNote = JSON.parse(cleaned);
      } catch (parseErr) {
        console.error("[Parser] JSON parse error:", parseErr);
        return res.status(500).json({
          error: "Gemini returned malformed JSON.",
          raw: geminiResponse.text, // send raw so the client can surface it for manual review
        });
      }

      // ── 6. Return the structured note ────────────────────────────────────────
      return res.status(200).json(soapNote);
    } finally {
      // ── HIPAA / DPDP: delete local temp file unconditionally ─────────────────
      if (localPath) {
        await fs.unlink(localPath).catch((e) =>
          console.error("[Cleanup] Failed to delete local audio file:", e.message)
        );
      }
    }
  }
);

// ─── Multer error handler (must be registered after the route) ────────────────

router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Audio file exceeds the 2 GB size limit." });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err?.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("[Unhandled]", err);
  return res.status(500).json({ error: "Internal server error." });
});

export default router;