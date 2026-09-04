# City map: tickets as cities, terminals as construction sites

An experimental layout for a project, next to the terminal stack and the
React Flow canvas. Switch it on under Project Settings → Experimental → "City
map layout"; the title bar then gets a map button and `Cmd+L` cycles through
the enabled layouts. `demo.html` in this folder is the self-contained mock the
layout was designed from; it runs on seed data and simulates agents.

## The idea

The canvas gives an overview of running terminals, but a terminal card says
nothing about which ticket it belongs to or how far that ticket is. The map
puts that context first:

- **One persistent map per project.** Cities keep their location across
  restarts; the user arranges them so related work sits together.
- **One city per task.** A new task is founded on the next free lot of the
  map. The city carries the task name; clicking it opens the description.
- **One construction site per open terminal.** A site takes a free lot inside
  the city and keeps it for the life of the session. Its name comes from the
  terminal label (the session title an agent reports) and can be renamed.
- **Presence follows the task status.** Blueprint for `todo`, full colour with
  cranes for `in_progress`, an inspection flag for `in_review`, desaturated
  and settled for `done`.
- **Sites show what the terminal needs.** Working (crane swinging, dust),
  waiting for input (amber beacon, pulsing ring), problem (red smoke, warning
  sign), finished (green flag, crane gone). A finished site that is closed
  leaves a building behind, so a city visibly grows with the work done in it.
- **Every city carries its ticket colour.** The ground ring, the number chip
  and the sidebar swatch use the same hue the board badge and the terminal
  header show, and the same hex the VS Code workspace file paints its title
  bar with. A child task darkens its parent's hue, as chain badges do.
- **Task chains are roads.** A child task's city is linked to its parent's by
  a path, the same relation the canvas draws as chain edges.
- **A sidebar lists cities by status** with the attention counts first (how
  many sites wait for the user, how many hit a problem) and a "Next" jump.

## Mapping onto the app's data

Nothing new has to be modelled. The map is a view over what the stores
already hold:

| Map                    | App                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| City                   | `TaskWithWorkspace` (`taskNumber`, `name`, `prompt`, `status`, `parentTaskNumber`)               |
| City presence          | `TaskStatus`: `todo` / `in_progress` / `in_review` / `done`                                      |
| Site                   | A terminal whose `TerminalDisplayState.taskId` is the city's task                                |
| Site name              | `display.label`, falling back to `lastOscTitle`; rename via the existing `pty.setLabel`          |
| Site state             | `summaryType` + `hookStatus` + `exited`: thinking → working, ready → waiting, error, success     |
| Road                   | `parentTaskNumber`                                                                               |
| Positions and lots     | New per-project blob, stored the way `canvasStore` stores `canvas:<projectPath>`                 |

Persisted per project (`citymap:<projectPath>` in global settings):

```ts
interface CityMapState {
  viewport: { x: number; y: number; zoom: number };
  cities: Record<number /* taskNumber */, {
    pos: { x: number; y: number };
    lots: Record<string /* ptyId */, number /* slot */>;
    built: number[]; // slots whose session finished and closed
  }>;
}
```

A `ptyId` survives renderer reloads through `pty.reconnect`, so a site keeps
its lot as long as the session lives. When a terminal closes, its lot is freed
or, if the session ended in `success`, moved to `built`. Terminals without a
task (`taskId === null`) sit on a common "outskirts" lot rather than in a
city.

Free-lot placement for a new city uses a sunflower spiral from the map centre
and takes the first spot at least one city width from every existing one.
Slot order inside a city is a seeded shuffle of the non-road cells, empty lots
first, so the same task always lays out the same way.

## Where it lives

- `experimentalFlags.ts`: the `cityMap` flag next to `canvas`; toggle in
  `ExperimentalFeaturesSection`.
- `projectStore.terminalLayout`: `'map'` beside `'stack'` and `'canvas'`.
- `src/components/citymap/`: `cityGeometry.ts` (layout, lots, placement, site
  state), `drawCity.ts` (canvas drawing), `CityMap.tsx` (the layout: sidebar,
  map, inspector, terminal drawer). `stores/cityMapStore.ts` holds positions
  and lots and syncs them with the terminal store.
- A site opens its terminal in a drawer over the map, with the same header the
  stack and canvas use, so diff, panels, hooks and the context menu are all
  there. `focusTerminal` lands in the drawer when the map is the layout.
- The city's context menu is the kanban card's: Open in, Move to, Trash, plus
  "Show on board". "New ticket" opens the task composer; "New terminal" on a
  city goes through `openTaskShell`, so the site appears through the normal
  sync once the PTY exists.
- Terminals without a task are counted in the sidebar with a jump to the
  stack; they have no city to stand in.

The renderer is a plain 2D canvas rather than React Flow nodes: a city is a
few hundred small shapes with ambient animation, and the map should stay
cheap with fifty cities on it. Labels, the sidebar and the inspector are DOM,
so they stay legible at any zoom and keep keyboard access.

## Kenney assets

The demo draws everything procedurally in the flat isometric style of
Kenney's miniature sets, so a sprite pack can replace the draw functions
one by one without changing the layout logic. Cell size is a 44×22 diamond;
buildings are 13px per storey. Candidate packs (CC0):

- Isometric Miniature Buildings / Library / Prototype: houses, shops, trees,
  roads in the same footprint as the demo's cells.
- Isometric City / Roguelike City: roads and vehicles for the crossroads.
- Cranes, fences and material piles: check the miniature sets first; anything
  missing stays procedural, as in the demo.

Ship the sprites as an atlas under `src/assets/` and draw with
`drawImage` at the cell origin; the state overlays (beacon, smoke, flag) can
stay drawn, since they animate.

## Open questions

- Whether `done` cities should be archived off the map after a while, or
  stay as history (they stay, faded, for now).
- Whether a terminal without a task deserves a lot on the outskirts.
- Kenney sprites in place of the procedural drawing.
