# MAPMARK: Google Maps Annotator

**Version 1.4.0**

MAPMARK is a Tampermonkey userscript that adds a private, editable geographic annotation layer to the Google Maps website. Markup is stored as longitude and latitude rather than fixed screen pixels, allowing annotations to stay aligned as the map pans or zooms.

MAPMARK combines map drawing, a searchable review register, workflow metadata, GIS exchange, and evidence-report generation without requiring a Google Maps API key or an external MAPMARK service.

## What is new in v1.4

Version 1.4 adds rich geographic markup and measurement workflows.

- Editable multi-point routes and polylines.
- Editable freeform polygons.
- Geodesic radius circles and buffer areas.
- Automatic route-distance measurement.
- Automatic polygon perimeter and area measurement.
- Automatic circle radius, diameter, and area measurement.
- Numbered map callouts with automatic sequencing.
- Custom map markers with seven selectable symbols.
- Optional measurement labels on the map and in evidence captures.
- Per-annotation legend labels and color-coded evidence legends.
- Exact latitude and longitude repositioning from the Inspector.
- KML import and export alongside native JSON and GeoJSON.
- Schema 4 native packages with rich geographic metadata.
- Automatic migration of v1.0 through v1.3 data.

## Annotation tools

### Select

Select, inspect, move, resize, reshape, duplicate, nudge, or delete existing annotations. Hold Shift, Ctrl, or Cmd while clicking to build a multi-selection.

### Note

Click once to place a conventional MAPMARK note marker with a title and detailed notes.

### Callout

Click once to place a numbered callout. Numbers increment automatically within the active map set and can be edited in the Inspector.

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

Installing v1.4 over an earlier MAPMARK release retains the existing `mapmark.state.v1` local store. Older data receives safe defaults for any fields introduced after its original version.

## Basic workflow

1. Navigate Google Maps to the site or area being reviewed.
2. Use the compact MAPMARK dock on the right edge of the map.
3. Click **M** to open the full panel, or choose a tool directly from the dock.
4. Choose or create a map set.
5. Place geographic markup.
6. Use the Inspector to add title, status, priority, owner, notes, tags, and legend information.
7. Use the Annotation Register to search, filter, sort, and reopen annotations.
8. Use Evidence Capture to create a PNG, printable report, Markdown package, or CSV register.
9. Export native JSON for a complete MAPMARK backup, GeoJSON for GIS workflows, or KML for common mapping tools.

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
- Map set

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
- Active map set
- Selected annotations
- Current register results
- All annotations

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

- Annotation ID and map set
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

### Native MAPMARK JSON

Native JSON is the preferred backup and editing format. Schema 4 preserves:

- Map sets
- Every annotation type
- Geographic geometry
- Styling
- Workflow metadata
- Marker symbols and callout numbers
- Legend labels
- Measurement visibility
- Register preferences
- Evidence preferences
- Created and updated timestamps

### GeoJSON

GeoJSON exports a standard `FeatureCollection`:

- Points for notes, labels, callouts, and markers
- LineStrings for arrows, routes, and freehand drawings
- Polygons for boxes, freeform polygons, and circles

MAPMARK-specific fields are retained in each feature's properties, including calculated measurement values.

### KML

KML export creates placemarks containing names, descriptions, geometry, and MAPMARK metadata in `ExtendedData`.

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

MAPMARK stores data through Tampermonkey's local userscript storage.

- Annotations are not written into Google Maps.
- Data is not uploaded to a Google account by MAPMARK.
- MAPMARK does not require an external server.
- Search, filters, styles, and evidence settings remain local.
- Tab-capture frames are processed locally in the browser.

Export native JSON before clearing browser data, resetting Tampermonkey, or moving to another browser profile.

## Known limitations

- Alignment is designed for standard north-up, two-dimensional Google Maps views.
- Street View, rotated maps, tilted satellite imagery, and three-dimensional views are not supported in v1.4.0.
- MAPMARK reads map center and zoom from the Google Maps URL. Pan or zoom once if the panel cannot establish a geographic fix.
- Measurements are approximate and depend on the map view, geographic projection, and annotation precision.
- Circle geometry is represented by a 64-segment polygon rather than a native GeoJSON circle because GeoJSON does not define a circle geometry type.
- KML folders, inner polygon holes, MultiGeometry, altitude modes, and advanced styles are not fully interpreted.
- Native Google Maps marker snapping is opportunistic because Google does not publish a stable DOM contract for the Maps website.
- Google Maps interface changes may require future MAPMARK maintenance.
- Tab capture can be blocked by browser privacy settings, extension permissions, or enterprise policy.
- Very dense freehand paths may show sampled edit handles to preserve performance while retaining the underlying geometry.

## Technical design

MAPMARK uses Web Mercator projection mathematics to convert between screen coordinates and geographic coordinates. It detects the principal Google Maps canvas and draws an isolated SVG overlay inside Shadow DOM.

Route, polygon, and circle measurements use geographic calculations rather than measuring screen pixels. Geometry is stored in GeoJSON-compatible structures so it can be transferred through JSON, GeoJSON, and KML.

Precision edits occur interactively in screen space and are converted back into longitude and latitude. Exact-coordinate movement translates the complete geometry geographically.

## Release notes

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
