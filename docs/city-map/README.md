# City map: tickets as cities, terminals as construction sites

An experimental layout for a project, next to the terminal stack and the
React Flow canvas. `demo.html` in this folder is a self-contained interactive
mock of the idea; open it in a browser. It runs on seed data and simulates
agents, so nothing in it touches the app.

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

## Where it plugs in

- `experimentalFlags.ts`: a `cityMap` flag next to `canvas`; toggle in
  `ExperimentalFeaturesSection`.
- `projectStore.terminalLayout`: a third value `'map'` beside `'stack'` and
  `'canvas'`; `Cmd+L` cycles through the enabled layouts.
- `src/components/citymap/`: `CityMap.tsx` (2D canvas renderer plus HTML
  overlays for labels, sidebar and inspector) and `cityMapStore.ts` with a
  `syncMapWithTerminals` mirroring `syncCanvasWithTerminals`.
- Clicking a site calls `focusTerminal(ptyId)` from `navigation.ts`. Whether
  that switches to the stack or opens the terminal in a drawer over the map is
  the main open question; the demo only shows a toast.
- "New city" reuses the kanban composer (`StandaloneComposerSheet`) so a task
  created from the map is the same task as one created from the board.
- "New terminal" on a city goes through `taskStartService`, so the site
  appears through the normal sync once the PTY exists.

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

- Terminal on click: drawer over the map, or switch to the stack and back.
- Whether `done` cities should be archived off the map after a while, or
  stay as history (the demo keeps them, faded).
- Whether a terminal without a task deserves its own lot or should not appear
  on the map at all.
