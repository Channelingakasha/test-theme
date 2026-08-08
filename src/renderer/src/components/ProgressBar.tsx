interface Props {
  label: string
  /** 0..1, or -1 for indeterminate. */
  value: number
}

export function ProgressBar({ label, value }: Props): JSX.Element {
  const indeterminate = value < 0
  return (
    <div className="stack" style={{ gap: 9 }}>
      <div className="row small muted">
        <span>{label}</span>
        <span className="spacer" />
        {!indeterminate && <span>{Math.round(value * 100)}%</span>}
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill ${indeterminate ? 'indeterminate' : ''}`}
          style={{ width: indeterminate ? undefined : `${Math.max(2, value * 100)}%` }}
        />
      </div>
    </div>
  )
}
