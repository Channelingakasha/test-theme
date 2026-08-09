import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RescanResult, TableName, TableRow, ValidationResult } from '@shared/types'
import { humanSize } from '../lib/format'
import { useStore } from '../state'

const TABS: { id: TableName; label: string; hint: string }[] = [
  { id: 'mods', label: 'Mods', hint: 'Every installed mod as PalMod stores it' },
  { id: 'profiles', label: 'Profiles', hint: 'Saved mod loadouts' },
  { id: 'settings', label: 'Settings', hint: 'Application configuration' }
]

function formatCell(key: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (key === 'size' && typeof value === 'number') return humanSize(value)
  return String(value)
}

/** Profile controls, shown above the grid on the Profiles tab. */
function ProfileActions({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useStore((s) => s.toast)

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const profile = await window.palmod.profiles.create(name.trim(), true)
      setName('')
      toast(`Profile "${profile.name}" saved from your current setup`, 'success')
      onChanged()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row wrap" style={{ marginBottom: 18 }}>
      <input
        className="input"
        style={{ flex: '1 1 240px' }}
        value={name}
        placeholder="New profile name…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create()
        }}
      />
      <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void create()}>
        Save current setup as profile
      </button>
      <span className="small muted">
        Captures which mods are switched on right now.
      </span>
    </div>
  )
}

export function EditView(): JSX.Element {
  const [table, setTable] = useState<TableName>('mods')
  const [rows, setRows] = useState<TableRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [rescanPrompt, setRescanPrompt] = useState(false)
  const [rescanning, setRescanning] = useState(false)

  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (which: TableName, keepSelection = false): Promise<void> => {
      try {
        const next = await window.palmod.db.table(which)
        setRows(next)
        if (!keepSelection) {
          setSelectedId(next[0]?.id ?? null)
          setText(next[0] ? JSON.stringify(next[0].record, null, 2) : '')
          setDirty(false)
          setValidation(null)
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    },
    [toast]
  )

  useEffect(() => {
    void load(table)
  }, [table, load])

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId])

  const select = (row: TableRow): void => {
    if (dirty && !confirm('Discard your unsaved changes to this record?')) return
    setSelectedId(row.id)
    setText(JSON.stringify(row.record, null, 2))
    setDirty(false)
    setValidation(null)
  }

  /** Validation runs as you type, debounced, so errors show before saving. */
  const onEdit = (value: string): void => {
    setText(value)
    setDirty(true)
    if (validateTimer.current) clearTimeout(validateTimer.current)
    validateTimer.current = setTimeout(() => {
      if (!selectedId) return
      void window.palmod.db
        .validate(table, selectedId, value)
        .then(setValidation)
        .catch(() => setValidation(null))
    }, 300)
  }

  const save = async (): Promise<void> => {
    if (!selectedId) return
    setSaving(true)
    try {
      const result = await window.palmod.db.save(table, selectedId, text)
      setValidation(result)
      if (!result.ok) {
        toast('Not saved — fix the errors listed below', 'error')
        return
      }
      setDirty(false)
      await load(table, true)
      await refresh()
      toast('Record saved', 'success')
      setRescanPrompt(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const doRescan = async (): Promise<void> => {
    setRescanning(true)
    try {
      const result: RescanResult = await window.palmod.db.rescan()
      await load(table, true)
      await refresh()
      const bits = [`${result.checked} mod${result.checked === 1 ? '' : 's'} checked`]
      if (result.corrected.length) bits.push(`${result.corrected.length} corrected`)
      if (result.missingFiles.length) bits.push(`${result.missingFiles.length} missing files`)
      toast(bits.join(' · '), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setRescanning(false)
      setRescanPrompt(false)
    }
  }

  const applyProfile = async (id: string): Promise<void> => {
    try {
      const result = await window.palmod.profiles.apply(id)
      await refresh()
      await load('profiles', true)
      toast(`Profile applied — ${result.enabled} on, ${result.disabled} off`, 'success')
      if (result.failed.length) toast(`${result.failed.length} mod(s) failed to switch`, 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const removeProfile = async (id: string): Promise<void> => {
    try {
      await window.palmod.profiles.remove(id)
      await load('profiles')
      toast('Profile deleted', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // Column names come from the data; an empty table falls back to the shape it
  // will have, so the header isn't a lone stray column.
  const FALLBACK_COLUMNS: Record<TableName, string[]> = {
    mods: ['name', 'kind', 'state', 'version', 'files'],
    profiles: ['name', 'mods', 'active', 'updated'],
    settings: ['gameRoot', 'backups', 'theme']
  }
  const columns = rows[0] ? Object.keys(rows[0].columns) : FALLBACK_COLUMNS[table]
  const activeTab = TABS.find((t) => t.id === table)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Edit</h1>
          <div className="subtitle">{activeTab?.hint}</div>
        </div>
        <div className="filter-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`filter-tab ${table === t.id ? 'active' : ''}`}
              onClick={() => {
                if (dirty && !confirm('Discard your unsaved changes?')) return
                setTable(t.id)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {table === 'profiles' && <ProfileActions onChanged={() => void load('profiles')} />}

      <div className="edit-layout">
        <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="grid-scroll">
            <table className="data-grid">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                  {table === 'profiles' && <th>actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.id === selectedId ? 'selected' : ''}
                    onClick={() => select(row)}
                  >
                    {columns.map((c) => (
                      <td key={c}>{formatCell(c, row.columns[c])}</td>
                    ))}
                    {table === 'profiles' && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn sm" onClick={() => void applyProfile(row.id)}>
                            Apply
                          </button>
                          <button className="btn sm danger" onClick={() => void removeProfile(row.id)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={Math.max(1, columns.length)} className="muted" style={{ padding: 26 }}>
                      Nothing in this table yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{selected ? `Raw record — ${selected.label}` : 'Raw record'}</h2>
            {dirty && <span className="badge warn">Unsaved</span>}
          </div>

          {selected ? (
            <>
              <textarea
                className="json-editor"
                spellCheck={false}
                value={text}
                onChange={(e) => onEdit(e.target.value)}
                aria-label="Raw JSON record"
              />

              {validation && (
                <div className={`validation ${validation.ok ? 'ok' : 'bad'}`}>
                  {validation.ok ? (
                    <span>✓ Valid — safe to save</span>
                  ) : (
                    <div className="stack" style={{ gap: 5 }}>
                      {validation.errors.map((e) => (
                        <div key={e}>• {e}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="row" style={{ marginTop: 16 }}>
                <button
                  className="btn primary"
                  disabled={saving || !dirty || validation?.ok === false}
                  onClick={() => void save()}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
                <button
                  className="btn ghost"
                  disabled={!dirty}
                  onClick={() => {
                    setText(JSON.stringify(selected.record, null, 2))
                    setDirty(false)
                    setValidation(null)
                  }}
                >
                  Revert
                </button>
                <span className="spacer" />
                <button className="btn" disabled={rescanning} onClick={() => void doRescan()}>
                  {rescanning ? 'Re-scanning…' : '🔄 Re-scan mod folder'}
                </button>
              </div>
            </>
          ) : (
            <div className="muted small">Select a row to edit its record.</div>
          )}
        </section>
      </div>

      {rescanPrompt && (
        <div className="modal-backdrop" onClick={() => setRescanPrompt(false)}>
          <div className="modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Record saved</h2>
              <div className="subtitle">
                Re-scan the mod folder now so the library matches what's actually on disk?
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setRescanPrompt(false)} disabled={rescanning}>
                Later
              </button>
              <button className="btn primary" onClick={() => void doRescan()} disabled={rescanning}>
                {rescanning ? 'Re-scanning…' : 'Re-scan now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
