import { describe, expect, it } from 'bun:test';
import { chosenModel, DEFAULT_ASSISTANT_MODEL, DEFAULT_NOTES_MODEL, isModelChoice, MODEL_CHOICES, modelNote, modelOptions } from './model-choice';

describe('model choice', () => {
  it('offers the defaults', () => {
    expect(isModelChoice(DEFAULT_NOTES_MODEL)).toBe(true);
    expect(isModelChoice(DEFAULT_ASSISTANT_MODEL)).toBe(true);
    expect(new Set(MODEL_CHOICES.map((choice) => choice.id)).size).toBe(MODEL_CHOICES.length);
  });

  it('uses what the account chose', () => {
    expect(chosenModel('claude-opus-5-5', DEFAULT_NOTES_MODEL)).toBe('claude-opus-5-5');
  });

  it('falls back to the default for no choice, or one no longer offered', () => {
    expect(chosenModel(null, DEFAULT_NOTES_MODEL)).toBe(DEFAULT_NOTES_MODEL);
    expect(chosenModel(undefined, DEFAULT_NOTES_MODEL)).toBe(DEFAULT_NOTES_MODEL);
    expect(chosenModel('claude-sonnet-4-6', DEFAULT_NOTES_MODEL)).toBe(DEFAULT_NOTES_MODEL);
    expect(chosenModel('gpt-something', DEFAULT_NOTES_MODEL)).toBe(DEFAULT_NOTES_MODEL);
  });

  it('lists the default first, named, then every model', () => {
    const options = modelOptions('claude-sonnet-5-5');
    expect(options[0]).toEqual({ value: '', label: 'Default (Sonnet 5.5)' });
    expect(options.slice(1).map((option) => option.value)).toEqual(MODEL_CHOICES.map((choice) => choice.id));
  });

  it('describes the model in use, chosen or default', () => {
    expect(modelNote('claude-opus-5-5', 'claude-sonnet-5-5')).toContain('Most thorough');
    expect(modelNote(null, 'claude-sonnet-5-5')).toContain('Balanced');
  });
});
