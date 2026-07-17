# MAPMARK: Google Maps Annotator

**Version 1.7.1**

MAPMARK is a Tampermonkey userscript that adds private, editable project layers to the Google Maps website. Markup is stored as longitude and latitude rather than fixed screen pixels, allowing annotations to stay aligned as the map pans or zooms.

MAPMARK combines map drawing, project packages, independently visible and lockable layers, a searchable review register, workflow metadata, GIS exchange, and evidence-report generation without requiring a Google Maps API key or an external MAPMARK service.


## What is new in v1.7.1

Version 1.7.1 is a contrast and readability cleanup pass for the rebuilt workflow interface. It keeps the v1.7 workspace structure, but improves legibility by strengthening dark-mode contrast, increasing separation between panel surfaces, brightening secondary text, clarifying list-item and filter states, and making selected and hovered controls easier to read.

Highlights:

- Brighter secondary text and metadata in dark mode
- Stronger separation between panel background, cards, inputs, and list rows
- Higher-contrast workflow tabs, badges, metric pills, and chips
- Clearer hover and active states in Review and Annotate
- Improved placeholder visibility and small-label readability
- No storage migration required; the schema remains version 6

## What is new in v1.7

Version 1.7 is the workflow and interface cleanup release. The expanded panel no longer presents every MAPMARK capability in one long vertical stack. It is organized around five stages of work:

1. **Annotate** — Choose tools, set appearance, and edit the current selection.
2. **Review** — Search the annotation register, assign workflow fields, and resolve open items.
3. **Evidence** — Choose an evidence scope and create images, reports, Markdown, or CSV.
4. **Project** — Manage project metadata, layers, imports, exports, and backups.
5. **System** — Verify storage, manage recovery snapshots, and inspect map compatibility.

The active project and active layer remain visible in a compact context bar regardless of the current stage. Undo, redo, markup visibility, and selection clearing remain available in a persistent command bar.

Additional v1.7 refinements include:

- Five purpose-built workspaces instead of one continuously scrolling panel.
- A compact, always-visible project and layer selector.
- Five primary annotation tools shown first, with six advanced line and shape tools grouped under a disclosure.
- Context-sensitive marker options rather than permanently visible marker controls.
- Review filters and sorting grouped under an optional disclosure.
- A dedicated selection-details card in the Annotate workspace.
- A compact selected-item summary in Review with direct map focus and Edit Details actions.
- Project and layer creation buttons that take the user directly to the Project workspace.
- Reliability controls moved out of the normal annotation path into the System workspace.
- A fixed-height panel with one independently scrolling workspace, eliminating the feeling of scrolling through the entire application.
- Workflow keyboard shortcuts: **Alt+1** through **Alt+5**.

All v1.6 storage, recovery, annotation, measurement, register, package, evidence, GeoJSON, and KML capabilities remain available. The workspace data schema remains schema 6, so v1.7 does not require another data migration.

## Reliability and recovery

### IndexedDB migration

On first v1.6 launch, MAPMARK reads the existing `mapmark.state.v1` Tampermonkey value, normalizes it to schema 6, writes it into IndexedDB, and creates an initial recovery snapshot. Existing annotations, projects, layers, filters, styles, and evidence settings are retained.

The Tampermonkey value remains as an emergency mirror so the workspace can still be opened and saved when IndexedDB is unavailable because of browser policy, privacy restrictions, or a damaged database.

### Integrity checks and quarantine

Workspace records and snapshots contain an FNV-1a checksum. MAPMARK verifies both the checksum and the internal data structure before accepting a record. Checks include project, layer, and annotation identifiers; cross-references; and Point, LineString, and Polygon geometry.

A failed primary record is copied into a quarantine store with its failure reason. MAPMARK then searches recovery snapshots newest-first and restores the first verified record. Invalid snapshots are also quarantined rather than retried indefinitely.

### Recovery snapshots

Automatic recovery snapshots are enabled by default at a ten-minute interval. The Reliability panel allows intervals from two minutes to two hours. MAPMARK also takes protective snapshots before higher-risk operations.

The newest twelve snapshots are retained. Each entry records its date, reason, annotation count, application version, and checksum. Restoring a snapshot requires a second confirmation click and creates a protective snapshot of the current workspace first.

### Diagnostics and rebuild

The Reliability panel can:

- Verify the active IndexedDB record.
- Create a manual recovery snapshot.
- Restore a recent verified snapshot.
- Export a diagnostics JSON file that contains counts and health information but not annotation titles, notes, tags, owners, or geometry.
- Rebuild the IndexedDB database while retaining the current in-memory workspace.

The exported diagnostics report includes browser and viewport information, storage status, map-view detection, candidate-canvas scores, workspace counts, and integrity results.


## Annotation tools

### Select

Select, inspect, move, resize, reshape, duplicate, nudge, or delete existing annotations. Hold Shift, Ctrl, or Cmd while clicking to build a multi-selection.

### Note

Click once to place a conventional MAPMARK note marker with a title and detailed notes.

### Callout

Click once to place a numbered callout. Numbers increment automatically within the active layer and can be edited in the Inspector.

### Marker

Click once to place a custom marker. Available symbols are:

- Pin
- Star
- Flag
- Photo
- Warning
- Access
- Utility

### Label

Click once to place a text label directly on the map.

### Arrow

Drag from the arrow tail to the arrow point. Both endpoints remain editable.

### Route

Click each route vertex in sequence. Press **Enter**, double-click, or use **Finish Route** to complete it. MAPMARK calculates the complete route distance.

### Box

Drag diagonally to create a rectangular marked area. Each corner remains editable while preserving the rectangular form.

### Polygon

Click each polygon vertex in sequence. Press **Enter**, double-click, or use **Finish Polygon** to complete it. MAPMARK calculates perimeter and enclosed area.

### Circle

Drag from the center to the desired radius. MAPMARK stores the result as a portable geographic polygon and calculates radius, diameter, and area.

### Draw

Press and drag to create a freehand geographic sketch. The path is simplified to reduce unnecessary points while preserving the overall shape.

## Installation

1. Install Tampermonkey in a supported browser.
2. Ensure Tampermonkey is permitted to run userscripts. Some Chrome configurations require enabling **Allow User Scripts** for the extension.
3. Open `google-maps-annotator.user.js` through the Tampermonkey dashboard or import it as a userscript.
4. Save and enable the script.
5. Open Google Maps in a standard north-up, two-dimensional map view.

Installing v1.7 over an earlier MAPMARK release automatically migrates the existing `mapmark.state.v1` Tampermonkey workspace into IndexedDB and creates a verified recovery snapshot. Existing projects, layers, annotations, map sets, and preferences are preserved.

## Basic workflow

1. Navigate Google Maps to the site or area being reviewed.
2. Use the compact MAPMARK dock for quick placement, or click **M** to open the expanded workspace.
3. Confirm the active project and layer in the context bar.
4. Open **Annotate** to place and edit map markup.
5. Open **Review** to search the register, set status and priority, assign owners, and resolve findings.
6. Open **Evidence** to choose a scope and create a PNG, printable report, Markdown package, or CSV register.
7. Open **Project** to manage metadata and layers or exchange `.mapmark.json`, workspace JSON, GeoJSON, and KML files.
8. Open **System** only when checking storage health, restoring a recovery point, or diagnosing map alignment.

The compact command bar remains visible across all five workspaces for undo, redo, markup visibility, and selection management.

## Projects and layers

### Projects

A project is the top-level portable work package. Each project stores:

- Project name
- Description and scope
- Project, case, work-order, or review reference
- Active or archived status
- Created and updated timestamps
- Its complete set of map layers and annotations

Archiving a project removes it from the normal project selector without deleting its contents. Enable **Show archived projects in selector** to reopen and restore archived work.

### Project templates

MAPMARK includes four starting structures:

- **Blank project:** One general Field Notes layer.
- **Site survey:** Observations, Photo Points, Measurements, and Follow-up.
- **Accessibility review:** Accessible Routes, Entrances, Barriers, Amenities, and Actions.
- **Infrastructure inspection:** Assets, Defects, Utilities, Safety, and Repairs.

Templates create an organizational starting point only. Layers can be added, hidden, locked, or archived afterward.

### Layers

Every annotation belongs to one layer inside one project. A layer can be:

- **Visible:** Its annotations may appear on the map.
- **Hidden:** Its annotations remain stored but are omitted from the overlay.
- **Locked:** Its annotations can be selected and reviewed but cannot be moved, reshaped, restyled, edited, duplicated, or deleted.
- **Archived:** The layer and its annotations remain in the project package but the layer is removed from normal active work.

Enable **Show every visible layer in this project** to review multiple layers together. With that option disabled, MAPMARK shows only the active layer.

A project must retain at least one active layer. MAPMARK prevents archiving the final active layer.

### Import behavior

MAPMARK provides two package-import strategies:

- **Merge into workspace:** Match projects and layers by identifier or name, skip exact duplicate annotations, and preserve same-ID differences as new annotations tagged `import-conflict`.
- **Import as a separate copy:** Create a separately named project and remap all project, layer, and annotation identifiers.

Import never silently overwrites a divergent local annotation.

## Rich geometry and measurement

### Route distance

Routes are stored as GeoJSON-compatible `LineString` geometry. MAPMARK calculates the geodesic distance between each consecutive pair of vertices and totals the segments.

### Polygon perimeter and area

Polygons are stored as closed GeoJSON-compatible polygon rings. MAPMARK calculates:

- Geodesic perimeter from the ring segments.
- Approximate surface area using a local Earth projection appropriate for field-review scale.

### Circles and buffers

Circles are stored as 64-segment geographic polygons, making them portable through native JSON, GeoJSON, and KML. The radius is derived from the geographic center and ring edge.

### Units

MAPMARK selects readable units based on scale:

- Centimeters, feet, meters, miles, or kilometers for distance.
- Square meters, acres, or square kilometers for area.

Measurements are intended for planning, review, documentation, and preliminary field work. They are not a substitute for controlled survey, cadastral, construction, or safety-critical measurements.

## Precision editing

### Move annotations

Drag any selected annotation to move it geographically. Dragging one item in a multi-selection moves the entire selected group.

### Edit route and freehand vertices

Select a route or freehand line and drag its visible circular vertices. Select a vertex and press Delete, double-click it, or use **Remove point**.

A line must retain at least two points.

### Edit polygon vertices

Select a polygon and drag its square vertex handles. A polygon must retain at least three unique vertices and remains automatically closed.

### Resize circles

Select a circle and drag its square radius handle. Drag the circle body to move the complete buffer without changing its radius.

### Resize boxes

Select a box and drag a corner handle. Adjacent corners adjust automatically to preserve the rectangular geometry.

### Edit arrows

Select an arrow and drag either endpoint.

### Duplicate and nudge

- **Ctrl/Cmd+D:** Duplicate the current selection.
- **Arrow keys:** Nudge by one screen pixel.
- **Shift+Arrow keys:** Nudge by ten screen pixels.

Screen-space edits are converted back into geographic coordinates.

### Snapping

Snapping can align geometry to:

- MAPMARK points, vertices, endpoints, and centers.
- Recognizable visible Google Maps markers.

Hold Alt while dragging to bypass snapping temporarily. Snapping can also be disabled from the panel.

## Exact coordinates

Every annotation Inspector includes latitude and longitude fields based on the annotation center.

To place an annotation at an exact location:

1. Select the annotation.
2. Enter the desired latitude and longitude.
3. Click **Move center to exact coordinates**.

For lines and polygons, the complete geometry translates while preserving its shape and dimensions as closely as practical.

## Annotation Register

The register searches:

- Title
- Notes
- Tags
- Owner
- Legend label
- Calculated measurement text
- Status
- Priority
- Annotation type

Filters are available for:

- Annotation type
- Status
- Priority
- Color
- Tag
- Layer

Sorting modes include:

- Recently updated
- Oldest update
- Recently created
- Oldest created
- Title A–Z
- Title Z–A
- Nearest map center

Clicking a register row centers Google Maps on that annotation. Hold Shift, Ctrl, or Cmd while clicking to add or remove it from the current selection without navigating.

## Workflow metadata

Each annotation can include:

- **Status:** Open, Review, Resolved, or Archived
- **Priority:** Low, Normal, High, or Critical
- **Owner:** Person, team, organization, or responsible party
- **Notes:** Detailed observation, context, evidence, or action
- **Tags:** Searchable comma-separated terms
- **Legend label:** Optional category used in evidence legends

Archived annotations are hidden from the map by default but remain available in the register and exports.

Bulk controls can update status, priority, and tags across a multi-selection.

## Evidence capture

Evidence outputs use one of five scopes:

- Visible map scope
- Active layer
- Selected annotations
- Current register results
- Active project archive

### Annotated PNG

MAPMARK can capture the current Google Maps tab, crop it to the detected map viewport, and composite optional report graphics:

- Title block
- Subtitle or project reference
- Capture date and time
- Map center and zoom
- North arrow
- Approximate scale bar
- Color-coded legend
- MAPMARK version

When prompted, select the current Google Maps browser tab. MAPMARK reads a single frame locally and immediately stops the capture stream.

### Printable report

The printable report includes:

- Report title and subtitle
- Source Google Maps URL
- Capture metadata
- Annotated map image
- Workflow summary
- Optional annotation register
- Coordinates and calculated measurements
- Status, priority, owner, tags, and notes

Use **Print / Save PDF** in the report tab to create a PDF through the browser print dialog.

### Markdown

Markdown exports include capture metadata and a complete section for each scoped annotation, including geometry measurements and legend labels where available.

### CSV

CSV exports include:

- Annotation ID, project, and layer
- Type and title
- Status, priority, and owner
- Latitude and longitude
- Calculated measurements
- Legend label
- Marker symbol and callout number
- Tags and notes
- Color and stroke width
- Created and updated timestamps
- Source Google Maps URL

The file is UTF-8 with a byte-order mark for reliable spreadsheet import.

## Data exchange

### Native MAPMARK packages

MAPMARK v1.6 uses schema 6 and provides two native package forms.

**Project package (`.mapmark.json`)** is the preferred sharing and editing format for one project. It preserves:

- Project metadata and archive state
- Every layer, including visibility, lock, order, and archive state
- Every annotation type and geographic geometry
- Styling and workflow metadata
- Marker symbols, callout numbers, and legend labels
- Measurement visibility
- Created and updated timestamps

**Workspace JSON** backs up every project, layer, annotation, and user preference in the browser profile.


### GeoJSON

GeoJSON exports the active project as a standard `FeatureCollection`:

- Points for notes, labels, callouts, and markers
- LineStrings for arrows, routes, and freehand drawings
- Polygons for boxes, freeform polygons, and circles

MAPMARK-specific fields are retained in each feature's properties, including calculated measurement values.

### KML

KML export creates placemarks for the active project containing names, descriptions, geometry, project/layer context, and MAPMARK metadata in `ExtendedData`.

KML import supports placemarks containing:

- Point
- LineString
- Polygon

KML created by MAPMARK preserves explicit annotation types such as Callout, Marker, Route, Polygon, and Circle. Generic third-party KML is inferred as Marker, Route, or Polygon.

### Clipboard package

The clipboard package creates a readable text register with type, title, workflow fields, coordinates, measurements, tags, and notes.

## Keyboard controls

- **Alt+Shift+M:** Open or collapse MAPMARK.
- **Enter:** Finish an active Route or Polygon.
- **Escape:** Cancel drawing or dragging; otherwise return to Select or clear selection.
- **Delete/Backspace:** Remove the active editable vertex, or delete the selected annotations.
- **Ctrl/Cmd+D:** Duplicate selection.
- **Arrow keys:** Nudge selection one pixel.
- **Shift+Arrow keys:** Nudge selection ten pixels.
- **Ctrl/Cmd+Z:** Undo.
- **Ctrl/Cmd+Shift+Z:** Redo.

Keyboard commands do not run while typing in an input, textarea, or select control.

## Storage and privacy

MAPMARK stores its authoritative workspace in IndexedDB under the current Google Maps browser origin and maintains an emergency mirror through Tampermonkey storage.

- Annotations are not written into Google Maps.
- Data is not uploaded to a Google account by MAPMARK.
- MAPMARK does not require an external server.
- Recovery snapshots and quarantined records remain local to the browser profile.
- Search, filters, styles, evidence settings, and reliability preferences remain local.
- Tab-capture frames are processed locally in the browser.
- Diagnostics exports omit annotation contents and geometry.

Export workspace JSON before clearing site data, resetting Tampermonkey, or moving to another browser profile. Export `.mapmark.json` project packages when sharing or archiving individual projects. IndexedDB and the emergency mirror are both browser-profile storage and are not substitutes for an external backup.

## Known limitations

- Alignment is designed for standard north-up, two-dimensional Google Maps views.
- Street View, rotated maps, tilted satellite imagery, and three-dimensional views are intentionally blocked. MAPMARK hides its overlay and returns to Select mode until a standard north-up 2D view is restored.
- MAPMARK reads map center and zoom from the Google Maps URL. Views without a verifiable latitude, longitude, and zoom are treated as unsafe rather than projected approximately.
- Measurements are approximate and depend on the map view, geographic projection, and annotation precision.
- Circle geometry is represented by a 64-segment polygon rather than a native GeoJSON circle because GeoJSON does not define a circle geometry type.
- KML folders, inner polygon holes, MultiGeometry, altitude modes, and advanced styles are not fully interpreted.
- Native Google Maps marker snapping is opportunistic because Google does not publish a stable DOM contract for the Maps website.
- Google Maps interface changes may require future MAPMARK maintenance.
- Tab capture can be blocked by browser privacy settings, extension permissions, or enterprise policy.
- Very dense freehand paths may show sampled edit handles to preserve performance while retaining the underlying geometry.

## Technical design

MAPMARK uses Web Mercator projection mathematics to convert between screen coordinates and geographic coordinates. It scores visible canvas and map-container candidates, subtracts obstructing side panels, verifies a north-up 2D camera, and draws an isolated SVG overlay inside Shadow DOM.

Route, polygon, and circle measurements use geographic calculations rather than measuring screen pixels. Geometry is stored in GeoJSON-compatible structures so it can be transferred through project packages, workspace JSON, GeoJSON, and KML. Projects and layers are organizational metadata around that portable geographic geometry.

Precision edits occur interactively in screen space and are converted back into longitude and latitude. Exact-coordinate movement translates the complete geometry geographically. IndexedDB records are serialized with integrity checksums, and verified snapshots provide bounded local recovery history.

## Release notes

### v1.7.0

- Replaced the single long expanded panel with five workflow workspaces: Annotate, Review, Evidence, Project, and System.
- Added a persistent project and layer context bar.
- Added a persistent command bar for undo, redo, markup visibility, and selection management.
- Prioritized five common annotation tools and grouped six advanced drawing tools.
- Made marker controls context-sensitive.
- Collapsed advanced register filters and sorting behind an optional disclosure.
- Added a dedicated selection-details area to Annotate and a compact selection summary to Review.
- Moved project metadata, layers, package exchange, and backups into one Project workflow.
- Moved diagnostics and recovery controls into a dedicated System workflow.
- Added Alt+1 through Alt+5 workspace shortcuts.
- Preserved schema 6 and all v1.6 data without migration.

### v1.6.0

- Migrated the authoritative workspace store to IndexedDB.
- Added automatic migration from v1.0 through v1.5 Tampermonkey data.
- Retained Tampermonkey storage as an emergency mirror and fallback.
- Added schema and geometry integrity validation.
- Added checksums for workspace records and snapshots.
- Added quarantine storage for damaged records.
- Added automatic recovery from the newest verified snapshot.
- Added configurable automatic snapshots and protective snapshots before higher-risk operations.
- Capped recovery history at twelve snapshots.
- Added storage verification, manual snapshots, confirmed snapshot restoration, diagnostics export, and non-destructive IndexedDB rebuild.
- Added scored map-canvas detection and side-panel subtraction.
- Added explicit Street View, rotated, tilted, 3D, and unverifiable-view detection.
- Suppressed overlays and drawing tools in unsafe map modes.
- Advanced native workspace and project packages to schema 6.


### v1.5.0

- Added named project packages with description, reference, timestamps, and archive status.
- Converted map sets into project-owned layers.
- Added independent layer visibility, locking, and archiving.
- Added blank, site-survey, accessibility-review, and infrastructure-inspection templates.
- Added portable `.mapmark.json` project export.
- Added complete workspace JSON export.
- Added merge and duplicate import strategies.
- Added exact-duplicate skipping and non-destructive same-ID conflict preservation.
- Scoped GeoJSON and KML exports to the active project.
- Advanced native storage and packages to schema 5.
- Added automatic migration from v1.0 through v1.4.


### v1.4.0

- Added editable routes and polylines.
- Added editable freeform polygons.
- Added geodesic circles and buffer areas.
- Added automatic distance, perimeter, radius, diameter, and area calculations.
- Added optional map measurement labels.
- Added numbered callouts.
- Added custom marker symbols.
- Added per-annotation legend labels and color-coded evidence legends.
- Added exact latitude and longitude repositioning.
- Added KML import and export.
- Extended GeoJSON, CSV, Markdown, printable report, and clipboard output with rich geometry metadata.
- Advanced native packages to schema 4.
- Added automatic migration from v1.0 through v1.3.

### v1.3.0

- Added annotated PNG capture.
- Added printable evidence reports with browser PDF output.
- Added Markdown and CSV exports.
- Added evidence scopes, title blocks, legends, north arrows, scale bars, and report tables.
- Advanced native packages to schema 3.

### v1.2.0

- Added the searchable annotation register.
- Added workflow status, priority, ownership, filtering, sorting, and bulk updates.
- Added archived-map visibility controls.
- Advanced native packages to schema 2.

### v1.1.0

- Added precision dragging, multi-selection, group movement, endpoint editing, corner resizing, vertex editing, duplication, nudging, snapping, and zoom-to-selection.

### v1.0.0

- Initial release with notes, labels, arrows, boxes, freehand markup, map sets, autosave, native JSON, GeoJSON, clipboard export, and local import.
