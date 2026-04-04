export function ResultEvent({ content }: { content: string }) {
  return (
    <div className="mx-3 my-2 p-3 bg-accent-green-dim border border-accent-green/20 rounded-lg text-sm text-text-primary whitespace-pre-wrap">
      <div className="text-xs font-semibold text-accent-green mb-1.5">Result</div>
      {content}
    </div>
  );
}
