import { useState } from 'react'
import { useStore } from '../state'

/** Link box plus file/folder pickers — the main way mods get added. */
export function AddBar(): JSX.Element {
  const [url, setUrl] = useState('')
  const addSource = useStore((s) => s.addSource)
  const staging = useStore((s) => s.staging)
  const scanFolder = useStore((s) => s.scanFolder)

  const submit = async (): Promise<void> => {
    const value = url.trim()
    if (!value) return
    setUrl('')
    await addSource(value)
  }

  const pickFiles = async (): Promise<void> => {
    const files = await window.palmod.add.pickFiles()
    for (const f of files) await addSource(f)
  }

  const pickFolder = async (): Promise<void> => {
    const folder = await window.palmod.add.pickFolder()
    if (folder) await scanFolder(folder)
  }

  return (
    <div className="addbar">
      <div className="url-field">
        <span aria-hidden>🔗</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder="Paste a mod link, or drop a zip / folder anywhere in this window"
          spellCheck={false}
          aria-label="Mod link"
        />
        <button className="btn primary" onClick={() => void submit()} disabled={staging || !url.trim()}>
          {staging ? 'Working…' : 'Add mod'}
        </button>
      </div>

      <button className="btn" onClick={() => void pickFiles()} disabled={staging}>
        📄 Choose files
      </button>
      <button className="btn" onClick={() => void pickFolder()} disabled={staging}>
        📁 Scan a folder
      </button>
    </div>
  )
}
