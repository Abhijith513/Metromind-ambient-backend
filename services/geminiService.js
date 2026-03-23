// services/geminiService.js
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
- Do not infer missing words unless obvious from context.
- If unclear, mark [unclear].
              `.trim(),
            },
          ],
        },
      ],
    });

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
Generate a structured psychiatric SOAP note in valid JSON from the transcript.
If uncertain, use null or "[Unclear – clinician review required]".
Return only valid JSON.
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

Transcript:
${fullTranscript}
            `.trim(),
          },
        ],
      },
    ],
  });

  const rawText = response.text ?? "";
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}