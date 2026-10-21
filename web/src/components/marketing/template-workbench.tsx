import { useState } from "react";
import { buildTemplate, RESOURCE_TEMPLATES } from "@/lib/resource-templates";

export function TemplateWorkbench({ slug }: { slug: string }) {
  const template = RESOURCE_TEMPLATES[slug];
  const [values, setValues] = useState<Record<string, string>>({});
  const [previousDraft, setPreviousDraft] = useState<Record<
    string,
    string
  > | null>(null);
  const [status, setStatus] = useState("");
  if (!template) return null;
  const hasDraft = Object.values(values).some((value) => value.trim());
  const markdown = buildTemplate(template, values);
  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setStatus("Your draft was copied as Markdown.");
    } catch {
      setStatus(
        "Clipboard unavailable. Select the preview text or download your draft.",
      );
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug}-draft.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("Your Markdown draft is ready to save.");
  }
  return (
    <section
      id="build-your-template"
      aria-labelledby="template-builder-title"
      className="my-10 scroll-mt-24 rounded-3xl border border-ev-line bg-ev-raised p-5 sm:p-7"
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-ev-coat">
        Make it yours
      </p>
      <h2
        id="template-builder-title"
        className="mt-2 font-round text-2xl font-bold text-ev-ink"
      >
        Build your {template.title.toLowerCase()}
      </h2>
      <p className="mt-3 text-ev-ink-2">{template.intro}</p>
      <p className="mt-2 text-sm text-ev-ink-2">
        This website tool formats what you enter; it does not use AI or submit
        these fields to Eavesy. Drafts stay in this page’s memory and disappear
        on reload.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={hasDraft}
          aria-describedby="example-help"
          className="min-h-11 rounded-full border border-ev-line-strong px-4 text-sm font-semibold text-ev-ink disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            setValues(
              Object.fromEntries(
                template.fields.map((field) => [field.key, field.example]),
              ),
            );
            setStatus(
              "Loaded a fictional teaching example. Replace it with your own observations.",
            );
          }}
        >
          Load fictional example
        </button>
        <button
          type="button"
          className="min-h-11 px-3 text-sm text-ev-ink-2 underline underline-offset-4"
          onClick={() => {
            if (hasDraft) setPreviousDraft(values);
            setValues({});
            setStatus(
              "Draft cleared. You can restore the previous draft below.",
            );
          }}
        >
          Clear fields
        </button>
        {previousDraft && (
          <button
            type="button"
            className="min-h-11 px-3 text-sm text-ev-coat underline underline-offset-4"
            onClick={() => {
              setValues(previousDraft);
              setPreviousDraft(null);
              setStatus("Previous draft restored.");
            }}
          >
            Restore previous draft
          </button>
        )}
      </div>
      <p id="example-help" className="mt-2 text-sm text-ev-ink-2">
        Clear existing fields before loading an example. You can restore a
        cleared draft while this page stays open.
      </p>
      <div className="mt-6 grid gap-5">
        {template.fields.map((field) => (
          <label
            key={field.key}
            className="block"
            htmlFor={`template-${field.key}`}
          >
            <span className="font-semibold text-ev-ink">{field.label}</span>
            <span
              id={`hint-${field.key}`}
              className="mt-1 block text-sm text-ev-ink-2"
            >
              {field.hint}
            </span>
            <textarea
              id={`template-${field.key}`}
              aria-label={field.label}
              aria-describedby={`hint-${field.key}`}
              rows={3}
              value={values[field.key] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setValues((previous) => ({ ...previous, [field.key]: value }));
                setStatus("");
              }}
              className="mt-2 w-full resize-y rounded-xl border border-ev-line-strong bg-ev-paper p-3 text-base text-ev-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ev-coat"
            />
          </label>
        ))}
      </div>
      <h3 className="mt-7 font-round text-lg font-bold text-ev-ink">
        Markdown preview
      </h3>
      <pre
        aria-label="Your Markdown draft"
        className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-ev-well p-4 text-sm leading-relaxed text-ev-ink"
      >
        <code>{markdown}</code>
      </pre>
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void copy()}
          className="min-h-11 rounded-full bg-ev-coat px-5 font-semibold text-ev-on-coat"
        >
          Copy your draft
        </button>
        <button
          type="button"
          onClick={download}
          className="min-h-11 rounded-full border border-ev-line-strong px-5 font-semibold text-ev-ink"
        >
          Download your draft
        </button>
      </div>
      <p role="status" className="mt-3 min-h-6 text-sm text-ev-ink-2">
        {status}
      </p>
    </section>
  );
}
