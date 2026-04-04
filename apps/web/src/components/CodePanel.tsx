import { useCodeStore } from "../stores/code";
import { ChangesList } from "./ChangesList";
import { DiffViewer } from "./DiffViewer";

export function CodePanel() {
  const { changes, selectedFile } = useCodeStore();

  if (changes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400">
        Code changes will appear here
      </div>
    );
  }

  const selectedChange = changes.find((c) => c.filePath === selectedFile);
  // If multiple changes to same file, show the latest
  const latestForFile = selectedFile
    ? [...changes].reverse().find((c) => c.filePath === selectedFile)
    : undefined;
  const displayChange = latestForFile ?? selectedChange ?? changes[0];

  return (
    <div className="flex flex-col h-full">
      <ChangesList />
      {displayChange && (
        <div className="flex-1 min-h-0">
          <DiffViewer change={displayChange} />
        </div>
      )}
    </div>
  );
}
