import { useCodeStore } from "../stores/code";

const changeTypeIndicator = {
  create: { label: "A", color: "bg-green-500" },
  modify: { label: "M", color: "bg-amber-500" },
  delete: { label: "D", color: "bg-red-500" },
};

export function ChangesList() {
  const { changes, selectedFile, selectFile } = useCodeStore();

  // Group changes by file, keeping last change per file
  const fileMap = new Map<string, typeof changes[0]>();
  for (const change of changes) {
    fileMap.set(change.filePath, change);
  }
  const files = Array.from(fileMap.entries());

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
        Changed Files ({files.length})
      </div>
      <div className="max-h-40 overflow-y-auto">
        {files.map(([filePath, change]) => {
          const indicator = changeTypeIndicator[change.changeType];
          const isSelected = filePath === selectedFile;
          const fileName = filePath.split("/").pop();
          const dirPath = filePath.split("/").slice(0, -1).join("/");

          return (
            <button
              key={filePath}
              onClick={() => selectFile(filePath)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-100 transition-colors ${
                isSelected ? "bg-blue-50 border-l-2 border-blue-500" : ""
              }`}
            >
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded text-white text-[10px] font-bold ${indicator.color}`}>
                {indicator.label}
              </span>
              <span className="truncate">
                <span className="font-medium text-gray-800">{fileName}</span>
                {dirPath && (
                  <span className="text-gray-400 ml-1">{dirPath}/</span>
                )}
              </span>
              {change.reasoning && (
                <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-violet-400" title="Has reasoning" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
