# Quick translation

On Mac, open **Translate** in the capture panel's title bar. A capture's
**More → Translate** loads its full transcript. On the web, use
`/app/translate` or **Translate** on the Dictation page.

Choose **From** (or Detect language) and **To**, then type, paste, or click
**Speak**. Stop to translate. Language choices are remembered on this device;
**To English** resets the output language with one click. **Swap languages**
uses the translated output as the next input when a result is available.

**Copy** copies only the translation. **Paste at cursor** on Mac uses the
existing Accessibility-based paste and explicitly disables correction learning.
**Show** opens large text for another person to read; Escape or Done closes it.
The original remains visible and is never rewritten by a translation.

Text is limited to 4,000 characters; microphone input to 60 seconds. Speech
is transcribed in its original language before translation. Recognized speech
is returned even if translation fails, so retry uses the text. Requests require
browser sign-in or a paired device, use the translation quota and existing
bounded AI runner, and store neither audio nor translations in recording history.
Only language preferences are saved locally.

The launcher browser development preview opens the current native panel with
sample captures by default. `?web` opens the separate web command palette.
The preview does not make real translation calls; use a signed-in web session
or rebuilt Mac app to translate actual input.
