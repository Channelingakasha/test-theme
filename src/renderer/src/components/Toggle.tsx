import { useState } from 'react'

interface Props {
  on: boolean
  onChange: (next: boolean) => void | Promise<void>
  label?: string
}

/** Pill switch used on cards and in the detail header. */
export function Toggle({ on, onChange, label }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)

  const handle = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      await onChange(!on)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label ?? (on ? 'Deactivate mod' : 'Activate mod')}
      className={`switch ${on ? 'on' : ''} ${busy ? 'busy' : ''}`}
      onClick={handle}
    />
  )
}
