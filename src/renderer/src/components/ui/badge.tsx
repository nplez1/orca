import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        dot: 'bg-background text-foreground border-border shadow-xs dark:bg-secondary dark:border-white/20',
        destructive:
          'bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90',
        outline:
          'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
        /** The chip naming the machine a workspace runs on — quieter and squarer than `secondary`,
         *  so it reads as context beside a workspace name rather than as a status of its own. */
        hostContext:
          'h-4 rounded border-border bg-accent px-1.5 text-[10px] leading-none text-muted-foreground dark:border-border/50 dark:bg-accent/80',
        /** Status tones for the compact meta pill shown beside a workspace's review details.
         *  Sizing lives in the variant (like `hostContext`) because a state pill may not be
         *  repainted by hand — its colour is the one signal a reader trusts without reading
         *  the label, so the tone and the size that makes it legible travel together. */
        statusSuccess:
          'h-4 gap-1 rounded border-status-success-border bg-status-success-background px-1.5 text-[9px] font-medium leading-none text-status-success [&>svg]:size-2.5',
        statusWarning:
          'h-4 gap-1 rounded border-status-warning-border bg-status-warning-background px-1.5 text-[9px] font-medium leading-none text-status-warning [&>svg]:size-2.5',
        statusDanger:
          'h-4 gap-1 rounded border-destructive/25 bg-destructive/5 px-1.5 text-[9px] font-medium leading-none text-destructive [&>svg]:size-2.5'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
