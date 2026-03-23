/**
 * POST /api/transcribe (Asynchronous)
 * GET /api/job/:jobId
 *
 * Accepts a multipart audio upload, returns a Job ID immediately, and 
 * processes the audio with Gemini in the background. 
 */

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { GoogleGenAI } from "@google/genai";

// ─── Router & In-Memory Store ────────────────────────────────────────────────

const router = express.Router();
const jobs = new Map(); // Tracks background jobs

// ─── Gemini client ────────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Multer – disk storage ────────────────────────────────────────────────────

const UPLOAD_DIR = path.resolve("tmp_uploads");

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

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

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

// ─── NEW: The Background Worker ──────────────────────────────────────────────

async function processAudioInBackground(jobId, file) {
  const localPath = file.path;
  let uploadedFile;

  try {
    console.log(`[Job ${jobId}] Starting background processing...`);

    // 1. Upload to Gemini
    uploadedFile = await ai.files.upload({
      file: localPath,
      config: {
        mimeType: file.mimetype,
        displayName: `psych-session-${jobId}`,
      },
    });

    // 2. Wait for it to be active
    uploadedFile = await waitForFileActive(uploadedFile);

    // 3. Generate Content
    const geminiResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        responseMimeType: "application/json",
      },
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: uploadedFile.uri, mimeType: file.mimetype } },
            { text: "Generate the psychiatric SOAP note JSON for this session recording." },
          ],
        },
      ],
    });

    // 4. Parse the response
    const rawText = geminiResponse.text;
    const cleaned = rawText.replace(/^
http://googleusercontent.com/immersive_entry_chip/0

### Key Changes to Notice
1. **Moved the HIPAA Cleanup:** The strict local file deletion (`fs.unlink`) now happens at the end of the `processAudioInBackground` function. This guarantees that even if the polling connection drops, the file is securely wiped from your server after processing.
2. **Added Request Abort Protection:** I added a specific check in the error handler at the bottom for `Request aborted`. If a phone drops connection *during* the file upload, the server will log a simple warning instead of crashing.
