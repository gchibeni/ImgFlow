import { useState, useRef } from 'react';

interface TooltipProps {
  content: React.ReactNode;
}

export default function Tooltip({ content }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  function show() {
    clearTimeout(timeoutRef.current);
    setVisible(true);
  }

  function hide() {
    timeoutRef.current = setTimeout(() => setVisible(false), 150);
  }

  return (
    <span className="relative inline-flex items-center ml-1">
      <span
        className="inline-flex items-center justify-center w-[16px] h-[16px] rounded-full bg-gray-200 text-gray-500 text-[10px] font-bold cursor-help leading-none"
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        i
      </span>
      {visible && (
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 min-w-[16rem] max-w-xs bg-[#29302f] text-white text-xs rounded-lg p-3 shadow-lg z-50 leading-relaxed break-words"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {content}
          <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-[#29302f]" />
        </div>
      )}
    </span>
  );
}
