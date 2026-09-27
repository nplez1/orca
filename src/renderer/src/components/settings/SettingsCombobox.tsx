import { useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type SettingsComboboxOption = {
  value: string
  label: string
}

// Why: cmdk cannot select an item whose value is the empty string, so "none" needs
// its own value; callers map it back to whatever "unset" means for their setting.
export const SETTINGS_COMBOBOX_NONE = '__none__'

type SettingsComboboxProps = {
  id: string
  value: string
  onValueChange: (value: string) => void
  options: SettingsComboboxOption[]
  placeholder: string
  searchPlaceholder: string
  emptyMessage: string
  disabled?: boolean
  // Why: a Jira site can expose thousands of boards and hundreds of fields, so the
  // picker never filters on its own — the caller decides what the list contains.
  onSearchChange?: (query: string) => void
}

/** Single-select picker for settings lists too long for a Select. */
export function SettingsCombobox({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  disabled = false,
  onSearchChange
}: SettingsComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = options.find((option) => option.value === value)

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      // Why: the search text drives a server query; reopening must start clean.
      onSearchChange?.('')
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
        >
          <span className={cn('min-w-0 truncate', selected ? null : 'text-muted-foreground')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)]"
        onOpenAutoFocus={(event) => {
          // Why: cmdk owns list keyboard navigation, so focus its input rather than
          // the popover content.
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            placeholder={searchPlaceholder}
            onValueChange={(query) => onSearchChange?.(query)}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                onSelect={() => {
                  onValueChange(option.value)
                  handleOpenChange(false)
                }}
              >
                <Check
                  className={cn(
                    'size-3.5 text-foreground',
                    option.value === value ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
