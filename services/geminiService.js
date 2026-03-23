import fs from "fs/promises";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function waitForFileActive(fileResource, { maxWaitMs = 120000, pollMs = 3000 } = {}) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const refreshed = await ai.files.get({ name: fileResource.name });

    if (refreshed.state === "ACTIVE") return refreshed;
    if (refreshed.state === "FAILED") {
      throw new Error(`Gemini file processing failed: ${refreshed.name}`);
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error("Timed out waiting for Gemini file to become ACTIVE.");
}

export async function transcribeSegment(localPath, mimeType) {
  let uploadedFile;

  try {
    uploadedFile = await ai.files.upload({
      file: localPath,
      config: {
        mimeType,
        displayName: `segment-${Date.now()}`,
      },
    });

    uploadedFile = await waitForFileActive(uploadedFile);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        temperature: 0.1,
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: uploadedFile.uri,
                mimeType,
              },
            },
            {
              text: `
Transcribe this psychiatric consultation audio segment faithfully.

Rules:
- Return plain text only.
- Preserve English, Malayalam, and Manglish naturally.
- Do not summarize.
- Do not infer clinical meaning.
- Do not invent details.
- If a phrase is unclear, mark it as [unclear].
- Include clinician and patient utterances in natural order when possible.
              `.trim(),
            },
          ],
        },
      ],
    });

    console.log("[RAW SEGMENT MODEL TEXT]");
    console.log(response.text ?? "[NO RESPONSE TEXT]");

    return response.text?.trim() ?? "";
  } finally {
    if (uploadedFile?.name) {
      await ai.files.delete({ name: uploadedFile.name }).catch(() => {});
    }
    await fs.unlink(localPath).catch(() => {});
  }
}

const SYSTEM_INSTRUCTION = `
You are a board-certified neuropsychiatrist's clinical assistant.

You must generate a structured psychiatric SOAP note in valid JSON from the transcript.

Rules:
- Return ONLY a valid JSON object.
- Do not include markdown fences.
- Use null only when the transcript truly does not support a field.
- Extract as much clinically grounded information as possible from the transcript.
- Do not leave fields blank when the information is reasonably stated in the transcript.
- Do not invent facts.
- Preserve uncertainty as "[Unclear – clinician review required]" when needed.

Return JSON in this exact structure:

{
  "soap_note": {
    "subjective": {
      "hpi": {
        "chief_complaint": "string or null",
        "onset": "string or null",
        "duration": "string or null",
        "precipitating_factors": ["string"],
        "symptoms": ["string"],
        "psychiatric_history": "string or null",
        "substance_use": "string or null",
        "social_history": "string or null",
        "family_psychiatric_history": "string or null",
        "medications": ["string"],
        "allergies": ["string"]
      }
    },
    "objective": {
      "mental_status_exam": {
        "appearance": "string or null",
        "behavior": "string or null",
        "speech": "string or null",
        "mood": "string or null",
        "affect": "string or null",
        "thought_process": "string or null",
        "thought_content": "string or null",
        "perceptual_disturbances": "string or null",
        "cognition": "string or null",
        "insight": "string or null",
        "judgment": "string or null"
      }
    },
    "assessment": {
      "diagnoses": [
        {
          "icd10_code": "string or null",
          "description": "string",
          "status": "primary | secondary | rule_out"
        }
      ],
      "risk_assessment": {
        "suicidal_ideation": {
          "present": "true | false | null",
          "plan": "string or null",
          "intent": "string or null",
          "protective_factors": ["string"]
        },
        "homicidal_ideation": {
          "present": "true | false | null",
          "detail": "string or null"
        },
        "self_harm": {
          "present": "true | false | null",
          "detail": "string or null"
        },
        "overall_risk_level": "low | moderate | high | imminent | null",
        "clinical_rationale": "string or null"
      },
      "psychometric_analysis": [
        {
          "scale_name": "string",
          "relevance_to_session": "High | Medium | Low",
          "symptoms_mapped_to_scale": ["string"],
          "narrative_severity_estimate": "Subclinical | Mild | Moderate | Severe | null",
          "missing_domains_to_evaluate": ["string"]
        }
      ]
    },
    "plan": {
      "medications": [
        {
          "name": "string",
          "dose": "string or null",
          "frequency": "string or null",
          "instructions": "string or null",
          "action": "start | continue | adjust | discontinue | null"
        }
      ],
      "psychotherapy": "string or null",
      "safety_plan": "string or null",
      "referrals": ["string"],
      "labs_or_diagnostics": ["string"],
      "patient_education": "string or null",
      "follow_up": "string or null",
      "disposition": "string or null"
    }
  },
  "transcription_confidence": "high | medium | low",
  "clinician_review_required": true,
  "disclaimer": "AI-generated draft. Must be reviewed, edited, and co-signed by a licensed clinician before use in any medical record."
}
`.trim();

export async function generateSoapFromTranscript(fullTranscript) {
  const response = await ai.models.generateContent({
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
          {
            text: `
Generate the psychiatric SOAP note JSON from this full consultation transcript.

Important:
- Extract symptoms, onset, duration, history, medications, risks, MSE clues, and plan where present.
- Do not return an empty shell if information is present in the transcript.
- If the transcript contains only limited information, still fill what is supported.

Transcript:
${fullTranscript}
            `.trim(),
          },
        ],
      },
    ],
  });

  const rawText = response.text ?? "";

  console.log("[RAW SOAP MODEL TEXT]");
  console.log(rawText || "[NO SOAP RESPONSE TEXT]");

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}