interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  singleButton?: boolean;
}

export default function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  singleButton = false,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 max-w-sm w-[90%] shadow-xl">
        <p className="text-center text-[15px] font-medium mb-6">{message}</p>
        <div className="flex gap-3 justify-center">
          {!singleButton && (
            <button className="btn btn-secondary" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button className="btn btn-primary" onClick={onConfirm}>
            {singleButton ? 'OK' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
