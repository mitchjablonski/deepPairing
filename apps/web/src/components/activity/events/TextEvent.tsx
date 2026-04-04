export function TextEvent({ content }: { content: string }) {
  return (
    <div className="px-3 py-1.5 text-sm text-text-primary whitespace-pre-wrap">
      {content}
    </div>
  );
}
