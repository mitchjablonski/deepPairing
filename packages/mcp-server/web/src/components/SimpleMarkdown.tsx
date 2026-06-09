/**
 * Lightweight markdown renderer for artifact text.
 * Handles: **bold**, `code`, \n\n paragraphs, \n line breaks,
 * numbered lists, bullet lists, and | tables |.
 * No external dependencies.
 */

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match **bold**, `code`, or plain text
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      // **bold**
      parts.push(<strong key={match.index} className="font-semibold text-text-primary">{match[2]}</strong>);
    } else if (match[3]) {
      // `code`
      parts.push(<code key={match.index} className="px-1 py-0.5 bg-surface-code rounded text-accent-cyan font-mono text-[11px]">{match[3]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s-:|]+\|$/.test(line.trim());
}

export function SimpleMarkdown({ text, className }: { text?: string | null; className?: string }) {
  // Tolerate missing text: callers pass artifact content fields (objective,
  // action, reasoning, …) cast unchecked from the store, so any of them can be
  // undefined on a partial/legacy artifact. Pre-this, `text.split(...)` threw
  // and crashed the whole renderer. Nothing to render → render nothing.
  if (!text) return null;
  // Split into paragraphs on double newlines
  const paragraphs = text.split(/\n\n+/);

  return (
    <div className={className ?? "text-xs text-text-secondary space-y-2"}>
      {paragraphs.map((para, pi) => {
        const lines = para.split("\n");

        // Check if this paragraph is a table
        if (lines.length >= 2 && lines.every((l) => isTableRow(l) || isTableSeparator(l))) {
          const dataRows = lines.filter((l) => !isTableSeparator(l));
          return (
            <div key={pi} className="overflow-x-auto">
              <table className="text-2xs border-collapse">
                <tbody>
                  {dataRows.map((row, ri) => {
                    const cells = row.split("|").filter((c) => c.trim() !== "");
                    return (
                      <tr key={ri} className={ri === 0 ? "font-semibold text-text-primary" : ""}>
                        {cells.map((cell, ci) => (
                          <td key={ci} className="px-2 py-1 border border-border-subtle">
                            {renderInline(cell.trim())}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }

        // Check if this paragraph is a numbered or bullet list
        const isNumberedList = lines.every((l) => /^\d+\.\s/.test(l.trim()) || l.trim() === "");
        const isBulletList = lines.every((l) => /^[-*]\s/.test(l.trim()) || l.trim() === "");

        if (isNumberedList || isBulletList) {
          return (
            <ol key={pi} className={`space-y-1 ${isNumberedList ? "list-decimal" : "list-disc"} pl-4`}>
              {lines.filter((l) => l.trim()).map((line, li) => (
                <li key={li}>{renderInline(line.replace(/^\d+\.\s|^[-*]\s/, ""))}</li>
              ))}
            </ol>
          );
        }

        // Regular paragraph — render inline formatting + line breaks
        return (
          <p key={pi}>
            {lines.map((line, li) => (
              <span key={li}>
                {renderInline(line)}
                {li < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
