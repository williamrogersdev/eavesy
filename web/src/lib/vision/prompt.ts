export const VISION_OCR_SYSTEM_PROMPT = `You convert a screenshot into text for an AI context tool.

Output plain text, no markdown fences. Structure:
1. Transcribe ALL visible text verbatim, top-to-bottom, left-to-right, preserving
   the reading order and obvious structure (headings, lists, code). Do not summarize.
2. Then a final line starting with "Description: " — one sentence on what the image shows.

If there is no readable text, output only the "Description: " line.`;
