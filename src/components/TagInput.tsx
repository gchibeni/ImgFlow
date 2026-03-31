import { useState, useRef, useEffect, useCallback } from 'react';

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  maxTags?: number;
}

export default function TagInput({
  tags,
  onChange,
  suggestions,
  placeholder = 'Type to add tags...',
  maxTags = 3,
}: TagInputProps) {
  const [input, setInput] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [dragState, setDragState] = useState<{
    fromIndex: number;
    overIndex: number | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tagRefs = useRef<(HTMLDivElement | null)[]>([]);

  const filtered = suggestions.filter(
    (s) =>
      s.toLowerCase().includes(input.toLowerCase()) &&
      !tags.includes(s)
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function addTag(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed || tags.length >= maxTags) return;
    if (!tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput('');
    setShowDropdown(false);
    inputRef.current?.focus();
  }

  function removeTag(index: number) {
    onChange(tags.filter((_, i) => i !== index));
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (input.trim()) {
        addTag(input);
      } else {
        setShowDropdown((prev) => !prev);
      }
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags.length - 1);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  }

  // Pointer-based drag reorder
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, index: number) => {
      // Only left button
      if (e.button !== 0) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragState({ fromIndex: index, overIndex: index });
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState) return;
      // Find which tag the pointer is over
      const x = e.clientX;
      const y = e.clientY;
      for (let i = 0; i < tagRefs.current.length; i++) {
        const el = tagRefs.current[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          if (dragState.overIndex !== i) {
            setDragState({ ...dragState, overIndex: i });
          }
          break;
        }
      }
    },
    [dragState]
  );

  const handlePointerUp = useCallback(() => {
    if (!dragState) return;
    const { fromIndex, overIndex } = dragState;
    if (overIndex !== null && fromIndex !== overIndex) {
      const newTags = [...tags];
      const [moved] = newTags.splice(fromIndex, 1);
      newTags.splice(overIndex, 0, moved);
      onChange(newTags);
    }
    setDragState(null);
  }, [dragState, tags, onChange]);

  // Build display order for visual feedback
  const displayTags = (() => {
    if (!dragState || dragState.overIndex === null || dragState.fromIndex === dragState.overIndex) {
      return tags.map((tag, i) => ({ tag, originalIndex: i }));
    }
    const { fromIndex, overIndex } = dragState;
    const reordered = [...tags];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(overIndex, 0, moved);
    return reordered.map((tag, i) => ({ tag, originalIndex: i }));
  })();

  return (
    <div ref={containerRef} className="relative">
      <div
        className="flex flex-wrap items-center gap-1.5 min-h-[44px] px-3 py-2 bg-white border border-gray-200 rounded-xl cursor-text transition-colors focus-within:border-[#8a9d78]"
        onClick={() => inputRef.current?.focus()}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {displayTags.map(({ tag }, displayIndex) => (
          <div
            key={`tag-${displayIndex}`}
            ref={(el) => { tagRefs.current[displayIndex] = el; }}
            className="tag-chip"
            style={{
              opacity:
                dragState && dragState.fromIndex === displayIndex ? 0.5 : 1,
              cursor: dragState ? 'grabbing' : 'grab',
            }}
            onPointerDown={(e) => handlePointerDown(e, displayIndex)}
            title={tag}
          >
            {tag.length > 30 ? `${tag.slice(0, 30)}...` : tag}
            <span
              className="tag-remove"
              onClick={(e) => {
                e.stopPropagation();
                // Find actual index from original tags
                const actualIndex = tags.indexOf(tag);
                if (actualIndex >= 0) removeTag(actualIndex);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              ×
            </span>
          </div>
        ))}
        {tags.length < maxTags && (
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setShowDropdown(true);
            }}
            onBlur={() => setShowDropdown(false)}
            onKeyDown={handleKeyDown}
            placeholder={tags.length === 0 ? placeholder : ''}
            className="flex-1 min-w-[100px] outline-none bg-transparent text-sm"
          />
        )}
      </div>

      {showDropdown && filtered.length > 0 && (
        <div className="dropdown-menu">
          {filtered.map((item) => (
            <div
              key={item}
              className="dropdown-item"
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(item);
              }}
              title={item}
            >
              {item.length > 30 ? `${item.slice(0, 30)}...` : item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
