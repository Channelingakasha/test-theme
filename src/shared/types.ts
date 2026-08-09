/**
 * Types shared between the Electron main process and the renderer.
 * The preload bridge is typed against these, so both sides stay in sync.
 */

/** Where a mod's files ultimately live inside the Palworld install. */
export type ModKind =
  | 'pak' // cooked content: .pak / .ucas / .utoc  -> Pal/Content/Paks/~mods
  | 'logicmod' // blueprint mod (needs UE4SS BPModLoader) -> Pal/Content/Paks/LogicMods
  | 'ue4ss-lua' // script mod -> Pal/Binaries/Win64/ue4ss/Mods/<Name>
  | 'ue4ss-dll' // native C++ mod -> Pal/Binaries/Win64/ue4ss/Mods/<Name>/dlls
  | 'ue4ss-core' // UE4SS itself -> Pal/Binaries/Win64
  | 'save' // save-game / config payloads -> %LOCALAPPDATA%/Pal/Saved
  | 'unknown'

export type InstallState = 'enabled' | 'disabled'

export type GameEdition = 'steam' | 'xbox' | 'epic' | 'manual'

export interface GameInstall {
  /** Root folder that contains Palworld.exe / the Pal folder. */
  root: string
  edition: GameEdition
  /** Absolute path of Pal/Content/Paks. */
  paksDir: string
  /** Absolute path of Pal/Content/Paks/~mods. */
  modsDir: string
  /** Absolute path of Pal/Content/Paks/LogicMods. */
  logicModsDir: string
  /** Absolute path of Pal/Binaries/Win64. */
  binariesDir: string
  /** Absolute path of the UE4SS Mods folder in use (3.x or legacy layout). */
  ue4ssModsDir: string
  ue4ssInstalled: boolean
  ue4ssVersion?: string
  valid: boolean
}

/** One file this mod owns, recorded so uninstall/disable is exact. */
export interface InstalledFile {
  /** Absolute path where the file currently lives (or would live when enabled). */
  dest: string
  /** Path relative to the mod's staged payload, for display. */
  rel: string
  size: number
  sha1: string
  /** True when this file was already present and we backed it up before overwriting. */
  backedUp?: boolean
  backupPath?: string
}

/**
 * A selectable variant. Character/skin mods frequently ship several mutually
 * exclusive .pak files ("Optional", "Variants", colour choices, body types).
 */
export interface ModOption {
  id: string
  label: string
  /** Files (relative to the staged payload) this option installs. */
  files: string[]
  /**
   * Absolute destination for each entry in `files`, filled in at install time.
   * Every option's files are kept in the vault, so a variant can be switched
   * on later without re-downloading the mod.
   */
  dests?: string[]
  previewImage?: string
  /** Options in the same group are mutually exclusive. */
  group: string
  recommended?: boolean
}

export type SettingControl = 'toggle' | 'number' | 'text' | 'select' | 'key'

/** A single tweakable value discovered inside a mod's own config file. */
export interface ModSetting {
  key: string
  label: string
  control: SettingControl
  value: string | number | boolean
  defaultValue: string | number | boolean
  options?: string[]
  min?: number
  max?: number
  comment?: string
  /** Absolute path of the config file this setting lives in. */
  file: string
  /** Parser dialect, so we can write the value back in the same shape. */
  format: 'lua' | 'ini' | 'json' | 'txt'
  /** Line index within the file (for lua/ini/txt round-tripping). */
  line?: number
}

export interface HowToUse {
  /** Prose directions pulled from the mod page / README. */
  directions: string[]
  /** Key -> action, discovered in Lua source, configs, or the mod page. */
  hotkeys: { key: string; action: string }[]
  /** Short tips & gotchas. */
  tips: string[]
  /** Requirements the mod stated (UE4SS, other mods, game version). */
  requirements: string[]
  source?: string
}

export interface ModMeta {
  name: string
  author?: string
  version?: string
  description?: string
  /** Preview photo — the image used on the mod's own page, cached locally. */
  image?: string
  /**
   * Screenshots pulled from the mod's page, cached locally and ordered
   * largest first. Shown as a gallery on the mod's info page.
   */
  gallery?: string[]
  sourceUrl?: string
  category?: string
  tags: string[]
}

export interface Mod {
  id: string
  meta: ModMeta
  kind: ModKind
  state: InstallState
  /** Absolute install roots this mod wrote into, for the "file path" panel. */
  installRoots: string[]
  files: InstalledFile[]
  options: ModOption[]
  selectedOptionIds: string[]
  settings: ModSetting[]
  howTo: HowToUse
  /** Load-order key for pak mods (alphabetical load, so prefix matters). */
  loadOrder: number
  installedAt: number
  updatedAt: number
  /**
   * What this mod changes in game, read from the cooked assets in its paks.
   * Undefined means it hasn't been analysed yet; an empty array means it was
   * analysed and nothing could be determined (an unreadable or script-only mod).
   */
  targets?: ModTarget[]
  /** Set when the mod was adopted from a pre-existing folder rather than installed by us. */
  adopted?: boolean
  sizeBytes: number
  notes?: string
}

/** The kind of game content a mod changes, derived from its cooked assets. */
export type ModTargetKind =
  | 'player'
  | 'pal'
  | 'weapon'
  | 'building'
  | 'item'
  | 'ui'
  | 'data'
  | 'audio'
  | 'map'
  | 'effect'
  | 'other'

export interface ModTarget {
  kind: ModTargetKind
  /** Human-readable name, e.g. "Cattiva (PinkCat)" or "Your player character". */
  label: string
  /** How many cooked assets fall under this target. */
  assetCount: number
  /** A few example asset paths, for the details view. */
  examples: string[]
}

export type ConflictSeverity = 'blocking' | 'warning' | 'info'

export type ConflictType =
  | 'file-collision' // two mods write the exact same destination file
  | 'asset-overlap' // two paks contain the same cooked asset
  | 'duplicate-mod' // same mod (or a different version of it) already installed
  | 'hotkey-clash' // two script mods bind the same key
  | 'hook-clash' // two script mods hook the same UFunction
  | 'missing-requirement' // needs UE4SS / BPModLoader that isn't present
  | 'load-order' // ordering decides the winner; surfaced so it can be changed
  | 'option-exclusive' // two selected options of the same mod are exclusive

export interface Conflict {
  type: ConflictType
  severity: ConflictSeverity
  message: string
  /** Ids of already-installed mods involved. */
  withModIds: string[]
  /** Human-readable details: the colliding paths / assets / keys. */
  details: string[]
  /** Suggested resolutions the UI can offer. */
  resolutions: ConflictResolution[]
}

export type ConflictResolution =
  | 'overwrite'
  | 'skip'
  | 'keep-both'
  | 'replace-existing'
  | 'install-anyway'
  | 'raise-load-order'
  | 'lower-load-order'
  | 'cancel'

/** Result of inspecting a source before anything is written to the game folder. */
export interface StagedMod {
  stageId: string
  /** Temp folder holding the extracted payload. */
  stageDir: string
  meta: ModMeta
  kind: ModKind
  options: ModOption[]
  suggestedOptionIds: string[]
  settings: ModSetting[]
  howTo: HowToUse
  conflicts: Conflict[]
  /** Every file we would write, with its resolved destination. */
  plan: { rel: string; dest: string; size: number }[]
  sizeBytes: number
  /** Files we could not classify and will not install unless forced. */
  unhandled: string[]
}

export interface AddSourceRequest {
  /** A URL, or an absolute path to a .zip/.rar/.7z, a loose file, or a folder. */
  source: string
  kind: 'url' | 'path'
}

export interface Progress {
  id: string
  label: string
  phase: 'download' | 'extract' | 'scan' | 'install' | 'done' | 'error'
  /** 0..1, or -1 when indeterminate. */
  value: number
  detail?: string
}

export interface AppSettings {
  gameRoot?: string
  /** Extra folders to watch for already-installed mods (e.g. a Desktop folder). */
  watchFolders: string[]
  backupBeforeOverwrite: boolean
  autoResolveSafeConflicts: boolean
  theme: 'dark'
  lastAdoptFolder?: string
}

/** A possible match for a mod, found by searching the web for its name. */
export interface LookupCandidate {
  url: string
  title: string
  /** Host the result came from, e.g. "nexusmods.com". */
  source: string
  description?: string
  /** Locally cached preview image, ready for the renderer to display. */
  image?: string
  /** 0..1 — how well this result matches the mod we're looking up. */
  score: number
}

export interface AdoptCandidate {
  path: string
  suggestedName: string
  kind: ModKind
  fileCount: number
  sizeBytes: number
  /** True when this path is already tracked by a known mod. */
  alreadyTracked: boolean
}
