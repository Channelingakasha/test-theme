# PalMod

A desktop mod manager for Palworld. Give it a link, a zip, a folder or a loose
file — it works out what kind of mod it is, checks for conflicts with what you
already have, and puts the files where the game actually reads them.

![built with Electron + React](https://img.shields.io/badge/Electron-33-2b2e3a) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-2b2e3a)

## What it does

**Add mods from anywhere.** Paste a mod page link, drop a `.zip` / `.7z` /
`.rar` anywhere in the window, pick loose files, or point it at a folder. When
you give it a link it pulls the mod's title, description and preview photo from
the page, and grabs the readme so the app can tell you how to use the mod.

**Puts files in the right place, automatically.** Different Palworld mods live
in completely different folders, and putting one in the wrong place just makes
it silently not work. PalMod reads the contents and routes each file:

| What it finds | Where it goes |
| --- | --- |
| `.pak` / `.ucas` / `.utoc` | `Pal/Content/Paks/~mods` |
| Blueprint mods | `Pal/Content/Paks/LogicMods` |
| Lua script mods | `Pal/Binaries/Win64/ue4ss/Mods/<Mod>` |
| Native `.dll` mods | `…/ue4ss/Mods/<Mod>/dlls` |
| UE4SS itself | `Pal/Binaries/Win64` |
| Save data | `%LOCALAPPDATA%/Pal/Saved` |

**Real conflict detection.** Before anything is written, PalMod compares the
incoming mod against your library and tells you what will actually break:

- **File collisions** — two mods writing the same file.
- **Asset overlap** — it reads the *index inside* `.pak` files and the chunk IDs
  inside `.utoc` containers, so it can tell you two mods edit the same in-game
  asset even when their filenames are completely different. That's the conflict
  that normally shows up as "my mod just doesn't work".
- **Hotkey and hook clashes** between script mods, parsed out of their Lua.
- **Missing requirements** — e.g. a script mod when UE4SS isn't installed.

Nothing touches the game folder until you choose how to resolve it.

**Cards, toggles, and a detail page.** Every mod is a card with its preview
photo and a switch to activate or deactivate it. Opening one shows the
description, exactly which files it installed and where, any settings the mod
itself exposes (read out of its own config files and written back when you
change them), and a **How to use** section with directions, hotkeys, tips and
requirements.

**Tells you what a mod actually changes.** The same pak index used for conflict
detection also reveals which game content a mod touches, so a card can say
"Player character" or "2 Pals" instead of leaving you to guess from
`pakchunk99_P.pak`. The info page breaks it down — which Pals (by game name
where the codename is known: `PinkCat` shows as Cattiva), whether it edits the
player, weapons, buildings, the interface, or the data tables that control game
balance.

**Character mods with multiple looks.** When a mod ships several mutually
exclusive versions, they're shown as pickable options. Every option is kept in
the vault at install time, so switching from one look to another is instant and
doesn't need a re-download.

**Takes over mods you already have.** Already modded the game by hand, or have a
folder of downloads on your desktop? *Settings → Import existing mods* scans a
folder and adopts what it finds. Mods already inside the game folder are adopted
in place — nothing is moved or re-downloaded.

**Get info.** An imported mod arrives knowing nothing but its filename. The
**Get info** button on its card turns that filename into search terms
(`LunaOutfit_P.pak` → "Luna Outfit"), searches the web, ranks the results by
name match and how likely the host is to publish Palworld mods, and reads the
best pages for their preview photo, description, author and usage notes. You
pick which result is yours — an automatic guess that's wrong would write bad
details into your library — and only the fields you're missing get filled in.
When search comes up empty you can paste the mod's page link instead, which is
usually what's needed for Nexus Mods since it blocks automated search.

### How activating and deactivating works

Turning a mod off has to actually stop the game loading it, so PalMod does it
differently per mod type. Pak content is moved out of the game folder into a
local vault (Unreal loads anything it finds in `~mods`, so renaming isn't
enough) and moved straight back when you switch it on. Script mods stay where
they are and get flipped to `0` in UE4SS's `mods.txt`, which is how UE4SS itself
expects to be told.

Uninstalling removes the mod's files and restores anything it overwrote, as long
as backups are on (they are by default).

## Running it

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

To build a Windows installer (`release/`):

```bash
npm run dist:win
```

`npm run dist:dir` produces an unpacked build without an installer, which is
quicker for testing.

## Tests

```bash
npm test
```

Five suites, all against real files on disk: a unit pass over the parsers
(`.pak` index reader, `.utoc` chunk reader, mod-config parsing and write-back,
readme/Lua hotkey extraction), a pass over the Get-info lookup (search-term
building, match scoring, result parsing), and an end-to-end pass that builds a
fake Palworld install and a real zip, then stages, conflict-checks, installs,
toggles, switches variants, adopts and uninstalls against it.

## Notes and limits

- Built for the Windows versions of Palworld (Steam, Game Pass and Epic paths are
  all auto-detected). The code has no Windows-only calls, but the install paths it
  targets are the Windows ones.
- Script and blueprint mods need [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS)
  installed. PalMod detects whether it's present and warns you before installing
  a mod that needs it — it doesn't install UE4SS for you.
- Some mod hosts (Nexus in particular) put downloads behind a login or a
  redirect, so a direct paste of a page URL may not be downloadable. Downloading
  the file yourself and dropping it in works for every host.
- Pak index reading covers UnrealPak versions 8–11. Encrypted indexes can't be
  read; when that happens PalMod says so and falls back to filename-level
  conflict checks rather than guessing.

## Layout

```
src/
  main/services/    game detection, download, extraction, classification,
                    conflicts, pak/utoc readers, install, adopt, config parsing
  preload/          typed IPC bridge
  renderer/         React UI (library, mod detail, settings)
  shared/types.ts   contract shared by both sides
tests/              unit + end-to-end suites
```
