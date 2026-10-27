-- Every existing learned row starts at 1, a suggestion: it stops steering transcription
-- until the user keeps it in Settings or makes the same fix again. Intended: many were typos.
ALTER TABLE `personal_dictionary` ADD `seen` integer DEFAULT 1 NOT NULL;