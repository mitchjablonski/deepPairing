import { usePreferencesStore, EDITOR_PRESETS } from "../stores/preferences";
import { useState } from "react";

/** Inline link that opens a file at a specific line in the user's configured editor */
export function OpenInEditorLink({
  filePath,
  line,
  column = 1,
  className = "",
}: {
  filePath: string;
  line: number;
  column?: number;
  className?: string;
}) {
  const link = usePreferencesStore((s) => s.buildEditorLink(filePath, line, column));

  if (!link) return null;

  return (
    <a
      href={link}
      className={`text-accent-blue/60 hover:text-accent-blue text-2xs transition-colors ${className}`}
      title={`Open ${filePath}:${line} in editor`}
      onClick={(e) => e.stopPropagation()}
    >
      ↗
    </a>
  );
}

/** Editor picker dropdown for settings */
export function EditorPicker() {
  const editorScheme = usePreferencesStore((s) => s.editorScheme);
  const setEditorScheme = usePreferencesStore((s) => s.setEditorScheme);
  const [showCustom, setShowCustom] = useState(false);
  const [customTemplate, setCustomTemplate] = useState(editorScheme);

  const currentPreset = Object.entries(EDITOR_PRESETS).find(
    ([_, v]) => v.template === editorScheme,
  )?.[0] ?? "custom";

  return (
    <div className="flex items-center gap-2">
      <label className="text-2xs text-text-muted">Editor:</label>
      <select
        value={currentPreset}
        onChange={(e) => {
          const key = e.target.value;
          const preset = EDITOR_PRESETS[key];
          if (key === "custom" || !preset) {
            setShowCustom(true);
          } else {
            setShowCustom(false);
            setEditorScheme(preset.template);
          }
        }}
        className="bg-surface-secondary border border-border-default rounded px-1.5 py-0.5 text-2xs text-text-primary"
      >
        {Object.entries(EDITOR_PRESETS).map(([key, { label }]) => (
          <option key={key} value={key}>{label}</option>
        ))}
        <option value="custom">Custom...</option>
      </select>
      {showCustom && (
        <input
          type="text"
          placeholder="scheme://file/{path}:{line}"
          value={customTemplate}
          onChange={(e) => setCustomTemplate(e.target.value)}
          onBlur={() => setEditorScheme(customTemplate)}
          onKeyDown={(e) => { if (e.key === "Enter") setEditorScheme(customTemplate); }}
          className="flex-1 bg-surface-secondary border border-border-default rounded px-1.5 py-0.5 text-2xs text-text-primary"
        />
      )}
    </div>
  );
}
