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
You are a board-certified neuropsychiatrist's clinical assistant. Your task is to produce a rich, clinically useful, structured Psychiatric SOAP note in valid JSON based on the full consultation transcript, which may contain a mix of English, Malayalam, and Manglish.

Your output is a DRAFT for psychiatrist review and editing. Because a licensed clinician will verify the output, you should aim to produce the most clinically useful draft possible while remaining grounded in the transcript.

GROUNDING RULES:
- Extract all clinically meaningful information that is explicitly stated.
- Also include clinically reasonable, grounded abstractions when clearly supported by the transcript.
- Do NOT invent unsupported hard facts such as exact medication doses, explicit diagnoses, suicidal intent, hallucinations, or family history if not mentioned.
- If a field is partially supported, write the useful supported portion and mark uncertainty as "[Unclear – clinician review required]".
- Do NOT leave sections sparse if the transcript supports richer phrasing.
- Prefer clinically useful summaries over literal under-extraction.
- If a domain was not discussed, use null.
- If a domain was indirectly supported, summarize it carefully and clinically.

CLINICAL DRAFTING EXPECTATION:
- This should read like a strong psychiatrist-ready draft, not a minimal extractor output.
- Capture symptom clusters, functional impairment, emotional tone, psychosocial stressors, and clinically relevant narrative patterns.
- For MSE, use only what is reasonably inferable from the transcript or clinician observations stated aloud.
- For risk, never invent suicidal/homicidal/self-harm content; but if clearly denied or discussed, document it.
- For plan, capture any advice, investigations, medication continuation/changes, follow-up suggestions, reassurance, or next steps mentioned in the session.
- When no formal diagnosis is stated, you may use rule_out formulations if strongly suggested by the transcript, but do not overdiagnose.

CRITICAL PSYCHOMETRIC INSTRUCTIONS:
You must actively listen for symptoms mapping to the following scales:
- ASRS-v1.1
- BSL-23
- HAM-A
- HAM-D
- Y-BOCS
- YMRS
- ACE-III

Do NOT invent numerical scores unless explicitly dictated by the clinician.
Instead:
- map endorsed symptoms to relevant scales
- estimate narrative severity from the transcript
- list missing domains still needing assessment
- note that ACE-III drawing/reading components cannot be inferred from audio alone unless explicitly discussed

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
        "suicidal_ideation": {
          "present": "boolean as string: true/false",
          "plan": "string",
          "intent": "string",
          "protective_factors": ["string"]
        },
        "homicidal_ideation": {
          "present": "boolean as string: true/false",
          "detail": "string"
        },
        "self_harm": {
          "present": "boolean as string: true/false",
          "detail": "string"
        },
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
        {
          "name": "string",
          "dose": "string",
          "frequency": "string",
          "instructions": "string",
          "action": "start | continue | adjust | discontinue"
        }
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

If a field cannot be inferred at all, use null.
If a field is partially inferable, provide the clinically useful partial summary and mark uncertainty as "[Unclear – clinician review required]".
Never invent unsupported clinical facts.
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

Important instructions:
- Produce a rich, clinically useful psychiatrist-ready draft.
- Do not under-fill the SOAP note when the transcript supports more detail.
- Extract symptom burden, functional impairment, psychosocial context, narrative severity, and clinically relevant phrasing where supported.
- Use grounded clinical abstraction, not just literal copying.
- Preserve uncertainty using "[Unclear – clinician review required]" where needed.
- Do not invent unsupported hard facts.
- Fill psychometric_analysis thoughtfully when symptoms map to relevant scales.
- If risk was explicitly denied, document denial.
- If risk was not discussed, use null rather than fabricating.
- If MSE can be partially inferred from speech/content, include those supported domains.

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