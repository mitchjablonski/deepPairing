export function ErrorEvent({ message }: { message: string }) {
  return (
    <div className="mx-3 my-2 p-3 bg-accent-red-dim border border-accent-red/20 rounded-lg text-sm text-accent-red">
      <div className="text-xs font-semibold mb-1">Error</div>
      {message}
    </div>
  );
}
