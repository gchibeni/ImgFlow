export default function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <div className="spinner" />
      {label && <p className="text-sm text-gray-500 font-medium">{label}</p>}
    </div>
  );
}
