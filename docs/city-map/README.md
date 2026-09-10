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
- **Task chains are paths.** A child task's city is linked to its parent's by
  a dirt path, the same relation the canvas draws as chain edges.
- **The land is on the grid too.** Every cell of ground is a pure function of
  its lattice position: meadow, dry grass, forest, heath and rock by height
  and moisture from layered noise, in close shades of one green, lakes
  where it is low and wet, and one river winding across the map with sandy
  shores. Close up, forest cells grow trees, rock cells stones, meadows the
  odd flower; further out each becomes a dot baked into the ground. The light
  follows the clock: cool early, warm from five, blue at night, with the
  windows lit from dusk.
- **Roads are yours to draw.** "Road from here…" on a city, then a click on
  the city it leads to, lays a one-way road: a signpost at the start with the
  arrow the traffic takes and the destination's number, arrows on the
  asphalt, a large one where it arrives, and cars driving that way. A road
  runs along the lattice: out of one city's edge, one bend, in at the
  other's, and it crosses every cell of water on a plank bridge. A
  dependency you want to see, not one the data knows. Remove it from either
  end's context menu.
- **Districts are landscapes.** "New district here" on empty ground makes a
  named area laid on the cities' own axes, so it sits on the ground grid,
  with a landscape of its own that no plain land has: cherry grove,
  volcanic, marsh, glacier, mushroom wood or salt flats, picked in its
  inspector. The ground inside is that landscape, water included, and a
  wide edge in the landscape's hue marks it. Drag it and the cities inside
  come along, drag its bottom corner to resize. The city inspector says
  which district a city stands in.
- **Roads carry meaning.** A road's inspector takes a note, shown on the road
  itself; while the city a road leads from is not done, the destination's
  label says what it waits for. The project's tag filter applies to the map:
  cities without a matching terminal fade out and leave the list.
- **No two cities look alike.** The root of a task chain fixes a landscape
  (meadow, forest, desert, tundra, tropical) and an architecture (modern, old
  town, Mediterranean, Nordic, pagoda, adobe), so a family of tasks shares a
  look and unrelated ones differ. The season follows the ticket's age: spring
  for the first days, summer within two weeks, autumn within six, winter
  after that, with snow where the climate allows. The sky follows the sites:
  clouds drift over a city with an agent at work, rain falls on one with a
  problem. The inspector names the mix.
- **A city carries its comments.** The inspector has a comment thread on the
  ticket, the same one the board's expanded card shows, and the newest comment
  sits on the city's label. A note like "waiting for ops" on a city parked in
  a Waiting district says why it is there. Agents can leave one too, through
  `POST /api/tasks/:number/comments` with an `author`.
- **A sidebar lists cities by status or by district** with the attention
  counts first (how many sites wait for the user, how many hit a problem) and
  a "Next" jump. Cities and districts snap to the cell lattice when dragged.
  A minimap, "Fit all" and 1:1 keep the bearings; a city whose site starts
  waiting or fails flashes its label rather than moving the camera.

## Mapping onto the app's data

Nothing new has to be modelled. The map is a view over what the stores
already hold:

| Map                               | App                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| City                              | `TaskWithWorkspace` (`taskNumber`, `name`, `prompt`, `status`, `parentTaskNumber`)           |
| City presence                     | `TaskStatus`: `todo` / `in_progress` / `in_review` / `done`                                  |
| Site                              | A terminal whose `TerminalDisplayState.taskId` is the city's task                            |
| Site name                         | `display.label`, falling back to `lastOscTitle`; rename via the existing `pty.setLabel`      |
| Site state                        | `summaryType` + `hookStatus` + `exited`: thinking → working, ready → waiting, error, success |
| Road                              | `parentTaskNumber`                                                                           |
| Positions, lots, roads, districts | New per-project blob, stored the way `canvasStore` stores `canvas:<projectPath>`             |

Persisted per project (`citymap:<projectPath>` in global settings):

```ts
interface CityMapState {
  viewport: { x: number; y: number; zoom: number };
  cities: Record<
    number /* taskNumber */,
    {
      pos: { x: number; y: number };
      lots: Record<string /* ptyId */, number /* slot */>;
      built: number[]; // slots whose session finished and closed
    }
  >;
  roads: { id: string; from: number; to: number; note?: string }[];
  // x,y is the top corner; w runs down-right along (1, ½), h down-left along (−1, ½)
  districts: { id: string; name: string; x: number; y: number; w: number; h: number; hue: number; terrain: string }[];
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
  state, style, season and weather), `drawCity.ts` (canvas drawing), `CityMap.tsx` (the layout: sidebar,
  map, inspector, terminal drawer). `stores/cityMapStore.ts` holds positions
  and lots and syncs them with the terminal store.
- A site opens its terminal in a drawer over the map, with the same header the
  stack and canvas use, so diff, panels, hooks and the context menu are all
  there. `focusTerminal` lands in the drawer when the map is the layout. The
  drawer docks to the right edge or floats as a window in the middle, and in
  either mode its bottom edge can be dragged up to leave the map free below,
  so the prompt line sits where the eye rests; both are remembered
  (`ui:city-map-drawer-mode`, `ui:city-map-drawer-gap-*`). Going to a city,
  by double-click, sidebar or inspector, closes the drawer: the city is what
  is in focus then.
- Each harness can carry a usage command (Settings → Harnesses → Usage) that
  prints used and available tokens, as JSON or plain text. The map asks every
  such command on open and every five minutes and shows the answers as pills
  at the top centre; a click asks again. `harnessUsage.ts` runs the commands
  in the main process and reads their output.
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

- Whether `done` cities should leave the map on their own after a while.
  Archiving is by hand for now: "Move to → Archive" takes a city off the map
  and the board with its worktree and branch intact, the sidebar's Archive
  list brings it back, and "Delete…" is the one that removes the worktree.
- Whether a terminal without a task deserves a lot on the outskirts.
- Kenney sprites in place of the procedural drawing.
