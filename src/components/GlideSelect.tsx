import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import './GlideSelect.css';

export interface GlideSelectOption {
  value: string;
  label: string;
  tag?: string;
}

interface GlideSelectProps {
  options: readonly GlideSelectOption[];
  value: string;
  onChange: (value: string) => void;
  labelledBy: string;
  describedBy?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
}

export function GlideSelect({
  options,
  value,
  onChange,
  labelledBy,
  describedBy,
  placeholder = 'Choisir une option…',
  disabled = false,
  required = false,
  invalid,
}: GlideSelectProps) {
  const id = useId();
  const listId = `${id}-options`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ query: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [side, setSide] = useState<'top' | 'bottom'>('bottom');
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const isInvalid = invalid ?? (required && selectedIndex < 0);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', handleOutsidePointer, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (trigger && menu) {
      const rect = trigger.getBoundingClientRect();
      const menuHeight = Math.min(menu.scrollHeight, 288);
      const roomBelow = window.innerHeight - rect.bottom;
      setSide(roomBelow < menuHeight + 12 && rect.top > roomBelow ? 'top' : 'bottom');
    }
    if (active !== null) {
      document.getElementById(`${listId}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [active, listId, open, options.length]);

  const showOptions = (startAt = selectedIndex >= 0 ? selectedIndex : 0) => {
    setActive(options.length > 0 ? Math.min(startAt, options.length - 1) : null);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || disabled) return;
    onChange(option.value);
    setOpen(false);
    setActive(index);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const handleTypeahead = (key: string) => {
    if (options.length === 0) return;
    const now = Date.now();
    const normalizedKey = key.toLocaleLowerCase();
    const priorQuery = now - typeahead.current.at < 650 ? typeahead.current.query : '';
    const nextQuery = `${priorQuery}${normalizedKey}`;
    const search = nextQuery.length > 1 && [...nextQuery].every((character) => character === normalizedKey)
      ? normalizedKey
      : nextQuery;
    const startAt = active ?? selectedIndex;
    const match = Array.from({ length: options.length }, (_, offset) => {
      const index = ((startAt + offset + 1) % options.length + options.length) % options.length;
      return index;
    }).find((index) => options[index].label.toLocaleLowerCase().startsWith(search));
    typeahead.current = { query: search, at: now };
    if (match === undefined) return;
    setOpen(true);
    setActive(match);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const lastIndex = options.length - 1;
    const currentIndex = active ?? (selectedIndex >= 0 ? selectedIndex : 0);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      if (!open) {
        showOptions(event.key === 'ArrowUp' && selectedIndex < 0 ? lastIndex : undefined);
        return;
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActive((currentIndex + direction + options.length) % options.length);
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      if (options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive(event.key === 'Home' ? 0 : lastIndex);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && active !== null) choose(active);
      else showOptions();
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      setActive(selectedIndex >= 0 ? selectedIndex : null);
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }

    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      handleTypeahead(event.key);
    }
  };

  return (
    <div ref={rootRef} className="glide-select" data-open={open ? 'true' : undefined} data-side={side}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-autocomplete="none"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active !== null ? `${listId}-option-${active}` : undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-required={required || undefined}
        aria-invalid={isInvalid || undefined}
        disabled={disabled}
        className="glide-select__trigger"
        onClick={() => (open ? setOpen(false) : showOptions())}
        onKeyDown={handleKeyDown}
      >
        <span className="glide-select__value">
          <span className="glide-select__name">{selected?.label ?? (value || placeholder)}</span>
          {selected?.tag && <span className="glide-select__tag">{selected.tag}</span>}
        </span>
        <ChevronDown className="glide-select__chevron" size={17} aria-hidden="true" />
      </button>

      {open && (
        <div ref={menuRef} id={listId} role="listbox" aria-labelledby={labelledBy} className="glide-select__menu">
          {options.length > 0 ? options.map((option, index) => (
            <div
              key={option.value}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              data-active={index === active ? 'true' : undefined}
              className="glide-select__option"
              onPointerMove={(event) => {
                if (event.pointerType === 'mouse') setActive(index);
              }}
              onClick={() => choose(index)}
            >
              <span className="glide-select__option-copy">
                <span className="glide-select__name">{option.label}</span>
                {option.tag && <span className="glide-select__tag">{option.tag}</span>}
              </span>
              <Check size={15} className="glide-select__check" aria-hidden="true" />
            </div>
          )) : (
            <p className="glide-select__empty">Aucune version vérifiée disponible.</p>
          )}
        </div>
      )}
    </div>
  );
}
