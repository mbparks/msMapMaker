// ==UserScript==
// @name         MAPMARK — Google Maps Annotator
// @namespace    https://mbparks.com/fieldinstruments
// @version      1.7.1
// @description  A workflow-centered Google Maps annotation workspace with precision markup, review registers, evidence capture, project packages, resilient local storage, and improved contrast.
// @author       Michael Parks / Green Shoe Garage
// @match        https://www.google.com/maps/*
// @match        https://maps.google.com/*
// @include      /^https:\/\/(?:www\.)?google\.[a-z.]+\/maps(?:\/|$)/
// @include      /^https:\/\/maps\.google\.[a-z.]+(?:\/|$)/
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  const APP = Object.freeze({
    name: 'MAPMARK',
    version: '1.7.1',
    storageKey: 'mapmark.state.v1',
    dbName: 'mapmark.indexeddb.v1',
    dbVersion: 1,
    workspaceId: 'primary',
    maxSnapshots: 12,
    snapshotIntervalMs: 10 * 60 * 1000,
    tileSize: 256,
  });

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COLORS = ['#d32f2f', '#ef6c00', '#f9a825', '#2e7d32', '#0277bd', '#5e35b1', '#6d4c41', '#263238'];
  const TOOL_LABELS = {
    select: 'Select',
    note: 'Note',
    label: 'Label',
    arrow: 'Arrow',
    box: 'Box',
    pen: 'Draw',
    callout: 'Callout',
    marker: 'Marker',
    route: 'Route',
    polygon: 'Polygon',
    circle: 'Circle',
  };
  const ANNOTATION_TYPES = Object.freeze(Object.keys(TOOL_LABELS).filter(type => type !== 'select'));
  const POINT_TYPES = Object.freeze(['note', 'label', 'callout', 'marker']);
  const LINE_TYPES = Object.freeze(['arrow', 'pen', 'route']);
  const POLYGON_TYPES = Object.freeze(['box', 'polygon', 'circle']);
  const MARKER_ICONS = Object.freeze({
    pin: { label: 'Pin', glyph: '●' },
    star: { label: 'Star', glyph: '★' },
    flag: { label: 'Flag', glyph: '⚑' },
    camera: { label: 'Photo', glyph: '⌾' },
    warning: { label: 'Warning', glyph: '!' },
    access: { label: 'Access', glyph: '↗' },
    utility: { label: 'Utility', glyph: '◆' },
  });
  const STATUS_LABELS = Object.freeze({
    open: 'Open',
    review: 'Review',
    resolved: 'Resolved',
    archived: 'Archived',
  });
  const PRIORITY_LABELS = Object.freeze({
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    critical: 'Critical',
  });
  const REGISTER_SORTS = Object.freeze({
    'updated-desc': 'Recently updated',
    'updated-asc': 'Oldest update',
    'created-desc': 'Recently created',
    'created-asc': 'Oldest created',
    'title-asc': 'Title A–Z',
    'title-desc': 'Title Z–A',
    'distance-asc': 'Nearest map center',
  });
  const EVIDENCE_SCOPES = Object.freeze({
    visible: 'Visible map scope',
    active: 'Active layer',
    selected: 'Selected annotations',
    register: 'Current register results',
    all: 'Active project archive',
  });

  const IMPORT_STRATEGIES = Object.freeze({
    merge: 'Merge into workspace',
    duplicate: 'Import as a separate copy',
  });
  const PROJECT_TEMPLATES = Object.freeze({
    blank: {
      label: 'Blank project',
      description: 'Start with one general annotation layer.',
      layers: ['Field Notes'],
    },
    survey: {
      label: 'Site survey',
      description: 'Organize observations, photographs, measurements, and follow-up work.',
      layers: ['Observations', 'Photo Points', 'Measurements', 'Follow-up'],
    },
    accessibility: {
      label: 'Accessibility review',
      description: 'Review routes, entrances, barriers, amenities, and corrective actions.',
      layers: ['Accessible Routes', 'Entrances', 'Barriers', 'Amenities', 'Actions'],
    },
    infrastructure: {
      label: 'Infrastructure inspection',
      description: 'Document assets, defects, utilities, safety concerns, and repair priorities.',
      layers: ['Assets', 'Defects', 'Utilities', 'Safety', 'Repairs'],
    },
  });

  const DEFAULT_STATE = () => {
    const now = new Date().toISOString();
    return {
      schema: 6,
      activeProjectId: 'project-default',
      activeCollectionId: 'default',
      showAllCollections: false,
      projects: [
        {
          id: 'project-default',
          name: 'Field Project',
          description: '',
          reference: '',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
      collections: [
        {
          id: 'default',
          projectId: 'project-default',
          name: 'Field Notes',
          visible: true,
          locked: false,
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      annotations: [],
      preferences: {
        color: COLORS[0],
        strokeWidth: 3,
        markerIcon: 'pin',
        snap: true,
        showArchivedOnMap: false,
        showArchivedProjects: false,
        importStrategy: 'merge',
        reliability: {
          automaticSnapshots: true,
          snapshotIntervalMinutes: 10,
        },
        evidence: {
          title: '',
          subtitle: '',
          scope: 'visible',
          includeTitleBlock: true,
          includeLegend: true,
          includeNorthArrow: true,
          includeScaleBar: true,
          includeTable: true,
        },
        register: {
          query: '',
          tag: '',
          type: 'all',
          status: 'all',
          priority: 'all',
          color: 'all',
          collection: 'scope',
          sort: 'updated-desc',
        },
      },
    };
  };

  const bootstrap = loadBootstrapState();
  let state = bootstrap.state;
  const storageRuntime = {
    db: null,
    ready: false,
    mode: 'Starting',
    integrity: 'Unchecked',
    lastSavedAt: null,
    lastSnapshotAt: null,
    lastError: bootstrap.error || null,
    fallbackReason: null,
    migration: null,
    recoveredFrom: null,
    payloadBytes: 0,
    snapshotCount: 0,
    quarantineCount: 0,
    snapshots: [],
    saveSequence: 0,
    pendingSave: false,
  };
  let pendingFocusCandidate = null;
  let pendingFocusId = null;
  try {
    pendingFocusCandidate = sessionStorage.getItem('mapmark.pendingFocus');
    if (pendingFocusCandidate && state.annotations.some(annotation => annotation.id === pendingFocusCandidate)) pendingFocusId = pendingFocusCandidate;
    sessionStorage.removeItem('mapmark.pendingFocus');
  } catch (_) { /* storage unavailable */ }
  let ui = {
    expanded: Boolean(pendingFocusId),
    workspace: 'annotate',
    tool: 'select',
    selectedId: pendingFocusId,
    selectedIds: new Set(pendingFocusId ? [pendingFocusId] : []),
    activeVertex: null,
    mapRect: null,
    mapView: null,
    lastHref: location.href,
    hidden: false,
    drawing: null,
    interaction: null,
    suppressClickUntil: 0,
    snapGuide: null,
    draftPoint: null,
    newCollectionOpen: false,
    newProjectOpen: false,
    projectArchiveArmed: false,
    layerArchiveArmed: false,
    lastImportReport: null,
    clearArmed: false,
    saveTimer: null,
    renderQueued: false,
    undo: [],
    redo: [],
    captureBusy: false,
    captureMode: false,
    captureIds: null,
    diagnosticsOpen: false,
    storageBusy: false,
    restoreSnapshotArmed: null,
    rebuildStorageArmed: false,
    mapEnvironment: { mode: 'unknown', supported: false, reason: 'Map context not inspected yet.', signals: [] },
    mapDetection: { candidates: 0, source: 'none', score: 0 },
  };

  const host = document.createElement('div');
  host.id = 'mapmark-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  const style = document.createElement('style');
  style.textContent = `
    :host {
      --mm-bg: rgba(250, 250, 248, .97);
      --mm-panel: #ffffff;
      --mm-text: #172027;
      --mm-muted: #617079;
      --mm-line: #d7dde0;
      --mm-accent: #b3261e;
      --mm-accent-soft: #f7dedb;
      --mm-shadow: 0 14px 42px rgba(0,0,0,.24);
      --mm-radius: 12px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--mm-text);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --mm-bg: rgba(29, 33, 36, .97);
        --mm-panel: #252a2e;
        --mm-text: #f1f4f5;
        --mm-muted: #aab5bb;
        --mm-line: #465158;
        --mm-accent: #ff8a80;
        --mm-accent-soft: #4b2a28;
        --mm-shadow: 0 14px 42px rgba(0,0,0,.5);
      }
    }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; }
    button { color: inherit; }

    #mm-overlay {
      position: fixed;
      overflow: visible;
      pointer-events: none;
      z-index: 2147483646;
    }
    #mm-overlay.mm-drawing { pointer-events: auto; cursor: crosshair; touch-action: none; }
    #mm-overlay .mm-ann { pointer-events: auto; cursor: grab; touch-action: none; }
    #mm-overlay .mm-ann:active { cursor: grabbing; }
    #mm-overlay.mm-drawing .mm-ann { pointer-events: none; }
    #mm-overlay .mm-hit { stroke: transparent; fill: transparent; pointer-events: stroke; }
    #mm-overlay .mm-selected { filter: drop-shadow(0 0 3px rgba(255,255,255,.95)) drop-shadow(0 0 5px rgba(0,0,0,.8)); }
    #mm-overlay .mm-primary { filter: drop-shadow(0 0 3px rgba(255,255,255,.98)) drop-shadow(0 0 7px rgba(0,0,0,.92)); }
    #mm-overlay .mm-handle-hit { fill: transparent; stroke: transparent; pointer-events: all; cursor: grab; }
    #mm-overlay .mm-handle {
      fill: #fff;
      stroke: #172027;
      stroke-width: 1.5;
      pointer-events: none;
      vector-effect: non-scaling-stroke;
    }
    #mm-overlay .mm-handle.active { fill: #ffd54f; stroke-width: 2.5; }
    #mm-overlay .mm-snap-ring { fill: rgba(255,255,255,.88); stroke: #b3261e; stroke-width: 2; pointer-events: none; }
    #mm-overlay .mm-snap-line { stroke: #b3261e; stroke-width: 1.5; stroke-dasharray: 4 3; pointer-events: none; }
    #mm-overlay .mm-text {
      paint-order: stroke fill;
      stroke: rgba(255,255,255,.96);
      stroke-width: 4px;
      stroke-linejoin: round;
      font-weight: 750;
      font-size: 13px;
    }
    #mm-overlay .mm-note-letter {
      fill: white;
      font-size: 11px;
      font-weight: 900;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }
    #mm-overlay.mm-capture .mm-handle,
    #mm-overlay.mm-capture .mm-handle-hit,
    #mm-overlay.mm-capture .mm-snap-ring,
    #mm-overlay.mm-capture .mm-snap-line { display: none; }
    #mm-overlay .mm-measure-label {
      paint-order: stroke fill;
      stroke: rgba(255,255,255,.96);
      stroke-width: 4px;
      stroke-linejoin: round;
      font-size: 11px;
      font-weight: 900;
      pointer-events: none;
    }
    #mm-overlay .mm-marker-glyph {
      fill: white;
      font-size: 13px;
      font-weight: 900;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }
    #mm-overlay .mm-callout-number {
      fill: white;
      font-size: 11px;
      font-weight: 950;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }
    #mm-overlay.mm-capture .mm-ann { cursor: default; }

    #mm-collapsed {
      position: fixed;
      top: 50%;
      right: 10px;
      transform: translateY(-50%);
      display: grid;
      gap: 5px;
      width: 44px;
      max-height: calc(100vh - 20px);
      overflow: auto;
      padding: 5px;
      pointer-events: auto;
      border: 1px solid var(--mm-line);
      background: var(--mm-bg);
      color: var(--mm-text);
      box-shadow: var(--mm-shadow);
      border-radius: 12px;
    }
    .mm-dock-btn {
      position: relative;
      width: 32px;
      height: 32px;
      display: inline-grid;
      place-items: center;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--mm-text);
      cursor: pointer;
      font-size: 15px;
      font-weight: 850;
      line-height: 1;
    }
    .mm-dock-btn:hover { border-color: var(--mm-accent); background: var(--mm-accent-soft); }
    .mm-dock-btn.active { border-color: var(--mm-accent); background: var(--mm-accent-soft); color: var(--mm-accent); }
    .mm-dock-brand { background: var(--mm-accent); color: #fff; border-color: var(--mm-accent); }
    .mm-dock-brand:hover { background: var(--mm-accent); color: #fff; }
    .mm-dock-count {
      position: absolute;
      top: -5px;
      right: -5px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      display: inline-grid;
      place-items: center;
      border-radius: 999px;
      background: var(--mm-panel);
      color: var(--mm-text);
      border: 1px solid var(--mm-line);
      font-size: 8px;
      font-weight: 850;
    }
    .mm-dock-divider { height: 1px; background: var(--mm-line); margin: 0 3px; }


    #mm-panel {
      position: fixed;
      top: 68px;
      right: 12px;
      width: min(432px, calc(100vw - 24px));
      max-height: calc(100vh - 84px);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      background: var(--mm-bg);
      border: 1px solid var(--mm-line);
      border-radius: var(--mm-radius);
      box-shadow: var(--mm-shadow);
      overflow: hidden;
    }
    .mm-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 12px 10px;
      border-bottom: 1px solid var(--mm-line);
      background: var(--mm-panel);
    }
    .mm-brand { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
    .mm-brand strong { font-size: 15px; letter-spacing: .06em; }
    .mm-version { color: var(--mm-muted); font-size: 10px; white-space: nowrap; }
    .mm-save { display: inline-flex; align-items: center; gap: 5px; color: var(--mm-muted); font-size: 10px; }
    .mm-save-dot { width: 7px; height: 7px; border-radius: 50%; background: #2e7d32; box-shadow: 0 0 0 2px rgba(46,125,50,.15); }
    .mm-save.saving .mm-save-dot { background: #f9a825; box-shadow: 0 0 0 2px rgba(249,168,37,.15); }
    .mm-save.failed { color: #b3261e; }
    .mm-save.failed .mm-save-dot { background: #b3261e; box-shadow: 0 0 0 2px rgba(179,38,30,.16); }
    .mm-icon-btn {
      width: 30px;
      height: 30px;
      border: 1px solid var(--mm-line);
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
      display: inline-grid;
      place-items: center;
      font-size: 17px;
    }
    .mm-icon-btn:hover { background: var(--mm-accent-soft); }
    .mm-scroll { overflow: auto; padding: 11px; }
    .mm-section { margin-bottom: 12px; }
    .mm-section:last-child { margin-bottom: 0; }
    .mm-section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 6px;
      color: var(--mm-muted);
      font-size: 10px;
      font-weight: 850;
      letter-spacing: .11em;
      text-transform: uppercase;
    }
    .mm-row { display: flex; gap: 7px; align-items: center; }
    .mm-row > * { min-width: 0; }
    .mm-field, .mm-select, .mm-textarea {
      width: 100%;
      border: 1px solid var(--mm-line);
      border-radius: 8px;
      background: var(--mm-panel);
      color: var(--mm-text);
      padding: 8px 9px;
      outline: none;
    }
    .mm-field:focus, .mm-select:focus, .mm-textarea:focus { border-color: var(--mm-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--mm-accent) 18%, transparent); }
    .mm-textarea { min-height: 74px; resize: vertical; line-height: 1.35; }
    .mm-check { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--mm-muted); white-space: nowrap; }
    .mm-check input { accent-color: var(--mm-accent); }
    .mm-tools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .mm-tool {
      border: 1px solid var(--mm-line);
      border-radius: 8px;
      background: var(--mm-panel);
      color: var(--mm-text);
      padding: 8px 5px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 720;
    }
    .mm-tool:hover { border-color: var(--mm-accent); }
    .mm-tool.active { background: var(--mm-accent-soft); border-color: var(--mm-accent); color: var(--mm-accent); }
    .mm-colors { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    .mm-color {
      width: 24px;
      height: 24px;
      padding: 0;
      border: 2px solid transparent;
      border-radius: 50%;
      cursor: pointer;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.18);
    }
    .mm-color.active { outline: 2px solid var(--mm-text); outline-offset: 2px; }
    .mm-range { flex: 1; accent-color: var(--mm-accent); }
    .mm-status {
      padding: 8px 9px;
      border: 1px solid var(--mm-line);
      border-radius: 8px;
      color: var(--mm-muted);
      background: var(--mm-panel);
      font-size: 11px;
      line-height: 1.35;
    }
    .mm-status.warn { border-color: #f9a825; color: #8a5a00; background: rgba(249,168,37,.11); }
    @media (prefers-color-scheme: dark) {
      .mm-status.warn { color: #ffd180; }
    }
    .mm-register-controls { display: grid; gap: 7px; }
    .mm-filter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
    .mm-filter-grid .wide { grid-column: 1 / -1; }
    .mm-metrics { display: grid; gap: 5px; }
    .mm-metric-row { display: flex; flex-wrap: wrap; gap: 5px; }
    .mm-metric {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 7px;
      border: 1px solid var(--mm-line);
      border-radius: 999px;
      background: var(--mm-panel);
      color: var(--mm-muted);
      cursor: pointer;
      font-size: 9px;
      font-weight: 760;
    }
    .mm-metric:hover, .mm-metric.active { border-color: var(--mm-accent); background: var(--mm-accent-soft); color: var(--mm-accent); }
    .mm-metric strong { color: inherit; font-size: 10px; }
    .mm-list { display: grid; gap: 5px; max-height: 265px; overflow: auto; }
    .mm-list-item {
      display: grid;
      grid-template-columns: 10px minmax(0,1fr) auto;
      align-items: center;
      gap: 7px;
      width: 100%;
      padding: 7px;
      border: 1px solid var(--mm-line);
      border-radius: 8px;
      background: var(--mm-panel);
      color: var(--mm-text);
      text-align: left;
      cursor: pointer;
    }
    .mm-list-item:hover, .mm-list-item.active { border-color: var(--mm-accent); background: var(--mm-accent-soft); }
    .mm-list-item.primary { box-shadow: inset 3px 0 0 var(--mm-accent); }
    .mm-list-dot { width: 8px; height: 8px; border-radius: 50%; }
    .mm-list-main { min-width: 0; }
    .mm-list-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 760; }
    .mm-list-meta { display: block; color: var(--mm-muted); font-size: 9px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mm-list-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 3px; max-width: 112px; }
    .mm-chip { border: 1px solid var(--mm-line); border-radius: 999px; padding: 2px 5px; color: var(--mm-muted); font-size: 9px; }
    .mm-chip.status-open { color: #1565c0; border-color: color-mix(in srgb, #1565c0 45%, var(--mm-line)); }
    .mm-chip.status-review { color: #9a6400; border-color: color-mix(in srgb, #f9a825 55%, var(--mm-line)); }
    .mm-chip.status-resolved { color: #2e7d32; border-color: color-mix(in srgb, #2e7d32 45%, var(--mm-line)); }
    .mm-chip.status-archived { color: var(--mm-muted); border-style: dashed; }
    .mm-chip.priority-high, .mm-chip.priority-critical { color: #b3261e; border-color: color-mix(in srgb, #b3261e 45%, var(--mm-line)); }
    .mm-bulk { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--mm-line); border-radius: 8px; background: var(--mm-panel); }
    .mm-bulk-title { color: var(--mm-muted); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .mm-geometry-summary { display:grid; gap:4px; padding:8px; border:1px solid var(--mm-line); border-radius:8px; background:var(--mm-panel); color:var(--mm-muted); font-size:10px; line-height:1.4; }
    .mm-legend-row { display:flex; align-items:center; gap:7px; min-width:0; }
    .mm-legend-swatch { width:11px; height:11px; border-radius:3px; flex:0 0 auto; border:1px solid rgba(0,0,0,.2); }
    .mm-coordinate-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .mm-coordinate { color: var(--mm-muted); font-size: 9px; line-height: 1.45; padding: 7px 8px; border: 1px dashed var(--mm-line); border-radius: 7px; }
    .mm-project-card { display:grid; gap:7px; padding:9px; border:1px solid var(--mm-line); border-radius:9px; background:var(--mm-panel); }
    .mm-project-meta { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .mm-layer-list { display:grid; gap:5px; margin-top:7px; }
    .mm-layer-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto auto; gap:5px; align-items:center; padding:6px; border:1px solid var(--mm-line); border-radius:8px; background:var(--mm-panel); }
    .mm-layer-row.active { border-color:var(--mm-accent); box-shadow:inset 3px 0 0 var(--mm-accent); }
    .mm-layer-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0; border:0; background:transparent; color:var(--mm-text); text-align:left; cursor:pointer; font-size:10px; font-weight:760; }
    .mm-mini-btn { width:26px; height:26px; display:inline-grid; place-items:center; border:1px solid var(--mm-line); border-radius:7px; background:transparent; color:var(--mm-text); cursor:pointer; font-size:12px; }
    .mm-mini-btn:hover, .mm-mini-btn.active { border-color:var(--mm-accent); background:var(--mm-accent-soft); color:var(--mm-accent); }
    .mm-import-report { padding:8px; border:1px solid var(--mm-line); border-radius:8px; background:var(--mm-panel); color:var(--mm-muted); font-size:10px; line-height:1.4; }
    .mm-diagnostics { display:grid; gap:7px; padding:9px; border:1px solid var(--mm-line); border-radius:9px; background:var(--mm-panel); }
    .mm-diag-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .mm-diag-item { min-width:0; padding:7px; border:1px solid var(--mm-line); border-radius:7px; background:var(--mm-bg); }
    .mm-diag-item span { display:block; color:var(--mm-muted); font-size:8px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .mm-diag-item strong { display:block; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; }
    .mm-diag-log { display:grid; gap:5px; max-height:150px; overflow:auto; }
    .mm-diag-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px; align-items:center; padding:6px 7px; border:1px solid var(--mm-line); border-radius:7px; }
    .mm-diag-row small { display:block; color:var(--mm-muted); font-size:8px; margin-top:2px; }
    .mm-warning-banner { padding:8px; border:1px solid #b3261e; border-radius:8px; background:rgba(179,38,30,.09); color:#8f1d17; font-size:10px; line-height:1.4; }
    @media (prefers-color-scheme: dark) { .mm-warning-banner { color:#ffb4ab; } }
    .mm-lock-banner { padding:8px; border:1px solid #f9a825; border-radius:8px; background:rgba(249,168,37,.11); color:#8a5a00; font-size:10px; line-height:1.4; }
    @media (prefers-color-scheme: dark) { .mm-lock-banner { color:#ffd180; } }
    .mm-empty { padding: 11px; border: 1px dashed var(--mm-line); border-radius: 8px; color: var(--mm-muted); text-align: center; font-size: 11px; }
    .mm-inspector { display: grid; gap: 7px; }
    .mm-selection-summary { padding: 10px; border: 1px solid var(--mm-line); border-radius: 8px; background: var(--mm-panel); font-size: 11px; line-height: 1.45; }
    .mm-help { color: var(--mm-muted); font-size: 9px; line-height: 1.4; }
    .mm-label { display: grid; gap: 4px; color: var(--mm-muted); font-size: 10px; font-weight: 700; }
    .mm-actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
    .mm-btn {
      border: 1px solid var(--mm-line);
      border-radius: 8px;
      background: var(--mm-panel);
      color: var(--mm-text);
      padding: 8px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 760;
    }
    .mm-btn:hover { border-color: var(--mm-accent); }
    .mm-btn.primary { background: var(--mm-accent); color: #fff; border-color: var(--mm-accent); }
    .mm-btn.danger { color: #b3261e; }
    .mm-btn:disabled { opacity: .45; cursor: not-allowed; }
    .mm-btn.busy { position: relative; padding-left: 27px; }
    .mm-btn.busy::before {
      content: '';
      position: absolute;
      left: 9px;
      top: 50%;
      width: 10px;
      height: 10px;
      margin-top: -6px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: mm-spin .7s linear infinite;
    }
    .mm-evidence-options { display: grid; gap: 7px; padding: 8px; border: 1px solid var(--mm-line); border-radius: 8px; background: var(--mm-panel); }
    .mm-evidence-checks { display: flex; flex-wrap: wrap; gap: 6px 10px; }
    @keyframes mm-spin { to { transform: rotate(360deg); } }
    .mm-new-collection { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 5px; margin-top: 6px; }
    .mm-footer {
      padding: 8px 11px;
      border-top: 1px solid var(--mm-line);
      color: var(--mm-muted);
      background: var(--mm-panel);
      font-size: 9px;
      line-height: 1.35;
    }

    /* v1.7 workflow shell */
    #mm-panel {
      top: 56px;
      width: min(500px, calc(100vw - 24px));
      height: min(780px, calc(100vh - 68px));
      max-height: calc(100vh - 68px);
    }
    .mm-header { flex: 0 0 auto; padding: 10px 11px; }
    .mm-header-actions { display:flex; align-items:center; gap:6px; }
    .mm-contextbar {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 7px;
      padding: 9px 10px;
      border-bottom: 1px solid var(--mm-line);
      background: var(--mm-bg);
    }
    .mm-context-field { min-width:0; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px; align-items:end; }
    .mm-context-field label { min-width:0; display:grid; gap:3px; color:var(--mm-muted); font-size:8px; font-weight:850; letter-spacing:.08em; text-transform:uppercase; }
    .mm-context-field .mm-select { min-width:0; padding:7px 8px; font-size:10px; font-weight:720; }
    .mm-workflow-tabs {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 2px;
      padding: 5px 7px 0;
      border-bottom: 1px solid var(--mm-line);
      background: var(--mm-panel);
    }
    .mm-workflow-tab {
      position:relative;
      display:grid;
      place-items:center;
      gap:2px;
      min-width:0;
      padding:7px 3px 8px;
      border:0;
      border-bottom:3px solid transparent;
      background:transparent;
      color:var(--mm-muted);
      cursor:pointer;
      font-size:9px;
      font-weight:780;
    }
    .mm-workflow-tab .mm-tab-icon { font-size:14px; line-height:1; }
    .mm-workflow-tab .mm-tab-badge { position:absolute; top:3px; right:5px; min-width:15px; height:15px; display:grid; place-items:center; padding:0 3px; border-radius:999px; background:var(--mm-bg); border:1px solid var(--mm-line); font-size:7px; }
    .mm-workflow-tab:hover { color:var(--mm-text); background:var(--mm-bg); }
    .mm-workflow-tab.active { color:var(--mm-accent); border-bottom-color:var(--mm-accent); }
    .mm-workspace { min-height:0; flex:1 1 auto; overflow:hidden; }
    .mm-pane { height:100%; overflow:auto; padding:12px; scroll-padding-top:12px; }
    .mm-pane-header { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:11px; }
    .mm-pane-heading { min-width:0; }
    .mm-pane-heading h2 { margin:0; font-size:16px; line-height:1.15; letter-spacing:-.01em; }
    .mm-pane-heading p { margin:4px 0 0; color:var(--mm-muted); font-size:10px; line-height:1.4; }
    .mm-pane-count { flex:0 0 auto; padding:4px 7px; border:1px solid var(--mm-line); border-radius:999px; color:var(--mm-muted); background:var(--mm-panel); font-size:9px; font-weight:760; }
    .mm-card { margin-bottom:10px; padding:10px; border:1px solid var(--mm-line); border-radius:10px; background:var(--mm-panel); }
    .mm-card:last-child { margin-bottom:0; }
    .mm-card-title { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; color:var(--mm-muted); font-size:9px; font-weight:850; letter-spacing:.09em; text-transform:uppercase; }
    .mm-card-title strong { color:var(--mm-text); font-size:10px; letter-spacing:0; text-transform:none; }
    .mm-tool-grid-primary { grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .mm-tool-grid-advanced { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top:7px; }
    .mm-tool-grid-primary .mm-tool { min-height:48px; display:grid; place-items:center; gap:3px; padding:6px 2px; font-size:9px; }
    .mm-tool-grid-primary .mm-tool .mm-tool-icon { font-size:17px; line-height:1; }
    .mm-tool-grid-advanced .mm-tool { min-height:36px; }
    .mm-disclosure { margin-top:8px; border:1px solid var(--mm-line); border-radius:8px; background:var(--mm-bg); }
    .mm-disclosure > summary { list-style:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 9px; cursor:pointer; color:var(--mm-muted); font-size:10px; font-weight:760; }
    .mm-disclosure > summary::-webkit-details-marker { display:none; }
    .mm-disclosure > summary::after { content:'+'; font-size:14px; }
    .mm-disclosure[open] > summary::after { content:'−'; }
    .mm-disclosure-body { padding:0 8px 8px; }
    .mm-style-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:7px; margin-top:9px; }
    .mm-style-line { display:flex; align-items:center; gap:7px; padding:7px 8px; border:1px solid var(--mm-line); border-radius:8px; background:var(--mm-bg); }
    .mm-style-line span { color:var(--mm-muted); font-size:9px; white-space:nowrap; }
    .mm-status-strip { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; align-items:center; margin-bottom:10px; }
    .mm-status-strip .mm-status { padding:7px 8px; }
    .mm-drawing-actions { display:flex; gap:5px; }
    .mm-drawing-actions .mm-btn { padding:7px 9px; white-space:nowrap; }
    .mm-selection-bar { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; align-items:center; padding:8px; border:1px solid var(--mm-line); border-radius:9px; background:var(--mm-panel); margin-bottom:10px; }
    .mm-selection-bar strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
    .mm-selection-bar small { display:block; margin-top:2px; color:var(--mm-muted); font-size:9px; }
    .mm-selection-actions { display:flex; gap:5px; }
    .mm-commandbar { flex:0 0 auto; display:flex; align-items:center; gap:5px; padding:7px 9px; border-top:1px solid var(--mm-line); background:var(--mm-panel); }
    .mm-commandbar .mm-mini-btn { width:30px; height:30px; }
    .mm-command-spacer { flex:1; }
    .mm-command-label { max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--mm-muted); font-size:9px; }
    .mm-command-btn { height:30px; padding:0 9px; border:1px solid var(--mm-line); border-radius:7px; background:transparent; color:var(--mm-text); cursor:pointer; font-size:9px; font-weight:760; }
    .mm-command-btn:hover { border-color:var(--mm-accent); background:var(--mm-accent-soft); }
    .mm-command-btn:disabled { opacity:.4; cursor:not-allowed; }
    .mm-pane .mm-section { margin-bottom:10px; }
    .mm-pane .mm-section > .mm-section-title { margin-bottom:7px; }
    .mm-pane-review .mm-list { max-height:none; }
    .mm-pane-project .mm-textarea { min-height:62px; }
    .mm-filter-summary { display:flex; align-items:center; gap:6px; }
    .mm-filter-count { min-width:17px; height:17px; display:grid; place-items:center; border-radius:999px; background:var(--mm-accent-soft); color:var(--mm-accent); font-size:8px; }
    .mm-system-intro { margin-bottom:10px; padding:9px; border:1px solid var(--mm-line); border-radius:9px; background:var(--mm-panel); color:var(--mm-muted); font-size:10px; line-height:1.45; }
    @media (max-width: 620px) {
      #mm-panel { top:8px; right:8px; width:calc(100vw - 16px); height:calc(100vh - 16px); max-height:calc(100vh - 16px); }
      .mm-contextbar { grid-template-columns:1fr; }
      .mm-workflow-tab { font-size:8px; }
      .mm-workflow-tab .mm-tab-icon { font-size:13px; }
      .mm-tool-grid-primary { grid-template-columns:repeat(3, minmax(0,1fr)); }
    }

    /* v1.7.1 contrast and readability pass */
    :host {
      --mm-panel-soft: color-mix(in srgb, var(--mm-panel) 88%, var(--mm-bg));
    }
    input::placeholder, textarea::placeholder { color: color-mix(in srgb, var(--mm-muted) 82%, transparent); opacity: 1; }
    .mm-version, .mm-save, .mm-pane-heading p, .mm-pane-count, .mm-command-label, .mm-list-meta, .mm-check,
    .mm-help, .mm-filter-summary, .mm-card-title, .mm-context-field label, .mm-section-title,
    .mm-selection-bar small, .mm-system-intro, .mm-import-report, .mm-status, .mm-empty, .mm-chip, .mm-bulk-title,
    .mm-style-line span, .mm-diag-item span, .mm-diag-row small {
      color: color-mix(in srgb, var(--mm-text) 74%, var(--mm-panel));
    }
    .mm-field, .mm-select, .mm-textarea, .mm-btn, .mm-tool, .mm-mini-btn, .mm-command-btn, .mm-metric,
    .mm-list-item, .mm-card, .mm-selection-bar, .mm-bulk, .mm-status, .mm-system-intro, .mm-import-report,
    .mm-diag-item, .mm-disclosure, .mm-style-line {
      background: var(--mm-panel-soft);
    }
    .mm-field, .mm-select, .mm-textarea { font-size: 11px; }
    .mm-field option, .mm-select option { color: #111; }
    .mm-context-field label, .mm-section-title, .mm-card-title, .mm-pane-count, .mm-command-label, .mm-filter-count, .mm-chip, .mm-metric, .mm-disclosure > summary,
    .mm-list-meta, .mm-selection-bar small, .mm-bulk-title, .mm-workflow-tab, .mm-workflow-tab .mm-tab-badge {
      font-size: 10px;
    }
    .mm-pane-heading p { font-size: 11px; }
    .mm-workflow-tab .mm-tab-icon { font-size: 15px; }
    .mm-workflow-tab { color: color-mix(in srgb, var(--mm-text) 68%, var(--mm-panel)); }
    .mm-workflow-tab:hover { color: var(--mm-text); }
    .mm-workflow-tab.active { background: color-mix(in srgb, var(--mm-accent) 10%, var(--mm-panel)); }
    .mm-workflow-tab .mm-tab-badge {
      background: var(--mm-panel);
      color: var(--mm-text);
    }
    .mm-pane-count, .mm-filter-count { font-weight: 820; }
    .mm-card-title strong, .mm-list-title, .mm-selection-bar strong { color: var(--mm-text); }
    .mm-disclosure > summary { color: var(--mm-text); }
    .mm-metric { color: color-mix(in srgb, var(--mm-text) 76%, var(--mm-panel)); }
    .mm-metric strong { color: var(--mm-text); }
    .mm-metric:hover, .mm-metric.active {
      color: var(--mm-text);
      background: color-mix(in srgb, var(--mm-accent) 14%, var(--mm-panel));
    }
    .mm-btn:hover, .mm-mini-btn:hover, .mm-mini-btn.active, .mm-command-btn:hover, .mm-tool:hover,
    .mm-tool.active, .mm-list-item:hover, .mm-list-item.active {
      background: color-mix(in srgb, var(--mm-accent) 12%, var(--mm-panel));
    }
    .mm-list-item.primary {
      border-color: color-mix(in srgb, var(--mm-accent) 55%, var(--mm-line));
      box-shadow: inset 3px 0 0 var(--mm-accent);
    }
    .mm-chip { background: color-mix(in srgb, var(--mm-panel) 80%, var(--mm-bg)); }
    .mm-chip.status-open { background: rgba(21,101,192,.14); color: #0f62c9; }
    .mm-chip.status-review { background: rgba(249,168,37,.18); color: #8a5a00; }
    .mm-chip.status-resolved { background: rgba(46,125,50,.16); color: #2e7d32; }
    .mm-chip.status-archived { background: color-mix(in srgb, var(--mm-panel) 70%, var(--mm-bg)); }
    .mm-chip.priority-high, .mm-chip.priority-critical { background: rgba(179,38,30,.12); }
    .mm-commandbar, .mm-header, .mm-workflow-tabs { background: var(--mm-panel); }
    .mm-contextbar { background: color-mix(in srgb, var(--mm-panel) 68%, var(--mm-bg)); }
    @media (prefers-color-scheme: dark) {
      :host {
        --mm-bg: rgba(16, 19, 22, .985);
        --mm-panel: #20272d;
        --mm-panel-soft: #242d34;
        --mm-text: #f6f8f9;
        --mm-muted: #d7e0e5;
        --mm-line: #62717b;
        --mm-accent: #ff9b90;
        --mm-accent-soft: rgba(255, 155, 144, .16);
      }
      #mm-panel { background: var(--mm-bg); }
      .mm-contextbar { background: #1a2127; }
      .mm-card, .mm-selection-bar, .mm-bulk, .mm-status, .mm-system-intro, .mm-import-report,
      .mm-list-item, .mm-field, .mm-select, .mm-textarea, .mm-btn, .mm-mini-btn, .mm-command-btn,
      .mm-tool, .mm-metric, .mm-disclosure, .mm-style-line, .mm-diag-item {
        background: #232c33;
      }
      .mm-workflow-tab, .mm-workflow-tab .mm-tab-badge, .mm-pane-count, .mm-card-title,
      .mm-section-title, .mm-command-label, .mm-list-meta, .mm-selection-bar small,
      .mm-context-field label, .mm-filter-summary, .mm-bulk-title, .mm-version, .mm-save,
      .mm-pane-heading p, .mm-help, .mm-style-line span, .mm-chip, .mm-check {
        color: #d8e1e6;
      }
      .mm-icon-btn, .mm-mini-btn, .mm-command-btn, .mm-btn, .mm-tool, .mm-metric, .mm-field, .mm-select, .mm-textarea {
        border-color: #6b7982;
      }
      .mm-card, .mm-selection-bar, .mm-bulk, .mm-disclosure, .mm-system-intro, .mm-import-report, .mm-list-item,
      .mm-status, .mm-style-line, .mm-diag-item {
        border-color: #5d6b74;
      }
      .mm-section-title, .mm-card-title { letter-spacing: .07em; }
      .mm-workflow-tab.active {
        color: #ffd1cb;
        background: rgba(255, 155, 144, .14);
      }
      .mm-metric:hover, .mm-metric.active, .mm-list-item:hover, .mm-list-item.active,
      .mm-btn:hover, .mm-mini-btn:hover, .mm-mini-btn.active, .mm-command-btn:hover, .mm-tool:hover, .mm-tool.active {
        color: #fff7f6;
        background: rgba(255, 155, 144, .14);
      }
      .mm-chip { background: #1c2328; color: #e3ebef; }
      .mm-chip.status-open { background: rgba(52, 127, 232, .2); color: #b7d6ff; border-color: rgba(52, 127, 232, .45); }
      .mm-chip.status-review { background: rgba(255, 193, 7, .18); color: #ffe199; border-color: rgba(255, 193, 7, .35); }
      .mm-chip.status-resolved { background: rgba(76, 175, 80, .18); color: #b7e3b8; border-color: rgba(76, 175, 80, .35); }
      .mm-chip.priority-high, .mm-chip.priority-critical { background: rgba(244, 67, 54, .18); color: #ffcdc9; border-color: rgba(244, 67, 54, .35); }
      .mm-list-item.primary { border-color: rgba(255, 155, 144, .8); }
      .mm-status.warn { background: rgba(249,168,37,.18); color: #ffe199; }
      input::placeholder, textarea::placeholder { color: rgba(215, 224, 229, .78); }
    }

    .mm-hidden { display: none !important; }
    #mm-import { display: none; }
  `;
  shadow.appendChild(style);

  const overlay = svgEl('svg', {
    id: 'mm-overlay',
    'aria-label': 'MAPMARK annotation overlay',
  });
  shadow.appendChild(overlay);

  const shell = document.createElement('div');
  shadow.appendChild(shell);

  const importInput = document.createElement('input');
  importInput.id = 'mm-import';
  importInput.type = 'file';
  importInput.accept = '.mapmark.json,.json,.geojson,.kml,application/json,application/geo+json,application/vnd.google-earth.kml+xml,text/xml,application/xml';
  shadow.appendChild(importInput);

  function loadBootstrapState() {
    let raw = null;
    try {
      raw = GM_getValue(APP.storageKey, null);
      if (!raw) return { state: DEFAULT_STATE(), raw: null, source: 'default', error: null };
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const inspection = validateStateIntegrity(parsed, { strict: Number(parsed?.schema) >= 5 });
      if (!inspection.valid) return { state: DEFAULT_STATE(), raw, source: 'default', error: `Legacy workspace integrity failure: ${inspection.errors.join(' ')}` };
      return { state: normalizeState(parsed), raw, source: 'tampermonkey', error: null };
    } catch (error) {
      console.warn(`[${APP.name}] Legacy bootstrap data could not be read.`, error);
      return { state: DEFAULT_STATE(), raw, source: 'default', error: `Legacy bootstrap error: ${error.message}` };
    }
  }

  function checksumText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function validateStateIntegrity(input, options = {}) {
    const strict = options.strict !== false;
    const errors = [];
    const warnings = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['Workspace is not an object.'], warnings };
    const annotations = Array.isArray(input.annotations) ? input.annotations : [];
    const collections = Array.isArray(input.collections) ? input.collections : [];
    const projects = Array.isArray(input.projects) ? input.projects : [];
    if (!Array.isArray(input.annotations)) errors.push('annotations is not an array.');
    if (strict && !Array.isArray(input.collections)) errors.push('collections is not an array.');
    if (strict && !Array.isArray(input.projects)) errors.push('projects is not an array.');
    const duplicateIds = (items, label) => {
      const seen = new Set();
      for (const item of items) {
        const id = item?.id;
        if (!id) { errors.push(`${label} contains an item without an id.`); continue; }
        if (seen.has(String(id))) errors.push(`${label} contains duplicate id ${id}.`);
        seen.add(String(id));
      }
      return seen;
    };
    const projectIds = duplicateIds(projects, 'projects');
    const layerIds = duplicateIds(collections, 'collections');
    duplicateIds(annotations, 'annotations');
    if (strict) {
      for (const layer of collections) if (!projectIds.has(String(layer.projectId))) errors.push(`Layer ${layer.id} references a missing project.`);
      for (const annotation of annotations) if (!layerIds.has(String(annotation.collectionId))) errors.push(`Annotation ${annotation.id} references a missing layer.`);
      if (input.activeProjectId && !projectIds.has(String(input.activeProjectId))) warnings.push('Active project reference is stale and will be repaired.');
      if (input.activeCollectionId && !layerIds.has(String(input.activeCollectionId))) warnings.push('Active layer reference is stale and will be repaired.');
    }
    for (const annotation of annotations) {
      if (!annotation?.geometry || typeof annotation.geometry !== 'object') { errors.push(`Annotation ${annotation?.id || 'unknown'} has no geometry.`); continue; }
      const geometry = annotation.geometry;
      const coordinateOkay = value => Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
      if (geometry.type === 'Point' && !coordinateOkay(geometry.coordinates)) errors.push(`Annotation ${annotation.id} has an invalid point.`);
      if (geometry.type === 'LineString' && (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || geometry.coordinates.some(value => !coordinateOkay(value)))) errors.push(`Annotation ${annotation.id} has an invalid line.`);
      if (geometry.type === 'Polygon') {
        const ring = geometry.coordinates?.[0];
        if (!Array.isArray(ring) || ring.length < 4 || ring.some(value => !coordinateOkay(value))) errors.push(`Annotation ${annotation.id} has an invalid polygon.`);
      }
      if (!['Point', 'LineString', 'Polygon'].includes(geometry.type)) errors.push(`Annotation ${annotation.id} uses unsupported geometry ${geometry.type || 'unknown'}.`);
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  function openStorageDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB is unavailable in this browser context.')); return; }
      const request = indexedDB.open(APP.dbName, APP.dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('snapshots')) {
          const store = db.createObjectStore('snapshots', { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('quarantine')) {
          const store = db.createObjectStore('quarantine', { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened.'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked by another MAPMARK tab.'));
    });
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function idbTransactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
    });
  }

  async function idbGet(storeName, key) {
    const transaction = storageRuntime.db.transaction(storeName, 'readonly');
    return idbRequest(transaction.objectStore(storeName).get(key));
  }

  async function idbGetAll(storeName) {
    const transaction = storageRuntime.db.transaction(storeName, 'readonly');
    return idbRequest(transaction.objectStore(storeName).getAll());
  }

  async function idbPut(storeName, value) {
    const transaction = storageRuntime.db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await idbTransactionDone(transaction);
  }

  async function idbDelete(storeName, key) {
    const transaction = storageRuntime.db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await idbTransactionDone(transaction);
  }

  function decodeStorageRecord(record) {
    if (!record || typeof record.payload !== 'string') return { valid: false, error: 'Storage record has no payload.' };
    const actualChecksum = checksumText(record.payload);
    if (record.checksum !== actualChecksum) return { valid: false, error: `Checksum mismatch: expected ${record.checksum || 'none'}, calculated ${actualChecksum}.` };
    try {
      const parsed = JSON.parse(record.payload);
      const inspection = validateStateIntegrity(parsed, { strict: Number(parsed.schema) >= 5 });
      if (!inspection.valid) return { valid: false, error: inspection.errors.join(' '), warnings: inspection.warnings };
      return { valid: true, state: normalizeState(parsed), warnings: inspection.warnings, checksum: actualChecksum };
    } catch (error) {
      return { valid: false, error: `JSON parse failed: ${error.message}` };
    }
  }

  async function quarantineStorageRecord(record, reason, source = 'workspace') {
    if (!storageRuntime.db) return;
    const payload = typeof record?.payload === 'string' ? record.payload : JSON.stringify(record?.payload ?? record ?? null);
    await idbPut('quarantine', {
      id: makeId('quarantine'),
      source,
      reason: String(reason || 'Unknown integrity failure'),
      createdAt: new Date().toISOString(),
      checksum: checksumText(payload),
      payload,
    });
    storageRuntime.quarantineCount += 1;
  }

  async function refreshStorageMetadata() {
    if (!storageRuntime.db) return;
    const snapshots = (await idbGetAll('snapshots')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const quarantine = await idbGetAll('quarantine');
    storageRuntime.snapshots = snapshots.map(item => ({ id: item.id, createdAt: item.createdAt, reason: item.reason, annotationCount: item.annotationCount, checksum: item.checksum }));
    storageRuntime.snapshotCount = snapshots.length;
    storageRuntime.quarantineCount = quarantine.length;
    storageRuntime.lastSnapshotAt = snapshots[0]?.createdAt || null;
  }

  async function recoverFromSnapshots() {
    if (!storageRuntime.db) return null;
    const snapshots = (await idbGetAll('snapshots')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const snapshot of snapshots) {
      const decoded = decodeStorageRecord(snapshot);
      if (decoded.valid) return { state: decoded.state, snapshot };
      await quarantineStorageRecord(snapshot, decoded.error, 'snapshot');
      await idbDelete('snapshots', snapshot.id);
    }
    return null;
  }

  async function initializeReliabilityStorage() {
    try {
      storageRuntime.db = await openStorageDatabase();
      storageRuntime.mode = 'IndexedDB';
      if (bootstrap.error && bootstrap.raw !== null) await quarantineStorageRecord({ payload: typeof bootstrap.raw === 'string' ? bootstrap.raw : JSON.stringify(bootstrap.raw) }, bootstrap.error, 'legacy-tampermonkey');
      const record = await idbGet('workspaces', APP.workspaceId);
      if (record) {
        const decoded = decodeStorageRecord(record);
        if (decoded.valid) {
          state = decoded.state;
          storageRuntime.integrity = 'Verified';
          storageRuntime.lastSavedAt = record.savedAt || null;
          storageRuntime.payloadBytes = record.payload.length;
        } else {
          await quarantineStorageRecord(record, decoded.error, 'workspace');
          await idbDelete('workspaces', APP.workspaceId);
          const recovery = await recoverFromSnapshots();
          if (recovery) {
            state = recovery.state;
            storageRuntime.integrity = 'Recovered';
            storageRuntime.recoveredFrom = recovery.snapshot.createdAt;
            storageRuntime.migration = 'Recovered the workspace from a verified snapshot.';
            await persistStateNow('recovery-restore', { forceSnapshot: false });
          } else {
            state = bootstrap.state;
            storageRuntime.integrity = 'Fallback';
            storageRuntime.migration = 'The damaged IndexedDB record was quarantined; MAPMARK used the emergency Tampermonkey mirror.';
            await persistStateNow('fallback-rebuild', { forceSnapshot: true });
          }
        }
      } else {
        state = normalizeState(bootstrap.state);
        storageRuntime.integrity = 'Verified';
        storageRuntime.migration = bootstrap.source === 'tampermonkey'
          ? 'Migrated the existing MAPMARK workspace into IndexedDB.'
          : 'Initialized a new IndexedDB workspace.';
        await persistStateNow('indexeddb-migration', { forceSnapshot: true });
      }
      if (pendingFocusCandidate && state.annotations.some(annotation => annotation.id === pendingFocusCandidate)) {
        pendingFocusId = pendingFocusCandidate;
        ui.expanded = true;
        setSelection([pendingFocusCandidate], pendingFocusCandidate, false);
      }
      await refreshStorageMetadata();
      storageRuntime.ready = true;
      storageRuntime.lastError = null;
      renderAll();
    } catch (error) {
      console.error(`[${APP.name}] IndexedDB initialization failed.`, error);
      storageRuntime.mode = 'Tampermonkey fallback';
      storageRuntime.integrity = 'Fallback';
      storageRuntime.fallbackReason = error.message;
      storageRuntime.lastError = null;
      storageRuntime.ready = true;
      renderAll();
      setStatus('IndexedDB is unavailable. MAPMARK is using its emergency Tampermonkey storage mirror.', true);
    }
  }

  function normalizeState(input) {
    const fresh = DEFAULT_STATE();
    if (!input || typeof input !== 'object') return fresh;
    const legacyProjectId = 'project-default';
    const rawProjects = Array.isArray(input.projects) && input.projects.length
      ? input.projects
      : [{
          id: legacyProjectId,
          name: String(input.project?.name || 'Field Project'),
          description: String(input.project?.description || ''),
          reference: String(input.project?.reference || ''),
          status: 'active',
          createdAt: input.project?.createdAt || new Date().toISOString(),
          updatedAt: input.project?.updatedAt || new Date().toISOString(),
        }];
    const projects = rawProjects.filter(project => project && project.id).map(normalizeProject);
    if (!projects.length) projects.push(...fresh.projects);
    const projectIds = new Set(projects.map(project => project.id));
    const rawCollections = Array.isArray(input.collections) && input.collections.length ? input.collections : fresh.collections;
    const collections = rawCollections
      .filter(item => item && item.id && item.name)
      .map((collection, index) => normalizeLayer(collection, projectIds.has(collection.projectId) ? collection.projectId : projects[0].id, index));
    if (!collections.length) collections.push(normalizeLayer(fresh.collections[0], projects[0].id, 0));
    for (const project of projects) {
      if (!collections.some(layer => layer.projectId === project.id)) {
        collections.push(normalizeLayer({ id: makeId('layer'), name: 'Field Notes' }, project.id, collections.length));
      }
    }
    const requestedProject = projects.some(project => project.id === input.activeProjectId) ? input.activeProjectId : projects.find(project => project.status !== 'archived')?.id || projects[0].id;
    const projectLayers = collections.filter(layer => layer.projectId === requestedProject && !layer.archived);
    const activeCollectionId = projectLayers.some(layer => layer.id === input.activeCollectionId)
      ? input.activeCollectionId
      : (projectLayers[0] || collections.find(layer => layer.projectId === requestedProject) || collections[0]).id;
    const register = input.preferences?.register || {};
    const evidence = input.preferences?.evidence || {};
    const reliability = input.preferences?.reliability || {};
    return {
      schema: 6,
      activeProjectId: requestedProject,
      activeCollectionId,
      showAllCollections: Boolean(input.showAllCollections),
      projects,
      collections,
      annotations: Array.isArray(input.annotations)
        ? input.annotations.filter(isValidAnnotation).map(annotation => {
            const normalized = normalizeAnnotation(annotation);
            if (!collections.some(layer => layer.id === normalized.collectionId)) normalized.collectionId = activeCollectionId;
            return normalized;
          })
        : [],
      preferences: {
        color: COLORS.includes(input.preferences?.color) ? input.preferences.color : fresh.preferences.color,
        strokeWidth: clamp(Number(input.preferences?.strokeWidth) || fresh.preferences.strokeWidth, 1, 8),
        markerIcon: Object.prototype.hasOwnProperty.call(MARKER_ICONS, input.preferences?.markerIcon) ? input.preferences.markerIcon : fresh.preferences.markerIcon,
        snap: input.preferences?.snap !== false,
        showArchivedOnMap: Boolean(input.preferences?.showArchivedOnMap),
        showArchivedProjects: Boolean(input.preferences?.showArchivedProjects),
        importStrategy: Object.prototype.hasOwnProperty.call(IMPORT_STRATEGIES, input.preferences?.importStrategy) ? input.preferences.importStrategy : 'merge',
        reliability: {
          automaticSnapshots: reliability.automaticSnapshots !== false,
          snapshotIntervalMinutes: clamp(Number(reliability.snapshotIntervalMinutes) || 10, 2, 120),
        },
        evidence: {
          title: String(evidence.title || ''),
          subtitle: String(evidence.subtitle || ''),
          scope: Object.prototype.hasOwnProperty.call(EVIDENCE_SCOPES, evidence.scope) ? evidence.scope : 'visible',
          includeTitleBlock: evidence.includeTitleBlock !== false,
          includeLegend: evidence.includeLegend !== false,
          includeNorthArrow: evidence.includeNorthArrow !== false,
          includeScaleBar: evidence.includeScaleBar !== false,
          includeTable: evidence.includeTable !== false,
        },
        register: {
          query: String(register.query || ''),
          tag: String(register.tag || ''),
          type: register.type === 'all' || ANNOTATION_TYPES.includes(register.type) ? register.type : 'all',
          status: register.status === 'all' || Object.prototype.hasOwnProperty.call(STATUS_LABELS, register.status) ? register.status : 'all',
          priority: register.priority === 'all' || Object.prototype.hasOwnProperty.call(PRIORITY_LABELS, register.priority) ? register.priority : 'all',
          color: register.color === 'all' || COLORS.includes(register.color) ? register.color : 'all',
          collection: normalizeRegisterCollection(register.collection, collections),
          sort: Object.prototype.hasOwnProperty.call(REGISTER_SORTS, register.sort) ? register.sort : 'updated-desc',
        },
      },
    };
  }

  function normalizeProject(project) {
    const now = new Date().toISOString();
    return {
      id: String(project.id || makeId('project')),
      name: String(project.name || 'Untitled project'),
      description: String(project.description || ''),
      reference: String(project.reference || ''),
      status: project.status === 'archived' ? 'archived' : 'active',
      createdAt: project.createdAt || now,
      updatedAt: project.updatedAt || project.createdAt || now,
    };
  }

  function normalizeLayer(layer, projectId, order = 0) {
    const now = new Date().toISOString();
    return {
      id: String(layer.id || makeId('layer')),
      projectId: String(projectId),
      name: String(layer.name || 'Untitled layer'),
      visible: layer.visible !== false,
      locked: Boolean(layer.locked),
      archived: Boolean(layer.archived),
      order: Number.isFinite(Number(layer.order)) ? Number(layer.order) : order,
      createdAt: layer.createdAt || now,
      updatedAt: layer.updatedAt || layer.createdAt || now,
    };
  }

  function isValidAnnotation(annotation) {
    return annotation && annotation.id && annotation.type && annotation.geometry && annotation.collectionId;
  }

  function normalizeRegisterCollection(value, collections) {
    if (value === 'scope' || value === 'all') return value;
    if (typeof value === 'string' && value.startsWith('set:') && collections.some(item => `set:${item.id}` === value)) return value;
    return 'scope';
  }

  function normalizeAnnotation(annotation) {
    return {
      id: String(annotation.id),
      type: ANNOTATION_TYPES.includes(annotation.type) ? annotation.type : inferAnnotationType(annotation.geometry, annotation.type) || 'note',
      collectionId: String(annotation.collectionId),
      title: String(annotation.title || defaultTitle(annotation.type)),
      note: String(annotation.note || ''),
      tags: String(annotation.tags || ''),
      status: Object.prototype.hasOwnProperty.call(STATUS_LABELS, annotation.status) ? annotation.status : 'open',
      priority: Object.prototype.hasOwnProperty.call(PRIORITY_LABELS, annotation.priority) ? annotation.priority : 'normal',
      owner: String(annotation.owner || ''),
      legendLabel: String(annotation.legendLabel || ''),
      markerIcon: Object.prototype.hasOwnProperty.call(MARKER_ICONS, annotation.markerIcon) ? annotation.markerIcon : 'pin',
      calloutNumber: annotation.calloutNumber !== null && annotation.calloutNumber !== '' && Number.isFinite(Number(annotation.calloutNumber)) ? Math.max(1, Math.round(Number(annotation.calloutNumber))) : null,
      showMeasurement: annotation.showMeasurement !== false,
      color: /^#[0-9a-f]{6}$/i.test(annotation.color || '') ? annotation.color : COLORS[0],
      strokeWidth: clamp(Number(annotation.strokeWidth) || 3, 1, 8),
      geometry: structuredCloneSafe(annotation.geometry),
      createdAt: annotation.createdAt || new Date().toISOString(),
      updatedAt: annotation.updatedAt || annotation.createdAt || new Date().toISOString(),
    };
  }

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function saveStateSoon(reason = 'autosave') {
    setSaveIndicator(true);
    storageRuntime.pendingSave = true;
    clearTimeout(ui.saveTimer);
    ui.saveTimer = setTimeout(() => {
      persistStateNow(reason).catch(error => {
        console.error(`[${APP.name}] Save failed.`, error);
        storageRuntime.lastError = error.message;
        storageRuntime.pendingSave = false;
        setSaveIndicator(false, true);
        setStatus('Save failed. Open Diagnostics for recovery information.', true);
      });
    }, 220);
  }

  async function persistStateNow(reason = 'autosave', options = {}) {
    const normalized = normalizeState(state);
    const inspection = validateStateIntegrity(normalized, { strict: true });
    if (!inspection.valid) throw new Error(`Workspace integrity check failed: ${inspection.errors.join(' ')}`);
    const payload = JSON.stringify(normalized);
    const checksum = checksumText(payload);
    const savedAt = new Date().toISOString();
    storageRuntime.payloadBytes = payload.length;
    storageRuntime.saveSequence += 1;
    storageRuntime.pendingSave = true;
    if (storageRuntime.db) {
      await idbPut('workspaces', {
        id: APP.workspaceId,
        schema: 6,
        applicationVersion: APP.version,
        savedAt,
        reason,
        checksum,
        payload,
      });
      storageRuntime.mode = 'IndexedDB';
      storageRuntime.integrity = 'Verified';
    } else {
      storageRuntime.mode = 'Tampermonkey fallback';
      storageRuntime.integrity = 'Fallback';
    }
    try { await Promise.resolve(GM_setValue(APP.storageKey, payload)); } catch (mirrorError) { console.warn(`[${APP.name}] Emergency mirror save failed.`, mirrorError); }
    storageRuntime.lastSavedAt = savedAt;
    storageRuntime.lastError = null;
    storageRuntime.pendingSave = false;
    setSaveIndicator(false);
    const reliability = state.preferences.reliability || {};
    const intervalMs = clamp(Number(reliability.snapshotIntervalMinutes) || 10, 2, 120) * 60 * 1000;
    const snapshotDue = reliability.automaticSnapshots !== false && (!storageRuntime.lastSnapshotAt || Date.now() - new Date(storageRuntime.lastSnapshotAt).getTime() >= intervalMs);
    if (storageRuntime.db && (options.forceSnapshot || snapshotDue)) await createRecoverySnapshot(options.snapshotReason || reason, payload, checksum);
    return { savedAt, checksum, bytes: payload.length };
  }

  async function createRecoverySnapshot(reason = 'manual', payloadOverride = null, checksumOverride = null) {
    if (!storageRuntime.db) return null;
    const payload = payloadOverride || JSON.stringify(normalizeState(state));
    const checksum = checksumOverride || checksumText(payload);
    const createdAt = new Date().toISOString();
    const parsed = JSON.parse(payload);
    const snapshot = {
      id: makeId('snapshot'),
      schema: 6,
      applicationVersion: APP.version,
      createdAt,
      reason: String(reason || 'manual'),
      checksum,
      payload,
      annotationCount: Array.isArray(parsed.annotations) ? parsed.annotations.length : 0,
      projectCount: Array.isArray(parsed.projects) ? parsed.projects.length : 0,
    };
    await idbPut('snapshots', snapshot);
    storageRuntime.lastSnapshotAt = createdAt;
    await pruneRecoverySnapshots();
    await refreshStorageMetadata();
    if (ui.expanded && ui.diagnosticsOpen) renderShell();
    return snapshot;
  }

  function snapshotBeforeDestructiveChange(reason) {
    if (!storageRuntime.db) return;
    const payload = JSON.stringify(normalizeState(state));
    const checksum = checksumText(payload);
    createRecoverySnapshot(reason, payload, checksum).catch(error => {
      console.warn(`[${APP.name}] Recovery snapshot could not be created.`, error);
      storageRuntime.lastError = error.message;
    });
  }

  async function pruneRecoverySnapshots() {
    if (!storageRuntime.db) return;
    const snapshots = (await idbGetAll('snapshots')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    await Promise.all(snapshots.slice(APP.maxSnapshots).map(snapshot => idbDelete('snapshots', snapshot.id)));
  }

  async function verifyStorageIntegrity() {
    if (!storageRuntime.db) {
      storageRuntime.integrity = 'Fallback';
      storageRuntime.lastError = 'IndexedDB is unavailable.';
      renderShell();
      return false;
    }
    ui.storageBusy = true;
    renderShell();
    try {
      const record = await idbGet('workspaces', APP.workspaceId);
      const decoded = decodeStorageRecord(record);
      storageRuntime.integrity = decoded.valid ? 'Verified' : 'Failed';
      storageRuntime.lastError = decoded.valid ? null : decoded.error;
      await refreshStorageMetadata();
      return decoded.valid;
    } finally {
      ui.storageBusy = false;
      renderShell();
    }
  }

  async function restoreRecoverySnapshot(snapshotId) {
    if (!storageRuntime.db || !snapshotId) return;
    const snapshot = await idbGet('snapshots', snapshotId);
    const decoded = decodeStorageRecord(snapshot);
    if (!decoded.valid) {
      await quarantineStorageRecord(snapshot, decoded.error, 'snapshot');
      await idbDelete('snapshots', snapshotId);
      await refreshStorageMetadata();
      setStatus('That recovery snapshot failed its integrity check and was quarantined.', true);
      renderShell();
      return;
    }
    snapshotBeforeDestructiveChange('before-snapshot-restore');
    pushUndo();
    state = decoded.state;
    setSelection([], null, false);
    storageRuntime.recoveredFrom = snapshot.createdAt;
    storageRuntime.integrity = 'Recovered';
    ui.restoreSnapshotArmed = null;
    await persistStateNow('snapshot-restore', { forceSnapshot: false });
    renderAll();
    setStatus(`Restored recovery snapshot from ${formatDateTime(snapshot.createdAt)}.`, false);
  }

  async function rebuildIndexedDb() {
    const payload = JSON.stringify(normalizeState(state));
    if (storageRuntime.db) storageRuntime.db.close();
    storageRuntime.db = null;
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(APP.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('IndexedDB could not be rebuilt.'));
      request.onblocked = () => reject(new Error('Close other Google Maps tabs before rebuilding storage.'));
    });
    storageRuntime.db = await openStorageDatabase();
    storageRuntime.mode = 'IndexedDB';
    storageRuntime.integrity = 'Verified';
    state = normalizeState(JSON.parse(payload));
    ui.rebuildStorageArmed = false;
    await persistStateNow('storage-rebuild', { forceSnapshot: true, snapshotReason: 'storage-rebuild' });
    await refreshStorageMetadata();
    renderAll();
    setStatus('IndexedDB was rebuilt without changing the current workspace.', false);
  }

  function setSaveIndicator(saving, failed = false) {
    const save = shadow.querySelector('.mm-save');
    if (!save) return;
    save.classList.toggle('saving', saving);
    save.classList.toggle('failed', failed);
    const label = save.querySelector('.mm-save-label');
    if (label) label.textContent = failed ? 'Save failed' : saving ? 'Saving' : 'Saved';
  }

  function pushUndo() {
    ui.undo.push(structuredCloneSafe({
      annotations: state.annotations,
      collections: state.collections,
      projects: state.projects,
      activeProjectId: state.activeProjectId,
      activeCollectionId: state.activeCollectionId,
    }));
    if (ui.undo.length > 40) ui.undo.shift();
    ui.redo.length = 0;
  }

  function restoreSnapshot(snapshot) {
    state.annotations = snapshot.annotations;
    state.collections = snapshot.collections;
    state.projects = snapshot.projects || state.projects;
    state.activeProjectId = snapshot.activeProjectId || state.activeProjectId;
    state.activeCollectionId = snapshot.activeCollectionId;
    const validSelection = [...selectionSet()].filter(id => findAnnotation(id));
    setSelection(validSelection, validSelection.includes(ui.selectedId) ? ui.selectedId : validSelection[0] || null, false);
    saveStateSoon();
    renderAll();
  }

  function undo() {
    if (!ui.undo.length) return;
    ui.redo.push(structuredCloneSafe({
      annotations: state.annotations,
      collections: state.collections,
      projects: state.projects,
      activeProjectId: state.activeProjectId,
      activeCollectionId: state.activeCollectionId,
    }));
    restoreSnapshot(ui.undo.pop());
  }

  function redo() {
    if (!ui.redo.length) return;
    ui.undo.push(structuredCloneSafe({
      annotations: state.annotations,
      collections: state.collections,
      projects: state.projects,
      activeProjectId: state.activeProjectId,
      activeCollectionId: state.activeCollectionId,
    }));
    restoreSnapshot(ui.redo.pop());
  }

  function selectionSet() {
    if (!(ui.selectedIds instanceof Set)) ui.selectedIds = new Set();
    if (ui.selectedId && !ui.selectedIds.has(ui.selectedId)) ui.selectedIds.add(ui.selectedId);
    return ui.selectedIds;
  }

  function selectedAnnotations() {
    const ids = selectionSet();
    return state.annotations.filter(annotation => ids.has(annotation.id));
  }

  function isSelected(id) {
    return selectionSet().has(id);
  }

  function setSelection(ids, primary = null, rerender = true) {
    const valid = [...new Set(ids || [])].filter(id => findAnnotation(id));
    ui.selectedIds = new Set(valid);
    ui.selectedId = primary && ui.selectedIds.has(primary) ? primary : valid[0] || null;
    ui.activeVertex = null;
    if (rerender) renderAll();
  }

  function addToSelection(id, makePrimary = true) {
    if (!findAnnotation(id)) return;
    selectionSet().add(id);
    if (makePrimary) ui.selectedId = id;
    ui.activeVertex = null;
  }

  function toggleSelection(id) {
    const ids = selectionSet();
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    ui.selectedId = ids.has(id) ? id : [...ids][0] || null;
    ui.activeVertex = null;
  }

  function renderAll() {
    renderShell();
    updateMapContext();
    renderOverlay();
  }

  function renderShell() {
    const visibleAnnotations = annotationsForCurrentCollection();
    const registerAnnotations = filteredRegisterAnnotations();
    const registerMetricsData = registerMetrics();
    const selectedList = selectedAnnotations();
    const selected = findAnnotation(ui.selectedId);
    const selectionCount = selectedList.length;
    const evidenceCount = evidenceAnnotations().length;
    const openReviewCount = annotationsForProject(currentProject()?.id).filter(annotation => annotation.status === 'open' || annotation.status === 'review').length;
    const storageNeedsAttention = Boolean(storageRuntime.lastError || storageRuntime.fallbackReason || storageRuntime.integrity === 'Failed');

    shell.innerHTML = ui.expanded ? `
      <aside id="mm-panel" aria-label="${APP.name} controls" data-workspace="${escapeAttr(ui.workspace)}">
        <header class="mm-header">
          <div class="mm-brand">
            <strong>${APP.name}</strong>
            <span class="mm-version">v${APP.version}</span>
            <span class="mm-save ${storageRuntime.pendingSave ? 'saving' : storageRuntime.lastError ? 'failed' : ''}"><span class="mm-save-dot"></span><span class="mm-save-label">${storageRuntime.lastError ? 'Save issue' : storageRuntime.pendingSave ? 'Saving' : 'Saved'}</span></span>
          </div>
          <div class="mm-header-actions">
            <button class="mm-icon-btn" data-action="collapse" title="Collapse (Alt+Shift+M)" aria-label="Collapse">×</button>
          </div>
        </header>
        ${workflowContextMarkup()}
        <nav class="mm-workflow-tabs" aria-label="MAPMARK workflow">
          ${workflowTab('annotate', '✎', 'Annotate')}
          ${workflowTab('review', '☷', 'Review', openReviewCount)}
          ${workflowTab('evidence', '▣', 'Evidence')}
          ${workflowTab('project', '▤', 'Project')}
          ${workflowTab('system', '⚙', 'System', storageNeedsAttention ? '!' : '')}
        </nav>
        <main class="mm-workspace">
          ${workflowPaneMarkup({ visibleAnnotations, registerAnnotations, registerMetricsData, selectedList, selected, selectionCount, evidenceCount })}
        </main>
        ${commandBarMarkup(selectionCount)}
      </aside>
    ` : `
      <nav id="mm-collapsed" aria-label="${APP.name} quick tools">
        <button class="mm-dock-btn mm-dock-brand" data-action="expand" title="Open ${APP.name} (Alt+Shift+M)">M<span class="mm-dock-count">${visibleAnnotations.length}</span></button>
        <div class="mm-dock-divider"></div>
        ${dockToolButton('select', '↖', 'Select and edit')}
        ${dockToolButton('note', '●', 'Place note')}
        ${dockToolButton('callout', '①', 'Place numbered callout')}
        ${dockToolButton('marker', '◆', 'Place marker')}
        ${dockToolButton('route', '⌁', 'Draw route')}
        ${dockToolButton('polygon', '⬡', 'Draw polygon')}
        ${dockToolButton('circle', '○', 'Draw circle')}
        ${dockToolButton('label', 'T', 'Place label')}
        ${dockToolButton('arrow', '→', 'Draw arrow')}
        ${dockToolButton('box', '□', 'Draw box')}
        ${dockToolButton('pen', '〰', 'Draw freehand')}
      </nav>
    `;

    bindShellEvents();
  }

  function workflowContextMarkup() {
    const projects = availableProjects();
    const layers = projectLayers(true);
    return `
      <div class="mm-contextbar">
        <div class="mm-context-field">
          <label>Project
            <select class="mm-select" id="mm-project" aria-label="Active project">
              ${projects.map(item => `<option value="${escapeAttr(item.id)}" ${item.id === state.activeProjectId ? 'selected' : ''}>${item.status === 'archived' ? 'Archive · ' : ''}${escapeHtml(item.name)}</option>`).join('')}
            </select>
          </label>
          <button class="mm-mini-btn" data-action="new-project" title="Create project" aria-label="Create project">+</button>
        </div>
        <div class="mm-context-field">
          <label>Active layer
            <select class="mm-select" id="mm-collection" aria-label="Active map layer">
              ${layers.map(layer => `<option value="${escapeAttr(layer.id)}" ${layer.id === state.activeCollectionId ? 'selected' : ''}>${layer.archived ? 'Archive · ' : ''}${layer.locked ? 'Locked · ' : ''}${escapeHtml(layer.name)}</option>`).join('')}
            </select>
          </label>
          <button class="mm-mini-btn" data-action="new-collection" title="Create layer" aria-label="Create layer">+</button>
        </div>
      </div>`;
  }

  function workflowTab(workspace, icon, label, badge = '') {
    return `<button class="mm-workflow-tab ${ui.workspace === workspace ? 'active' : ''}" data-action="set-workspace" data-workspace="${workspace}" aria-current="${ui.workspace === workspace ? 'page' : 'false'}"><span class="mm-tab-icon">${icon}</span><span>${label}</span>${badge !== '' && Number(badge) !== 0 ? `<span class="mm-tab-badge">${escapeHtml(badge)}</span>` : ''}</button>`;
  }

  function workflowPaneMarkup(context) {
    switch (ui.workspace) {
      case 'review': return reviewWorkspaceMarkup(context);
      case 'evidence': return evidenceWorkspaceMarkup(context);
      case 'project': return projectWorkspacePaneMarkup(context);
      case 'system': return systemWorkspaceMarkup(context);
      default: return annotateWorkspaceMarkup(context);
    }
  }

  function paneHeader(title, description, count = '') {
    return `<div class="mm-pane-header"><div class="mm-pane-heading"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>${count !== '' ? `<span class="mm-pane-count">${escapeHtml(count)}</span>` : ''}</div>`;
  }

  function annotateWorkspaceMarkup({ selectedList, selected, selectionCount, visibleAnnotations }) {
    const status = mapStatus();
    const advancedTools = ['arrow', 'route', 'box', 'polygon', 'circle', 'pen'];
    const advancedOpen = advancedTools.includes(ui.tool);
    const markerRelevant = ui.tool === 'marker' || selectedList.some(annotation => annotation.type === 'marker');
    return `
      <div class="mm-pane mm-pane-annotate" data-pane="annotate">
        ${paneHeader('Annotate the map', 'Choose a tool, place markup, then refine the selected annotation.', `${visibleAnnotations.length} visible`)}
        <div class="mm-status-strip">
          <div class="mm-status ${status.warn ? 'warn' : ''}" id="mm-status">${escapeHtml(status.message)} · ${escapeHtml(formatZoom(ui.mapView?.zoom))}</div>
          ${ui.drawing && ['route','polygon'].includes(ui.drawing.type) ? `<div class="mm-drawing-actions"><button class="mm-btn primary" data-action="finish-drawing">Finish</button><button class="mm-btn" data-action="cancel-drawing">Cancel</button></div>` : ''}
        </div>

        <section class="mm-card">
          <div class="mm-card-title"><span>Choose a tool</span><strong>${escapeHtml(TOOL_LABELS[ui.tool])}</strong></div>
          <div class="mm-tools mm-tool-grid-primary">
            ${toolButtonRich('select', '↖', 'Select')}
            ${toolButtonRich('note', '●', 'Note')}
            ${toolButtonRich('callout', '①', 'Callout')}
            ${toolButtonRich('marker', '◆', 'Marker')}
            ${toolButtonRich('label', 'T', 'Label')}
          </div>
          <details class="mm-disclosure" ${advancedOpen ? 'open' : ''}>
            <summary><span>Lines, shapes, and freehand</span><span>6 tools</span></summary>
            <div class="mm-disclosure-body">
              <div class="mm-tools mm-tool-grid-advanced">
                ${toolButton('arrow', '→', 'Arrow')}
                ${toolButton('route', '⌁', 'Route')}
                ${toolButton('box', '□', 'Box')}
                ${toolButton('polygon', '⬡', 'Polygon')}
                ${toolButton('circle', '○', 'Circle')}
                ${toolButton('pen', '〰', 'Draw')}
              </div>
            </div>
          </details>
        </section>

        <section class="mm-card">
          <div class="mm-card-title"><span>Appearance</span><strong id="mm-stroke-value">${state.preferences.strokeWidth}px line</strong></div>
          <div class="mm-colors">
            ${COLORS.map(color => `<button class="mm-color ${state.preferences.color === color ? 'active' : ''}" data-color="${color}" style="background:${color}" title="${color}" aria-label="Use ${color}"></button>`).join('')}
          </div>
          <div class="mm-style-grid">
            <div class="mm-style-line"><span>Line</span><input class="mm-range" id="mm-stroke" type="range" min="1" max="8" step="1" value="${state.preferences.strokeWidth}" aria-label="Line width"></div>
            ${markerRelevant ? `<label class="mm-label">Marker symbol<select class="mm-select" id="mm-marker-icon">${Object.entries(MARKER_ICONS).map(([value, icon]) => `<option value="${value}" ${state.preferences.markerIcon === value ? 'selected' : ''}>${escapeHtml(icon.glyph)} ${escapeHtml(icon.label)}</option>`).join('')}</select></label>` : '<div class="mm-help">Color and line width apply to new markup and the current editable selection.</div>'}
          </div>
          <label class="mm-check" style="margin-top:8px"><input id="mm-snap" type="checkbox" ${state.preferences.snap ? 'checked' : ''}> Snap to nearby annotation anchors and map markers</label>
        </section>

        <section class="mm-card">
          <div class="mm-card-title"><span>Selection details</span><strong>${selectionCount > 1 ? `${selectionCount} selected` : selected ? escapeHtml(TOOL_LABELS[selected.type] || selected.type) : 'Nothing selected'}</strong></div>
          ${selectionCount > 1 ? multiInspectorMarkup(selectedList) : selected ? inspectorMarkup(selected) : '<div class="mm-empty">Select map markup to edit its title, workflow fields, notes, geometry, and layer. Shift-click to select several items.</div>'}
        </section>
      </div>`;
  }

  function toolButtonRich(tool, icon, label) {
    return `<button class="mm-tool ${ui.tool === tool ? 'active' : ''}" data-tool="${tool}" title="${label}"><span class="mm-tool-icon">${icon}</span><span>${label}</span></button>`;
  }

  function reviewWorkspaceMarkup({ registerAnnotations, registerMetricsData, selectedList, selected, selectionCount }) {
    return `
      <div class="mm-pane mm-pane-review" data-pane="review">
        ${paneHeader('Review and resolve', 'Find annotations, assign workflow fields, and move open items toward resolution.', `${registerAnnotations.length} ${registerAnnotations.length === 1 ? 'result' : 'results'}`)}
        ${reviewSelectionMarkup(selectedList, selected, selectionCount)}
        ${registerMarkup(registerAnnotations, registerMetricsData, selectionCount)}
      </div>`;
  }

  function reviewSelectionMarkup(selectedList, selected, selectionCount) {
    if (!selectionCount) return '';
    const title = selectionCount > 1 ? `${selectionCount} annotations selected` : selected?.title || defaultTitle(selected?.type);
    const meta = selectionCount > 1 ? 'Bulk workflow controls are available below.' : `${STATUS_LABELS[selected.status]} · ${PRIORITY_LABELS[selected.priority]} · ${TOOL_LABELS[selected.type]}`;
    return `<div class="mm-selection-bar"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta)}</small></div><div class="mm-selection-actions"><button class="mm-mini-btn" data-action="focus-selected" title="Zoom to selection">◎</button><button class="mm-command-btn" data-action="edit-selection">Edit details</button></div></div>`;
  }

  function evidenceWorkspaceMarkup({ evidenceCount }) {
    return `
      <div class="mm-pane mm-pane-evidence" data-pane="evidence">
        ${paneHeader('Capture evidence', 'Choose the annotation scope once, then create consistent images, reports, and data exports.', `${evidenceCount} scoped`)}
        ${evidenceMarkup(evidenceCount)}
      </div>`;
  }

  function projectWorkspacePaneMarkup() {
    return `
      <div class="mm-pane mm-pane-project" data-pane="project">
        ${paneHeader('Organize the work', 'Manage project metadata, map layers, packages, imports, and portable backups.')}
        ${projectWorkspaceMarkup()}
        ${layerManagerMarkup()}
        ${dataManagementMarkup()}
      </div>`;
  }

  function systemWorkspaceMarkup() {
    return `
      <div class="mm-pane mm-pane-system" data-pane="system">
        ${paneHeader('Storage and diagnostics', 'Verify local storage, create recovery points, and inspect map compatibility without exposing annotation contents.')}
        <div class="mm-system-intro">MAPMARK normally manages reliability automatically. Use these controls only when checking storage health, restoring a recovery point, or diagnosing alignment.</div>
        ${diagnosticsMarkup(true)}
      </div>`;
  }

  function commandBarMarkup(selectionCount) {
    return `<footer class="mm-commandbar"><button class="mm-mini-btn" data-action="undo" ${ui.undo.length ? '' : 'disabled'} title="Undo (Ctrl/Cmd+Z)">↶</button><button class="mm-mini-btn" data-action="redo" ${ui.redo.length ? '' : 'disabled'} title="Redo (Ctrl/Cmd+Shift+Z)">↷</button><button class="mm-command-btn" data-action="toggle-hidden">${ui.hidden ? 'Show markup' : 'Hide markup'}</button><span class="mm-command-spacer"></span><span class="mm-command-label">${selectionCount ? `${selectionCount} selected` : `${annotationsForCurrentCollection().length} visible`}</span>${selectionCount ? `<button class="mm-command-btn" data-action="clear-selection">Clear selection</button>` : ''}</footer>`;
  }

  function diagnosticsMarkup(forceOpen = false) {
    const environment = ui.mapEnvironment || {};
    const detection = ui.mapDetection || {};
    const reliability = state.preferences.reliability || {};
    const recentSnapshots = storageRuntime.snapshots.slice(0, 5);
    const storageWarn = storageRuntime.lastError || storageRuntime.fallbackReason || storageRuntime.integrity === 'Failed';
    const diagnosticsOpen = forceOpen || ui.diagnosticsOpen;
    return `
      <section class="mm-section" id="mm-diagnostics-section">
        <div class="mm-section-title"><span>Reliability</span>${forceOpen ? '<span>Automatic safeguards</span>' : `<button class="mm-mini-btn ${diagnosticsOpen ? 'active' : ''}" data-action="toggle-diagnostics" title="${diagnosticsOpen ? 'Hide' : 'Open'} diagnostics">${diagnosticsOpen ? '−' : '⋯'}</button>`}</div>
        ${!environment.supported && environment.mode !== 'unknown' ? `<div class="mm-warning-banner">${escapeHtml(environment.reason || 'This Google Maps view is not safe for geographic overlay alignment.')}</div>` : ''}
        ${storageRuntime.migration ? `<div class="mm-import-report">${escapeHtml(storageRuntime.migration)}</div>` : ''}
        ${diagnosticsOpen ? `
          <div class="mm-diagnostics">
            ${storageWarn ? `<div class="mm-warning-banner">${escapeHtml(storageRuntime.lastError || storageRuntime.fallbackReason || 'The current storage record did not pass integrity verification.')}</div>` : ''}
            <div class="mm-diag-grid">
              ${diagnosticItem('Storage', storageRuntime.mode)}
              ${diagnosticItem('Integrity', storageRuntime.integrity)}
              ${diagnosticItem('Last saved', storageRuntime.lastSavedAt ? formatDateTime(storageRuntime.lastSavedAt) : 'Not yet')}
              ${diagnosticItem('Workspace size', formatBytes(storageRuntime.payloadBytes))}
              ${diagnosticItem('Snapshots', String(storageRuntime.snapshotCount))}
              ${diagnosticItem('Quarantine', String(storageRuntime.quarantineCount))}
              ${diagnosticItem('Map mode', environment.mode || 'unknown')}
              ${diagnosticItem('Canvas candidates', String(detection.candidates || 0))}
            </div>
            <label class="mm-check"><input id="mm-auto-snapshots" type="checkbox" ${reliability.automaticSnapshots !== false ? 'checked' : ''}> Automatic recovery snapshots</label>
            <label class="mm-label">Snapshot interval
              <select class="mm-select" id="mm-snapshot-interval">
                ${[2,5,10,15,30,60,120].map(value => `<option value="${value}" ${Number(reliability.snapshotIntervalMinutes) === value ? 'selected' : ''}>${value} minutes</option>`).join('')}
              </select>
            </label>
            <div class="mm-actions">
              <button class="mm-btn" data-action="verify-storage" ${ui.storageBusy ? 'disabled' : ''}>Verify storage</button>
              <button class="mm-btn" data-action="create-snapshot" ${ui.storageBusy || !storageRuntime.db ? 'disabled' : ''}>Create snapshot</button>
              <button class="mm-btn" data-action="export-diagnostics">Export diagnostics</button>
              <button class="mm-btn ${ui.rebuildStorageArmed ? 'danger' : ''}" data-action="rebuild-storage" ${ui.storageBusy ? 'disabled' : ''}>${ui.rebuildStorageArmed ? 'Confirm rebuild' : 'Rebuild storage'}</button>
            </div>
            <div class="mm-help">Map detection: ${escapeHtml(detection.source || 'none')} · score ${Number(detection.score || 0).toFixed(1)}. Overlay rendering is blocked in Street View, tilted, rotated, and 3D scenes.</div>
            <div class="mm-section-title" style="margin-top:2px"><span>Recovery snapshots</span><span>${storageRuntime.snapshotCount}</span></div>
            ${recentSnapshots.length ? `<div class="mm-diag-log">${recentSnapshots.map(snapshot => `<div class="mm-diag-row"><div><strong>${escapeHtml(formatDateTime(snapshot.createdAt))}</strong><small>${escapeHtml(snapshot.reason || 'automatic')} · ${Number(snapshot.annotationCount || 0)} annotations</small></div><button class="mm-mini-btn ${ui.restoreSnapshotArmed === snapshot.id ? 'active' : ''}" data-action="restore-snapshot" data-snapshot-id="${escapeAttr(snapshot.id)}" title="${ui.restoreSnapshotArmed === snapshot.id ? 'Confirm restore' : 'Restore snapshot'}">${ui.restoreSnapshotArmed === snapshot.id ? '✓' : '↩'}</button></div>`).join('')}</div>` : '<div class="mm-empty">No recovery snapshots yet.</div>'}
            ${storageRuntime.recoveredFrom ? `<div class="mm-help">Last recovery source: ${escapeHtml(formatDateTime(storageRuntime.recoveredFrom))}</div>` : ''}
          </div>
        ` : `<div class="mm-help">${escapeHtml(storageRuntime.mode)} · ${escapeHtml(storageRuntime.integrity)} · ${storageRuntime.snapshotCount} snapshots</div>`}
      </section>`;
  }

  function diagnosticItem(label, value) {
    return `<div class="mm-diag-item"><span>${escapeHtml(label)}</span><strong title="${escapeAttr(value)}">${escapeHtml(value)}</strong></div>`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function buildDiagnosticsReport() {
    const inspection = validateStateIntegrity(state, { strict: true });
    return {
      application: APP.name,
      applicationVersion: APP.version,
      generatedAt: new Date().toISOString(),
      sourceUrl: location.href,
      browser: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
      storage: {
        mode: storageRuntime.mode,
        ready: storageRuntime.ready,
        integrity: storageRuntime.integrity,
        lastSavedAt: storageRuntime.lastSavedAt,
        lastSnapshotAt: storageRuntime.lastSnapshotAt,
        recoveredFrom: storageRuntime.recoveredFrom,
        migration: storageRuntime.migration,
        payloadBytes: storageRuntime.payloadBytes,
        snapshotCount: storageRuntime.snapshotCount,
        quarantineCount: storageRuntime.quarantineCount,
        lastError: storageRuntime.lastError,
        fallbackReason: storageRuntime.fallbackReason,
      },
      map: {
        view: ui.mapView ? { ...ui.mapView } : null,
        rectangle: ui.mapRect ? { ...ui.mapRect } : null,
        environment: structuredCloneSafe(ui.mapEnvironment),
        detection: structuredCloneSafe(ui.mapDetection),
      },
      workspace: {
        schema: state.schema,
        projects: state.projects.length,
        layers: state.collections.length,
        annotations: state.annotations.length,
        integrityValid: inspection.valid,
        integrityErrors: inspection.errors,
        integrityWarnings: inspection.warnings,
      },
      snapshots: structuredCloneSafe(storageRuntime.snapshots),
    };
  }

  function exportDiagnostics() {
    downloadJson(buildDiagnosticsReport(), `mapmark-diagnostics-${dateStamp()}.json`);
    setStatus('Diagnostics report exported without annotation contents.', false);
  }

  function projectWorkspaceMarkup() {
    const project = currentProject();
    const projectAnnotationCount = annotationsForProject(project?.id).length;
    return `
      <section class="mm-section" id="mm-project-section">
        <div class="mm-section-title"><span>Project package</span><span>${project?.status === 'archived' ? 'Archived' : 'Active'}</span></div>
        ${ui.newProjectOpen ? `
          <div class="mm-project-card" style="margin-bottom:7px">
            <input class="mm-field" id="mm-new-project-name" maxlength="100" placeholder="Project name">
            <select class="mm-select" id="mm-project-template">${Object.entries(PROJECT_TEMPLATES).map(([value, template]) => `<option value="${value}">${escapeHtml(template.label)}</option>`).join('')}</select>
            <div class="mm-row"><button class="mm-btn primary" data-action="add-project">Create project</button><button class="mm-btn" data-action="cancel-project">Cancel</button></div>
          </div>
        ` : ''}
        ${project ? `
          <div class="mm-project-card">
            <div class="mm-row" style="justify-content:space-between"><strong>${projectAnnotationCount} ${projectAnnotationCount === 1 ? 'annotation' : 'annotations'}</strong><span class="mm-chip">${project.status === 'archived' ? 'Archived package' : 'Active package'}</span></div>
            ${project.status === 'archived' ? '<div class="mm-lock-banner">This project is archived. Restore it before adding or editing annotations.</div>' : ''}
            <label class="mm-label">Project name<input class="mm-field" id="mm-project-name" maxlength="100" value="${escapeAttr(project.name)}"></label>
            <label class="mm-label">Description<textarea class="mm-textarea" id="mm-project-description" maxlength="1200" placeholder="Purpose, location, scope, or review context">${escapeHtml(project.description)}</textarea></label>
            <label class="mm-label">Reference<input class="mm-field" id="mm-project-reference" maxlength="160" value="${escapeAttr(project.reference)}" placeholder="Project, case, or work order"></label>
            <div class="mm-actions">
              <button class="mm-btn" data-action="export-project">Export project package</button>
              <button class="mm-btn ${project.status === 'archived' ? '' : 'danger'}" data-action="${project.status === 'archived' ? 'restore-project' : 'archive-project'}">${project.status === 'archived' ? 'Restore project' : ui.projectArchiveArmed ? 'Confirm archive' : 'Archive project'}</button>
            </div>
          </div>
        ` : ''}
        <label class="mm-check" style="margin-top:7px"><input id="mm-show-archived-projects" type="checkbox" ${state.preferences.showArchivedProjects ? 'checked' : ''}> Include archived projects in the project selector</label>
      </section>`;
  }

  function layerManagerMarkup() {
    const layers = projectLayers(true);
    const active = activeLayer();
    return `
      <section class="mm-section" id="mm-layer-section">
        <div class="mm-section-title"><span>Map layers</span><span>${layers.filter(layer => !layer.archived).length} active</span></div>
        ${ui.newCollectionOpen ? `
          <div class="mm-new-collection" style="margin-bottom:7px">
            <input class="mm-field" id="mm-new-collection-name" maxlength="80" placeholder="Layer name">
            <button class="mm-btn primary" data-action="add-collection">Add layer</button>
            <button class="mm-btn" data-action="cancel-collection">Cancel</button>
          </div>
        ` : ''}
        ${active?.locked ? '<div class="mm-lock-banner" style="margin-bottom:7px">The active layer is locked. Its annotations remain visible and selectable, but cannot be changed.</div>' : ''}
        <div class="mm-layer-list">
          ${layers.map(layer => `<div class="mm-layer-row ${layer.id === state.activeCollectionId ? 'active' : ''}" data-layer-row="${escapeAttr(layer.id)}"><button class="mm-layer-name" data-action="activate-layer" data-layer-id="${escapeAttr(layer.id)}" title="Make active">${escapeHtml(layer.name)}</button><button class="mm-mini-btn ${layer.visible ? 'active' : ''}" data-action="toggle-layer-visible" data-layer-id="${escapeAttr(layer.id)}" title="${layer.visible ? 'Hide' : 'Show'} layer">${layer.visible ? '◉' : '○'}</button><button class="mm-mini-btn ${layer.locked ? 'active' : ''}" data-action="toggle-layer-lock" data-layer-id="${escapeAttr(layer.id)}" title="${layer.locked ? 'Unlock' : 'Lock'} layer">${layer.locked ? '🔒' : '🔓'}</button><button class="mm-mini-btn" data-action="archive-layer" data-layer-id="${escapeAttr(layer.id)}" title="${layer.archived ? 'Restore' : 'Archive'} layer">${layer.archived ? '↩' : '⌫'}</button></div>`).join('')}
        </div>
        <div class="mm-row" style="margin-top:8px;align-items:flex-start;flex-wrap:wrap">
          <label class="mm-check"><input id="mm-show-all" type="checkbox" ${state.showAllCollections ? 'checked' : ''}> Show all visible layers</label>
          <label class="mm-check"><input id="mm-show-archived" type="checkbox" ${state.preferences.showArchivedOnMap ? 'checked' : ''}> Show archived annotations</label>
        </div>
      </section>`;
  }

  function dataManagementMarkup() {
    return `
      <section class="mm-section" id="mm-data-section">
        <div class="mm-section-title"><span>Exchange and backup</span><span>Local only</span></div>
        <label class="mm-label">When importing a project package
          <select class="mm-select" id="mm-import-strategy">${Object.entries(IMPORT_STRATEGIES).map(([value, label]) => `<option value="${value}" ${state.preferences.importStrategy === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
        </label>
        ${ui.lastImportReport ? `<div class="mm-import-report" style="margin-top:7px">${escapeHtml(formatImportReport(ui.lastImportReport))}</div>` : ''}
        <div class="mm-actions" style="margin-top:8px">
          <button class="mm-btn" data-action="import">Import package / GeoJSON / KML</button>
          <button class="mm-btn" data-action="export-json">Export workspace backup</button>
          <button class="mm-btn" data-action="copy-package">Copy selected package</button>
          <button class="mm-btn" data-action="export-geojson">Export GeoJSON</button>
          <button class="mm-btn" data-action="export-kml">Export KML</button>
          <button class="mm-btn danger" data-action="clear">${ui.clearArmed ? 'Confirm clear layer' : 'Clear active layer'}</button>
        </div>
      </section>`;
  }

  function evidenceMarkup(evidenceCount) {
    const evidence = state.preferences.evidence;
    const busy = ui.captureBusy;
    return `
      <section class="mm-section" id="mm-evidence-section">
        <div class="mm-section-title"><span>Evidence capture</span><span id="mm-evidence-count">${evidenceCount} scoped</span></div>
        <div class="mm-evidence-options">
          <label class="mm-label">Report title
            <input class="mm-field" id="mm-evidence-title" maxlength="180" value="${escapeAttr(evidence.title)}" placeholder="${escapeAttr(defaultEvidenceTitle())}">
          </label>
          <label class="mm-label">Subtitle or project reference
            <input class="mm-field" id="mm-evidence-subtitle" maxlength="240" value="${escapeAttr(evidence.subtitle)}" placeholder="Optional site, review, case, or project reference">
          </label>
          <label class="mm-label">Annotation scope
            <select class="mm-select" id="mm-evidence-scope">
              ${Object.entries(EVIDENCE_SCOPES).map(([value, label]) => `<option value="${value}" ${evidence.scope === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
          </label>
          <div class="mm-evidence-checks">
            <label class="mm-check"><input id="mm-ev-titleblock" type="checkbox" ${evidence.includeTitleBlock ? 'checked' : ''}> Title block</label>
            <label class="mm-check"><input id="mm-ev-legend" type="checkbox" ${evidence.includeLegend ? 'checked' : ''}> Legend</label>
            <label class="mm-check"><input id="mm-ev-north" type="checkbox" ${evidence.includeNorthArrow ? 'checked' : ''}> North arrow</label>
            <label class="mm-check"><input id="mm-ev-scale" type="checkbox" ${evidence.includeScaleBar ? 'checked' : ''}> Scale bar</label>
            <label class="mm-check"><input id="mm-ev-table" type="checkbox" ${evidence.includeTable ? 'checked' : ''}> Report table</label>
          </div>
          <div class="mm-actions">
            <button class="mm-btn primary ${busy ? 'busy' : ''}" data-action="capture-png" ${busy || !evidenceCount ? 'disabled' : ''}>${busy ? 'Capturing' : 'Capture PNG'}</button>
            <button class="mm-btn ${busy ? 'busy' : ''}" data-action="print-report" ${busy || !evidenceCount ? 'disabled' : ''}>Printable report</button>
            <button class="mm-btn" data-action="export-markdown" ${!evidenceCount ? 'disabled' : ''}>Export Markdown</button>
            <button class="mm-btn" data-action="export-csv" ${!evidenceCount ? 'disabled' : ''}>Export CSV</button>
          </div>
          <div class="mm-help">For PNG and report capture, choose the current browser tab when prompted. MAPMARK temporarily hides its controls while retaining clean geographic markup.</div>
        </div>
      </section>
    `;
  }

  function toolButton(tool, icon, label) {
    return `<button class="mm-tool ${ui.tool === tool ? 'active' : ''}" data-tool="${tool}" title="${label}">${icon} ${label}</button>`;
  }

  function dockToolButton(tool, icon, label) {
    return `<button class="mm-dock-btn ${ui.tool === tool ? 'active' : ''}" data-tool="${tool}" title="${label}" aria-label="${label}">${icon}</button>`;
  }

  function registerMarkup(annotations, metrics, selectionCount) {
    const register = state.preferences.register;
    const activeFilterCount = [register.type !== 'all', register.priority !== 'all', register.color !== 'all', register.collection !== 'scope', Boolean(register.tag), register.sort !== 'updated-desc'].filter(Boolean).length;
    return `
      <section class="mm-section" id="mm-register-section">
        <div class="mm-section-title"><span>Annotation register</span><span id="mm-register-count">${annotations.length} of ${metrics.scopeCount}</span></div>
        <div class="mm-register-controls">
          <input class="mm-field" id="mm-register-search" value="${escapeAttr(register.query)}" placeholder="Search title, notes, tags, owner…" aria-label="Search annotations">
          <div class="mm-metric-row" id="mm-status-metrics">
            ${registerMetric('status', 'all', 'All', metrics.status.all, register.status === 'all')}
            ${Object.keys(STATUS_LABELS).map(status => registerMetric('status', status, STATUS_LABELS[status], metrics.status[status], register.status === status)).join('')}
          </div>
          <details class="mm-disclosure" ${activeFilterCount ? 'open' : ''}>
            <summary><span class="mm-filter-summary">Filters and sorting ${activeFilterCount ? `<span class="mm-filter-count">${activeFilterCount}</span>` : ''}</span><span>Optional</span></summary>
            <div class="mm-disclosure-body">
              <div class="mm-metric-row" id="mm-type-metrics" style="margin-bottom:7px">
                ${registerMetric('type', 'all', 'All types', metrics.type.all, register.type === 'all')}
                ${ANNOTATION_TYPES.map(type => registerMetric('type', type, TOOL_LABELS[type], metrics.type[type], register.type === type)).join('')}
              </div>
              <div class="mm-filter-grid">
                <select class="mm-select" id="mm-filter-type" aria-label="Filter by annotation type">
                  <option value="all">All types</option>
                  ${ANNOTATION_TYPES.map(type => `<option value="${type}" ${register.type === type ? 'selected' : ''}>${escapeHtml(TOOL_LABELS[type])}</option>`).join('')}
                </select>
                <select class="mm-select" id="mm-filter-priority" aria-label="Filter by priority">
                  <option value="all">All priorities</option>
                  ${Object.keys(PRIORITY_LABELS).map(priority => `<option value="${priority}" ${register.priority === priority ? 'selected' : ''}>${escapeHtml(PRIORITY_LABELS[priority])}</option>`).join('')}
                </select>
                <select class="mm-select" id="mm-filter-color" aria-label="Filter by color">
                  <option value="all">All colors</option>
                  ${COLORS.map(color => `<option value="${color}" ${register.color === color ? 'selected' : ''}>${color}</option>`).join('')}
                </select>
                <select class="mm-select" id="mm-filter-collection" aria-label="Filter by map layer">
                  <option value="scope" ${register.collection === 'scope' ? 'selected' : ''}>Visible project layers</option>
                  <option value="all" ${register.collection === 'all' ? 'selected' : ''}>All projects and layers</option>
                  ${projectLayers(true).map(collection => `<option value="set:${escapeAttr(collection.id)}" ${register.collection === `set:${collection.id}` ? 'selected' : ''}>${collection.archived ? 'Archive · ' : ''}${escapeHtml(collection.name)}</option>`).join('')}
                </select>
                <input class="mm-field" id="mm-filter-tag" value="${escapeAttr(register.tag)}" placeholder="Filter tag" aria-label="Filter annotations by tag">
                <select class="mm-select" id="mm-register-sort" aria-label="Sort annotations">
                  ${Object.entries(REGISTER_SORTS).map(([value, label]) => `<option value="${value}" ${register.sort === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
                </select>
              </div>
            </div>
          </details>
          <div class="mm-row">
            <button class="mm-btn" data-action="select-register-results" ${annotations.length ? '' : 'disabled'}>Select results</button>
            <button class="mm-btn" data-action="clear-selection" ${selectionCount ? '' : 'disabled'}>Clear selection</button>
          </div>
          <div class="mm-list" id="mm-register-list">
            ${registerListMarkup(annotations)}
          </div>
          ${selectionCount ? bulkRegisterMarkup(selectionCount) : ''}
        </div>
      </section>
    `;
  }

  function registerMetric(kind, value, label, count, active) {
    return `<button class="mm-metric ${active ? 'active' : ''}" data-register-${kind}="${escapeAttr(value)}"><span>${escapeHtml(label)}</span><strong>${count}</strong></button>`;
  }

  function registerListMarkup(annotations) {
    return annotations.length
      ? annotations.map(annotation => annotationListItem(annotation)).join('')
      : '<div class="mm-empty">No annotations match the current register filters.</div>';
  }

  function annotationListItem(annotation) {
    const collection = state.collections.find(item => item.id === annotation.collectionId);
    const center = annotationCenter(annotation);
    const distanceLabel = center && ui.mapView ? formatDistance(haversineKm([ui.mapView.lng, ui.mapView.lat], center)) : '';
    const owner = annotation.owner ? ` · ${annotation.owner}` : '';
    const distanceText = distanceLabel ? ` · ${distanceLabel}` : '';
    return `
      <button class="mm-list-item ${isSelected(annotation.id) ? 'active' : ''} ${ui.selectedId === annotation.id ? 'primary' : ''}" data-register-id="${escapeAttr(annotation.id)}" title="Select and center this annotation on the map">
        <span class="mm-list-dot" style="background:${annotation.color}"></span>
        <span class="mm-list-main">
          <span class="mm-list-title">${escapeHtml(annotation.title || defaultTitle(annotation.type))}</span>
          <span class="mm-list-meta">${escapeHtml(collection?.name || 'Unknown set')}${escapeHtml(owner)}${escapeHtml(distanceText)}</span>
        </span>
        <span class="mm-list-badges">
          <span class="mm-chip status-${annotation.status}">${escapeHtml(STATUS_LABELS[annotation.status])}</span>
          ${annotation.priority !== 'normal' ? `<span class="mm-chip priority-${annotation.priority}">${escapeHtml(PRIORITY_LABELS[annotation.priority])}</span>` : ''}
          <span class="mm-chip">${escapeHtml(TOOL_LABELS[annotation.type] || annotation.type)}</span>
        </span>
      </button>
    `;
  }

  function bulkRegisterMarkup(selectionCount) {
    return `
      <div class="mm-bulk">
        <div class="mm-bulk-title">Bulk update · ${selectionCount} selected</div>
        <div class="mm-filter-grid">
          <select class="mm-select" id="mm-bulk-status" aria-label="Set status for selected annotations">
            <option value="">Set status…</option>
            ${Object.keys(STATUS_LABELS).map(status => `<option value="${status}">${escapeHtml(STATUS_LABELS[status])}</option>`).join('')}
          </select>
          <select class="mm-select" id="mm-bulk-priority" aria-label="Set priority for selected annotations">
            <option value="">Set priority…</option>
            ${Object.keys(PRIORITY_LABELS).map(priority => `<option value="${priority}">${escapeHtml(PRIORITY_LABELS[priority])}</option>`).join('')}
          </select>
          <input class="mm-field wide" id="mm-bulk-tag" maxlength="80" placeholder="Tag to append to selected annotations">
        </div>
        <button class="mm-btn" data-action="append-bulk-tag">Append tag</button>
      </div>
    `;
  }

  function inspectorMarkup(annotation) {
    const center = annotationCenter(annotation);
    const coordinate = center ? `${center[1].toFixed(6)}, ${center[0].toFixed(6)}` : 'Coordinate unavailable';
    return `
      <div class="mm-inspector" data-inspector-id="${escapeAttr(annotation.id)}">
        ${isAnnotationLocked(annotation) ? '<div class="mm-lock-banner">This annotation belongs to a locked or archived layer. Unlock or restore the layer to edit it.</div>' : ''}
        <label class="mm-label">Title
          <input class="mm-field" id="mm-title" maxlength="160" value="${escapeAttr(annotation.title)}" placeholder="Annotation title">
        </label>
        <div class="mm-filter-grid">
          <label class="mm-label">Status
            <select class="mm-select" id="mm-ann-status">
              ${Object.keys(STATUS_LABELS).map(status => `<option value="${status}" ${annotation.status === status ? 'selected' : ''}>${escapeHtml(STATUS_LABELS[status])}</option>`).join('')}
            </select>
          </label>
          <label class="mm-label">Priority
            <select class="mm-select" id="mm-ann-priority">
              ${Object.keys(PRIORITY_LABELS).map(priority => `<option value="${priority}" ${annotation.priority === priority ? 'selected' : ''}>${escapeHtml(PRIORITY_LABELS[priority])}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="mm-label">Owner
          <input class="mm-field" id="mm-owner" maxlength="160" value="${escapeAttr(annotation.owner)}" placeholder="Person, team, or organization">
        </label>
        <label class="mm-label">Notes
          <textarea class="mm-textarea" id="mm-note" maxlength="4000" placeholder="Context, observation, action, or evidence">${escapeHtml(annotation.note)}</textarea>
        </label>
        <label class="mm-label">Tags
          <input class="mm-field" id="mm-tags" maxlength="300" value="${escapeAttr(annotation.tags)}" placeholder="survey, access, photo, follow-up">
        </label>
        <label class="mm-label">Legend label
          <input class="mm-field" id="mm-legend-label" maxlength="120" value="${escapeAttr(annotation.legendLabel || '')}" placeholder="Optional category shown in exported legends">
        </label>
        ${annotation.type === 'marker' ? `<label class="mm-label">Marker symbol
          <select class="mm-select" id="mm-ann-marker-icon">${Object.entries(MARKER_ICONS).map(([value, icon]) => `<option value="${value}" ${annotation.markerIcon === value ? 'selected' : ''}>${escapeHtml(icon.glyph)} ${escapeHtml(icon.label)}</option>`).join('')}</select>
        </label>` : ''}
        ${annotation.type === 'callout' ? `<label class="mm-label">Callout number<input class="mm-field" id="mm-callout-number" type="number" min="1" max="9999" step="1" value="${annotation.calloutNumber || 1}"></label>` : ''}
        ${['route','polygon','circle'].includes(annotation.type) ? `<label class="mm-check"><input id="mm-show-measurement" type="checkbox" ${annotation.showMeasurement !== false ? 'checked' : ''}> Show measurement label on map and evidence capture</label>` : ''}
        <label class="mm-label">Layer
          <select class="mm-select" id="mm-ann-collection">
            ${projectLayers(false).map(collection => `<option value="${escapeAttr(collection.id)}" ${collection.id === annotation.collectionId ? 'selected' : ''}>${collection.locked ? 'Locked · ' : ''}${escapeHtml(collection.name)}</option>`).join('')}
          </select>
        </label>
        ${geometrySummaryMarkup(annotation)}
        <div class="mm-coordinate-grid">
          <label class="mm-label">Latitude<input class="mm-field" id="mm-coordinate-lat" type="number" step="any" value="${center ? center[1].toFixed(7) : ''}"></label>
          <label class="mm-label">Longitude<input class="mm-field" id="mm-coordinate-lng" type="number" step="any" value="${center ? center[0].toFixed(7) : ''}"></label>
        </div>
        <button class="mm-btn" data-action="apply-coordinates">Move center to exact coordinates</button>
        <div class="mm-coordinate">${escapeHtml(coordinate)}<br>Created ${escapeHtml(formatDateTime(annotation.createdAt))} · Updated ${escapeHtml(formatDateTime(annotation.updatedAt))}</div>
        ${['pen','route','polygon'].includes(annotation.type) ? `<div class="mm-help">Drag visible vertices to reshape this geometry. Select a vertex, then press Delete or use Remove point.</div>` : annotation.type === 'arrow' ? `<div class="mm-help">Drag either endpoint handle to reshape the arrow.</div>` : annotation.type === 'box' ? `<div class="mm-help">Drag a corner handle to resize the marked area.</div>` : annotation.type === 'circle' ? `<div class="mm-help">Drag the radius handle to resize the circle. Drag the shape to move it.</div>` : `<div class="mm-help">Drag the annotation directly on the map to reposition it.</div>`}
        <div class="mm-actions">
          <button class="mm-btn" data-action="zoom-selected">Zoom to selection</button>
          <button class="mm-btn" data-action="duplicate-selected">Duplicate</button>
          ${['pen','route','polygon'].includes(annotation.type) ? `<button class="mm-btn" data-action="delete-vertex" ${ui.activeVertex?.annotationId === annotation.id ? '' : 'disabled'}>Remove point</button>` : ''}
          <button class="mm-btn danger" data-action="delete-selected">Delete</button>
        </div>
      </div>
    `;
  }

  function geometrySummaryMarkup(annotation) {
    const metrics = annotationMeasurements(annotation);
    if (!metrics.length) return '';
    return `<div class="mm-geometry-summary">${metrics.map(([label, value]) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`).join('')}</div>`;
  }

  function multiInspectorMarkup(annotations) {
    const kinds = [...new Set(annotations.map(annotation => TOOL_LABELS[annotation.type] || annotation.type))];
    return `
      <div class="mm-inspector">
        <div class="mm-selection-summary"><strong>${annotations.length} annotations selected</strong><br>${escapeHtml(kinds.join(', '))}</div>
        <div class="mm-help">Drag any selected annotation to move the group. Style changes above apply to the full selection.</div>
        <div class="mm-actions">
          <button class="mm-btn" data-action="zoom-selected">Zoom to selection</button>
          <button class="mm-btn" data-action="duplicate-selected">Duplicate all</button>
          <button class="mm-btn danger" data-action="delete-selected" style="grid-column:1/-1">Delete selected</button>
        </div>
      </div>
    `;
  }

  function bindShellEvents() {
    const panel = shadow.querySelector('#mm-panel');
    const collapsed = shadow.querySelector('#mm-collapsed');
    collapsed?.addEventListener('click', event => {
      const tool = event.target.closest('[data-tool]')?.dataset.tool;
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (tool) {
        setTool(tool);
        return;
      }
      if (action === 'expand') {
        ui.expanded = true;
        if (ui.tool !== 'select') ui.workspace = 'annotate';
        renderShell();
      }
    });
    if (!panel) return;

    panel.addEventListener('click', event => {
      const actionButton = event.target.closest('[data-action]');
      const toolButtonEl = event.target.closest('[data-tool]');
      const colorButton = event.target.closest('[data-color]');
      const registerButton = event.target.closest('[data-register-id]');
      const statusMetric = event.target.closest('[data-register-status]');
      const typeMetric = event.target.closest('[data-register-type]');

      if (toolButtonEl) {
        setTool(toolButtonEl.dataset.tool);
        return;
      }
      if (colorButton) {
        state.preferences.color = colorButton.dataset.color;
        const selectedItems = selectedAnnotations();
        if (selectedItems.length) pushUndo();
        selectedItems.forEach(annotation => {
          annotation.color = state.preferences.color;
          annotation.updatedAt = new Date().toISOString();
        });
        saveStateSoon();
        renderAll();
        return;
      }
      if (statusMetric) {
        state.preferences.register.status = statusMetric.dataset.registerStatus;
        saveStateSoon();
        refreshRegisterView();
        return;
      }
      if (typeMetric) {
        state.preferences.register.type = typeMetric.dataset.registerType;
        saveStateSoon();
        refreshRegisterView();
        return;
      }
      if (registerButton) {
        const id = registerButton.dataset.registerId;
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          toggleSelection(id);
          ui.tool = 'select';
          renderAll();
        } else {
          setSelection([id], id, false);
          ui.tool = 'select';
          centerOnAnnotation(id);
        }
        return;
      }
      if (!actionButton) return;
      handleAction(actionButton.dataset.action, actionButton.dataset);
    });

    panel.querySelector('#mm-project')?.addEventListener('change', event => {
      switchProject(event.target.value);
    });

    panel.querySelector('#mm-show-archived-projects')?.addEventListener('change', event => {
      state.preferences.showArchivedProjects = event.target.checked;
      saveStateSoon();
      renderAll();
    });

    panel.querySelector('#mm-import-strategy')?.addEventListener('change', event => {
      state.preferences.importStrategy = event.target.value;
      saveStateSoon();
    });

    panel.querySelector('#mm-auto-snapshots')?.addEventListener('change', event => {
      state.preferences.reliability.automaticSnapshots = event.target.checked;
      saveStateSoon('reliability-preference');
    });

    panel.querySelector('#mm-snapshot-interval')?.addEventListener('change', event => {
      state.preferences.reliability.snapshotIntervalMinutes = clamp(Number(event.target.value) || 10, 2, 120);
      saveStateSoon('reliability-preference');
    });

    bindProjectMetadata(panel);

    panel.querySelector('#mm-collection')?.addEventListener('change', event => {
      switchLayer(event.target.value);
    });

    panel.querySelector('#mm-show-all')?.addEventListener('change', event => {
      state.showAllCollections = event.target.checked;
      saveStateSoon();
      renderAll();
    });

    panel.querySelector('#mm-show-archived')?.addEventListener('change', event => {
      state.preferences.showArchivedOnMap = event.target.checked;
      saveStateSoon();
      renderAll();
    });

    bindRegisterEvents(panel);
    bindEvidenceEvents(panel);

    panel.querySelector('#mm-marker-icon')?.addEventListener('change', event => {
      state.preferences.markerIcon = event.target.value;
      const chosen = selectedAnnotations().filter(annotation => annotation.type === 'marker');
      if (chosen.length) pushUndo();
      chosen.forEach(annotation => { annotation.markerIcon = state.preferences.markerIcon; annotation.updatedAt = new Date().toISOString(); });
      saveStateSoon();
      renderAll();
    });

    panel.querySelector('#mm-snap')?.addEventListener('change', event => {
      state.preferences.snap = event.target.checked;
      saveStateSoon();
      renderShell();
    });

    panel.querySelector('#mm-stroke')?.addEventListener('input', event => {
      state.preferences.strokeWidth = Number(event.target.value);
      selectedAnnotations().forEach(annotation => {
        annotation.strokeWidth = state.preferences.strokeWidth;
        annotation.updatedAt = new Date().toISOString();
      });
      saveStateSoon();
      renderOverlay();
      const valueLabel = panel.querySelector('#mm-stroke-value');
      if (valueLabel) valueLabel.textContent = `${state.preferences.strokeWidth}px`;
    });

    const selected = findAnnotation(ui.selectedId);
    if (selected && isAnnotationLocked(selected)) {
      panel.querySelectorAll('[data-inspector-id] input, [data-inspector-id] textarea, [data-inspector-id] select, [data-inspector-id] button:not([data-action="zoom-selected"])').forEach(control => { control.disabled = true; });
    }
    if (selected) {
      bindInspectorInput('#mm-title', 'title');
      bindInspectorInput('#mm-owner', 'owner');
      bindInspectorInput('#mm-note', 'note');
      bindInspectorInput('#mm-tags', 'tags');
      bindInspectorInput('#mm-legend-label', 'legendLabel');
      panel.querySelector('#mm-ann-marker-icon')?.addEventListener('change', event => updateSelectedWorkflowField('markerIcon', event.target.value));
      panel.querySelector('#mm-callout-number')?.addEventListener('change', event => updateSelectedWorkflowField('calloutNumber', clamp(Math.round(Number(event.target.value) || 1), 1, 9999)));
      panel.querySelector('#mm-show-measurement')?.addEventListener('change', event => updateSelectedWorkflowField('showMeasurement', event.target.checked));
      panel.querySelector('#mm-ann-status')?.addEventListener('change', event => updateSelectedWorkflowField('status', event.target.value));
      panel.querySelector('#mm-ann-priority')?.addEventListener('change', event => updateSelectedWorkflowField('priority', event.target.value));
      panel.querySelector('#mm-ann-collection')?.addEventListener('change', event => {
        if (isAnnotationLocked(selected) || activeLayerForId(event.target.value)?.locked) { setStatus('Unlock the source and destination layers before moving annotations.', true); renderAll(); return; }
        selected.collectionId = event.target.value;
        selected.updatedAt = new Date().toISOString();
        saveStateSoon();
        renderAll();
      });
    }

    if (ui.newCollectionOpen) {
      setTimeout(() => shadow.querySelector('#mm-new-collection-name')?.focus(), 0);
      panel.querySelector('#mm-new-collection-name')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') addCollection();
        if (event.key === 'Escape') {
          ui.newCollectionOpen = false;
          renderShell();
        }
      });
    }

    if (ui.newProjectOpen) {
      setTimeout(() => shadow.querySelector('#mm-new-project-name')?.focus(), 0);
      panel.querySelector('#mm-new-project-name')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') addProject();
        if (event.key === 'Escape') { ui.newProjectOpen = false; renderShell(); }
      });
    }
  }

  function bindProjectMetadata(panel) {
    const project = currentProject();
    if (!project) return;
    [['#mm-project-name','name'],['#mm-project-description','description'],['#mm-project-reference','reference']].forEach(([selector, property]) => {
      panel.querySelector(selector)?.addEventListener('input', event => {
        if (project.status === 'archived') return;
        project[property] = event.target.value;
        project.updatedAt = new Date().toISOString();
        saveStateSoon();
      });
    });
  }

  function bindEvidenceEvents(panel) {
    const evidence = state.preferences.evidence;
    const textBindings = [
      ['#mm-evidence-title', 'title'],
      ['#mm-evidence-subtitle', 'subtitle'],
    ];
    textBindings.forEach(([selector, property]) => {
      panel.querySelector(selector)?.addEventListener('input', event => {
        evidence[property] = event.target.value;
        saveStateSoon();
      });
    });
    panel.querySelector('#mm-evidence-scope')?.addEventListener('change', event => {
      evidence.scope = event.target.value;
      saveStateSoon();
      renderShell();
    });
    const checkBindings = [
      ['#mm-ev-titleblock', 'includeTitleBlock'],
      ['#mm-ev-legend', 'includeLegend'],
      ['#mm-ev-north', 'includeNorthArrow'],
      ['#mm-ev-scale', 'includeScaleBar'],
      ['#mm-ev-table', 'includeTable'],
    ];
    checkBindings.forEach(([selector, property]) => {
      panel.querySelector(selector)?.addEventListener('change', event => {
        evidence[property] = event.target.checked;
        saveStateSoon();
      });
    });
  }

  function bindRegisterEvents(panel) {
    const register = state.preferences.register;
    panel.querySelector('#mm-register-search')?.addEventListener('input', event => {
      register.query = event.target.value;
      saveStateSoon();
      refreshRegisterView();
    });
    panel.querySelector('#mm-filter-tag')?.addEventListener('input', event => {
      register.tag = event.target.value;
      saveStateSoon();
      refreshRegisterView();
    });
    const bindings = [
      ['#mm-filter-type', 'type'],
      ['#mm-filter-priority', 'priority'],
      ['#mm-filter-color', 'color'],
      ['#mm-filter-collection', 'collection'],
      ['#mm-register-sort', 'sort'],
    ];
    bindings.forEach(([selector, property]) => {
      panel.querySelector(selector)?.addEventListener('change', event => {
        register[property] = event.target.value;
        saveStateSoon();
        refreshRegisterView();
      });
    });
    panel.querySelector('#mm-bulk-status')?.addEventListener('change', event => {
      if (event.target.value) applyBulkField('status', event.target.value);
    });
    panel.querySelector('#mm-bulk-priority')?.addEventListener('change', event => {
      if (event.target.value) applyBulkField('priority', event.target.value);
    });
  }

  function refreshRegisterView() {
    const section = shadow.querySelector('#mm-register-section');
    if (!section) return;
    const annotations = filteredRegisterAnnotations();
    const metrics = registerMetrics();
    const register = state.preferences.register;
    const count = section.querySelector('#mm-register-count');
    if (count) count.textContent = `${annotations.length} of ${metrics.scopeCount}`;
    const list = section.querySelector('#mm-register-list');
    if (list) list.innerHTML = registerListMarkup(annotations);
    section.querySelectorAll('[data-register-status]').forEach(button => {
      const status = button.dataset.registerStatus;
      button.classList.toggle('active', register.status === status);
      const value = status === 'all' ? metrics.status.all : metrics.status[status];
      const strong = button.querySelector('strong');
      if (strong) strong.textContent = value;
    });
    section.querySelectorAll('[data-register-type]').forEach(button => {
      const type = button.dataset.registerType;
      button.classList.toggle('active', register.type === type);
      const value = type === 'all' ? metrics.type.all : metrics.type[type];
      const strong = button.querySelector('strong');
      if (strong) strong.textContent = value;
    });
    const typeSelect = section.querySelector('#mm-filter-type');
    if (typeSelect) typeSelect.value = register.type;
  }

  function updateSelectedWorkflowField(property, value) {
    const selected = findAnnotation(ui.selectedId);
    if (!selected || selected[property] === value) return;
    if (isAnnotationLocked(selected)) { setStatus('Unlock this layer before editing its annotations.', true); return; }
    pushUndo();
    selected[property] = value;
    selected.updatedAt = new Date().toISOString();
    saveStateSoon();
    renderAll();
  }

  function applyBulkField(property, value) {
    const selected = selectedAnnotations().filter(annotation => !isAnnotationLocked(annotation));
    if (!selected.length) { setStatus('No editable annotations are selected.', true); return; }
    pushUndo();
    const now = new Date().toISOString();
    selected.forEach(annotation => {
      annotation[property] = value;
      annotation.updatedAt = now;
    });
    saveStateSoon();
    renderAll();
  }

  function appendBulkTag() {
    const input = shadow.querySelector('#mm-bulk-tag');
    const tag = input?.value.trim();
    const selected = selectedAnnotations().filter(annotation => !isAnnotationLocked(annotation));
    if (!tag || !selected.length) {
      input?.focus();
      return;
    }
    pushUndo();
    const now = new Date().toISOString();
    selected.forEach(annotation => {
      const tags = parseTags(annotation.tags);
      if (!tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
      annotation.tags = tags.join(', ');
      annotation.updatedAt = now;
    });
    saveStateSoon();
    renderAll();
  }

  function bindInspectorInput(selector, property) {
    const input = shadow.querySelector(selector);
    input?.addEventListener('input', event => {
      const selected = findAnnotation(ui.selectedId);
      if (!selected) return;
      if (isAnnotationLocked(selected)) { setStatus('Unlock this layer before editing its annotations.', true); return; }
      selected[property] = event.target.value;
      selected.updatedAt = new Date().toISOString();
      saveStateSoon();
      scheduleOverlayRender();
      if (property === 'title') {
        const activeTitle = shadow.querySelector('.mm-list-item.active .mm-list-title');
        if (activeTitle) activeTitle.textContent = event.target.value || defaultTitle(selected.type);
      }
    });
  }

  function handleAction(action, data = {}) {
    switch (action) {
      case 'set-workspace':
        ui.workspace = ['annotate', 'review', 'evidence', 'project', 'system'].includes(data.workspace) ? data.workspace : 'annotate';
        if (ui.workspace === 'system') ui.diagnosticsOpen = true;
        renderShell();
        break;
      case 'edit-selection':
        ui.workspace = 'annotate';
        renderShell();
        setTimeout(() => shadow.querySelector('#mm-title')?.focus(), 0);
        break;
      case 'collapse':
        ui.expanded = false;
        ui.clearArmed = false;
        renderShell();
        break;
      case 'new-project':
        ui.workspace = 'project';
        ui.newProjectOpen = true;
        renderShell();
        break;
      case 'cancel-project':
        ui.newProjectOpen = false;
        renderShell();
        break;
      case 'add-project':
        addProject();
        break;
      case 'archive-project':
        archiveCurrentProject();
        break;
      case 'restore-project':
        restoreCurrentProject();
        break;
      case 'export-project':
        exportProjectPackage();
        break;
      case 'activate-layer':
        switchLayer(data.layerId);
        break;
      case 'toggle-layer-visible':
        toggleLayerVisibility(data.layerId);
        break;
      case 'toggle-layer-lock':
        toggleLayerLock(data.layerId);
        break;
      case 'archive-layer':
        toggleLayerArchive(data.layerId);
        break;
      case 'new-collection':
        ui.workspace = 'project';
        ui.newCollectionOpen = true;
        renderShell();
        break;
      case 'cancel-collection':
        ui.newCollectionOpen = false;
        renderShell();
        break;
      case 'add-collection':
        addCollection();
        break;
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'toggle-hidden':
        ui.hidden = !ui.hidden;
        renderAll();
        break;
      case 'copy-package':
        copyPackage();
        break;
      case 'export-json':
        exportNativeJson();
        break;
      case 'export-geojson':
        exportGeoJson();
        break;
      case 'export-kml':
        exportKml();
        break;
      case 'capture-png':
        captureEvidencePng();
        break;
      case 'print-report':
        openPrintableEvidenceReport();
        break;
      case 'export-markdown':
        exportEvidenceMarkdown();
        break;
      case 'export-csv':
        exportEvidenceCsv();
        break;
      case 'import':
        importInput.click();
        break;
      case 'clear':
        clearActiveCollection();
        break;
      case 'delete-selected':
        deleteSelected();
        break;
      case 'duplicate-selected':
        duplicateSelected();
        break;
      case 'zoom-selected':
      case 'focus-selected':
        zoomToSelection();
        break;
      case 'delete-vertex':
        deleteActiveVertex();
        break;
      case 'finish-drawing':
        completeMultiPointDrawing();
        break;
      case 'cancel-drawing':
        cancelDrawing();
        renderAll();
        break;
      case 'apply-coordinates':
        applyExactCoordinates();
        break;
      case 'select-register-results':
        setSelection(filteredRegisterAnnotations().map(annotation => annotation.id));
        break;
      case 'clear-selection':
        setSelection([]);
        break;
      case 'append-bulk-tag':
        appendBulkTag();
        break;
      case 'toggle-diagnostics':
        ui.diagnosticsOpen = !ui.diagnosticsOpen;
        ui.restoreSnapshotArmed = null;
        ui.rebuildStorageArmed = false;
        renderShell();
        break;
      case 'verify-storage':
        void verifyStorageIntegrity();
        break;
      case 'create-snapshot':
        ui.storageBusy = true;
        renderShell();
        void createRecoverySnapshot('manual').then(() => {
          ui.storageBusy = false;
          renderShell();
          setStatus('Recovery snapshot created.', false);
        }).catch(error => {
          ui.storageBusy = false;
          storageRuntime.lastError = error.message;
          renderShell();
          setStatus(`Snapshot failed: ${error.message}`, true);
        });
        break;
      case 'export-diagnostics':
        exportDiagnostics();
        break;
      case 'restore-snapshot':
        if (ui.restoreSnapshotArmed === data.snapshotId) {
          ui.storageBusy = true;
          renderShell();
          void restoreRecoverySnapshot(data.snapshotId).finally(() => { ui.storageBusy = false; renderShell(); });
        } else {
          ui.restoreSnapshotArmed = data.snapshotId;
          renderShell();
          setTimeout(() => {
            if (ui.restoreSnapshotArmed === data.snapshotId) { ui.restoreSnapshotArmed = null; renderShell(); }
          }, 5000);
        }
        break;
      case 'rebuild-storage':
        if (ui.rebuildStorageArmed) {
          ui.storageBusy = true;
          renderShell();
          void rebuildIndexedDb().catch(error => {
            storageRuntime.lastError = error.message;
            setStatus(`Storage rebuild failed: ${error.message}`, true);
          }).finally(() => { ui.storageBusy = false; renderShell(); });
        } else {
          ui.rebuildStorageArmed = true;
          renderShell();
          setTimeout(() => {
            if (ui.rebuildStorageArmed) { ui.rebuildStorageArmed = false; renderShell(); }
          }, 5000);
        }
        break;
      case 'expand':
        ui.expanded = true;
        renderShell();
        break;
      default:
        break;
    }
  }

  function currentProject() {
    return state.projects.find(project => project.id === state.activeProjectId) || null;
  }

  function availableProjects() {
    const projects = state.preferences.showArchivedProjects ? state.projects : state.projects.filter(project => project.status !== 'archived');
    return projects.length ? projects : state.projects;
  }

  function projectLayers(includeArchived = false, projectId = state.activeProjectId) {
    return state.collections
      .filter(layer => layer.projectId === projectId && (includeArchived || !layer.archived))
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name));
  }

  function activeLayer() { return activeLayerForId(state.activeCollectionId); }
  function activeLayerForId(id) { return state.collections.find(layer => layer.id === id) || null; }
  function layerForAnnotation(annotation) { return annotation ? activeLayerForId(annotation.collectionId) : null; }
  function annotationsForProject(projectId) {
    const ids = new Set(state.collections.filter(layer => layer.projectId === projectId).map(layer => layer.id));
    return state.annotations.filter(annotation => ids.has(annotation.collectionId));
  }
  function isProjectEditable(project = currentProject()) { return Boolean(project && project.status !== 'archived'); }
  function isLayerEditable(layer = activeLayer()) { return Boolean(layer && !layer.archived && !layer.locked && isProjectEditable(state.projects.find(project => project.id === layer.projectId))); }
  function isAnnotationLocked(annotation) { return !isLayerEditable(layerForAnnotation(annotation)); }

  function switchProject(projectId) {
    const project = state.projects.find(item => item.id === projectId);
    if (!project) return;
    state.activeProjectId = project.id;
    state.preferences.register.collection = 'scope';
    const layers = projectLayers(false, project.id);
    state.activeCollectionId = layers[0]?.id || projectLayers(true, project.id)[0]?.id || state.activeCollectionId;
    setSelection([], null, false);
    saveStateSoon();
    renderAll();
  }

  function switchLayer(layerId) {
    const layer = activeLayerForId(layerId);
    if (!layer || layer.projectId !== state.activeProjectId) return;
    state.activeCollectionId = layer.id;
    setSelection([], null, false);
    saveStateSoon();
    renderAll();
  }

  function addProject() {
    const input = shadow.querySelector('#mm-new-project-name');
    const name = input?.value.trim();
    const templateKey = shadow.querySelector('#mm-project-template')?.value || 'blank';
    if (!name) { input?.focus(); return; }
    const template = PROJECT_TEMPLATES[templateKey] || PROJECT_TEMPLATES.blank;
    pushUndo();
    const now = new Date().toISOString();
    const project = normalizeProject({ id: makeId('project'), name, description: template.description, status: 'active', createdAt: now, updatedAt: now });
    state.projects.push(project);
    const layers = template.layers.map((layerName, index) => normalizeLayer({ id: makeId('layer'), name: layerName, order: index }, project.id, index));
    state.collections.push(...layers);
    state.activeProjectId = project.id;
    state.activeCollectionId = layers[0].id;
    ui.newProjectOpen = false;
    setSelection([], null, false);
    saveStateSoon();
    renderAll();
  }

  function archiveCurrentProject() {
    const project = currentProject();
    if (!project || project.status === 'archived') return;
    if (!ui.projectArchiveArmed) {
      ui.projectArchiveArmed = true;
      renderShell();
      setTimeout(() => { if (ui.projectArchiveArmed) { ui.projectArchiveArmed = false; renderShell(); } }, 5000);
      return;
    }
    pushUndo();
    project.status = 'archived';
    project.updatedAt = new Date().toISOString();
    ui.projectArchiveArmed = false;
    const next = state.projects.find(item => item.status !== 'archived' && item.id !== project.id);
    if (next) switchProject(next.id);
    else { state.preferences.showArchivedProjects = true; saveStateSoon(); renderAll(); }
  }

  function restoreCurrentProject() {
    const project = currentProject();
    if (!project || project.status !== 'archived') return;
    pushUndo();
    project.status = 'active';
    project.updatedAt = new Date().toISOString();
    saveStateSoon();
    renderAll();
  }

  function toggleLayerVisibility(layerId) {
    const layer = activeLayerForId(layerId); if (!layer) return;
    layer.visible = !layer.visible; layer.updatedAt = new Date().toISOString();
    saveStateSoon(); renderAll();
  }

  function toggleLayerLock(layerId) {
    const layer = activeLayerForId(layerId); if (!layer || layer.archived) return;
    pushUndo(); layer.locked = !layer.locked; layer.updatedAt = new Date().toISOString();
    saveStateSoon(); renderAll();
  }

  function toggleLayerArchive(layerId) {
    const layer = activeLayerForId(layerId); if (!layer) return;
    const liveLayers = projectLayers(false, layer.projectId);
    if (!layer.archived && liveLayers.length <= 1) { setStatus('A project must keep at least one active layer.', true); return; }
    pushUndo(); layer.archived = !layer.archived; layer.visible = !layer.archived; layer.locked = layer.archived ? true : false; layer.updatedAt = new Date().toISOString();
    if (layer.id === state.activeCollectionId && layer.archived) state.activeCollectionId = projectLayers(false, layer.projectId).find(item => item.id !== layer.id)?.id || state.activeCollectionId;
    setSelection([], null, false); saveStateSoon(); renderAll();
  }

  function addCollection() {
    const input = shadow.querySelector('#mm-new-collection-name');
    const name = input?.value.trim();
    if (!name) {
      input?.focus();
      return;
    }
    pushUndo();
    const collection = {
      id: makeId('layer'),
      projectId: state.activeProjectId,
      name,
      visible: true,
      locked: false,
      archived: false,
      order: projectLayers(true).length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.collections.push(collection);
    state.activeCollectionId = collection.id;
    setSelection([], null, false);
    ui.newCollectionOpen = false;
    saveStateSoon();
    renderAll();
  }

  function clearActiveCollection() {
    if (!isLayerEditable()) { setStatus('Unlock and restore the active layer before clearing it.', true); return; }
    if (!ui.clearArmed) {
      ui.clearArmed = true;
      renderShell();
      setTimeout(() => {
        if (ui.clearArmed) {
          ui.clearArmed = false;
          renderShell();
        }
      }, 5000);
      return;
    }
    snapshotBeforeDestructiveChange('before-clear-layer');
    pushUndo();
    state.annotations = state.annotations.filter(annotation => annotation.collectionId !== state.activeCollectionId);
    setSelection([], null, false);
    ui.clearArmed = false;
    saveStateSoon();
    renderAll();
  }

  function deleteSelected() {
    const ids = new Set(selectedAnnotations().filter(annotation => !isAnnotationLocked(annotation)).map(annotation => annotation.id));
    if (!ids.size) { setStatus('No editable annotations are selected.', true); return; }
    if (ids.size >= 5) snapshotBeforeDestructiveChange('before-bulk-delete');
    pushUndo();
    state.annotations = state.annotations.filter(annotation => !ids.has(annotation.id));
    setSelection([], null, false);
    saveStateSoon();
    renderAll();
  }

  function deleteActiveVertex() {
    const vertex = ui.activeVertex;
    const annotation = vertex ? findAnnotation(vertex.annotationId) : null;
    if (!annotation || !Number.isInteger(vertex.index)) return false;
    if (isAnnotationLocked(annotation)) { setStatus('Unlock this layer before reshaping its annotations.', true); return false; }
    if (annotation.type === 'pen' || annotation.type === 'route') {
      const coordinates = annotation.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length <= 2) return false;
      pushUndo();
      coordinates.splice(vertex.index, 1);
    } else if (annotation.type === 'polygon') {
      const ring = annotation.geometry?.coordinates?.[0];
      const unique = Array.isArray(ring) ? ring.slice(0, -1) : [];
      if (unique.length <= 3 || vertex.index >= unique.length) return false;
      pushUndo();
      unique.splice(vertex.index, 1);
      annotation.geometry.coordinates[0] = [...unique, structuredCloneSafe(unique[0])];
    } else return false;
    annotation.updatedAt = new Date().toISOString();
    ui.activeVertex = null;
    saveStateSoon();
    renderAll();
    return true;
  }

  function applyExactCoordinates() {
    const annotation = findAnnotation(ui.selectedId);
    const lat = Number(shadow.querySelector('#mm-coordinate-lat')?.value);
    const lng = Number(shadow.querySelector('#mm-coordinate-lng')?.value);
    if (!annotation || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85.05112878 || Math.abs(lng) > 180) {
      setStatus('Enter a valid latitude and longitude.', true);
      return;
    }
    if (isAnnotationLocked(annotation)) { setStatus('Unlock this layer before moving annotations.', true); return; }
    const center = annotationCenter(annotation);
    if (!center) return;
    pushUndo();
    annotation.geometry = translateGeometryGeodesic(annotation.geometry, [normalizeLng(lng - center[0]), lat - center[1]]);
    annotation.updatedAt = new Date().toISOString();
    saveStateSoon();
    renderAll();
    setStatus(`Moved ${annotation.title || defaultTitle(annotation.type)} to ${lat.toFixed(6)}, ${lng.toFixed(6)}.`, false);
  }

  function duplicateSelected() {
    const selected = selectedAnnotations().filter(annotation => !isAnnotationLocked(annotation));
    if (!selected.length || !ui.mapView || !ui.mapRect) return;
    pushUndo();
    const copies = selected.map(annotation => {
      const copy = structuredCloneSafe(annotation);
      copy.id = makeId(annotation.type);
      copy.title = `${annotation.title || defaultTitle(annotation.type)} copy`;
      copy.geometry = translateGeometryByPixels(annotation.geometry, 18, 18);
      const now = new Date().toISOString();
      copy.createdAt = now;
      copy.updatedAt = now;
      return copy;
    });
    state.annotations.push(...copies);
    setSelection(copies.map(copy => copy.id), copies.at(-1)?.id || null, false);
    saveStateSoon();
    renderAll();
  }

  function setTool(tool) {
    if (ui.expanded) ui.workspace = 'annotate';
    if (!TOOL_LABELS[tool]) return;
    if (tool !== 'select' && !ui.mapEnvironment?.supported) { ui.tool = 'select'; setStatus(ui.mapEnvironment?.reason || 'Return to a standard north-up 2D map before adding markup.', true); renderShell(); updateOverlayInteraction(); return; }
    if (tool !== 'select' && !isLayerEditable()) { ui.tool = 'select'; setStatus('Choose an unlocked, active layer before adding markup.', true); renderShell(); updateOverlayInteraction(); return; }
    ui.tool = tool;
    ui.drawing = null;
    ui.draftPoint = null;
    updateOverlayInteraction();
    renderShell();
    renderOverlay();
  }

  function annotationsInMapScope() {
    const visibleLayers = projectLayers(false).filter(layer => layer.visible);
    const layerIds = new Set(state.showAllCollections ? visibleLayers.map(layer => layer.id) : (activeLayer()?.visible && !activeLayer()?.archived ? [state.activeCollectionId] : []));
    return state.annotations.filter(annotation => layerIds.has(annotation.collectionId));
  }

  function annotationsForCurrentCollection() {
    const result = annotationsInMapScope().filter(annotation => state.preferences.showArchivedOnMap || annotation.status !== 'archived');
    return [...result].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function registerCollectionSource() {
    const collection = state.preferences.register.collection;
    if (collection === 'all') return state.annotations;
    if (collection?.startsWith('set:')) {
      const id = collection.slice(4);
      return state.annotations.filter(annotation => annotation.collectionId === id);
    }
    return annotationsInMapScope();
  }

  function filteredRegisterAnnotations(options = {}) {
    const register = state.preferences.register;
    const query = register.query.trim().toLowerCase();
    const tagQuery = register.tag.trim().toLowerCase();
    let result = registerCollectionSource().filter(annotation => {
      if (!options.omitType && register.type !== 'all' && annotation.type !== register.type) return false;
      if (!options.omitStatus && register.status !== 'all' && annotation.status !== register.status) return false;
      if (register.priority !== 'all' && annotation.priority !== register.priority) return false;
      if (register.color !== 'all' && annotation.color !== register.color) return false;
      if (tagQuery && !parseTags(annotation.tags).some(tag => tag.toLowerCase().includes(tagQuery))) return false;
      if (query) {
        const haystack = [annotation.title, annotation.note, annotation.tags, annotation.owner, annotation.legendLabel, measurementLabel(annotation), annotation.status, annotation.priority, TOOL_LABELS[annotation.type]].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    result = [...result].sort(registerComparator(register.sort));
    return result;
  }

  function registerMetrics() {
    const statusBase = filteredRegisterAnnotations({ omitStatus: true });
    const typeBase = filteredRegisterAnnotations({ omitType: true });
    const status = { all: statusBase.length };
    Object.keys(STATUS_LABELS).forEach(value => { status[value] = statusBase.filter(annotation => annotation.status === value).length; });
    const type = { all: typeBase.length };
    ANNOTATION_TYPES.forEach(value => { type[value] = typeBase.filter(annotation => annotation.type === value).length; });
    return { scopeCount: registerCollectionSource().length, status, type };
  }

  function registerComparator(sort) {
    switch (sort) {
      case 'updated-asc': return (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt));
      case 'created-desc': return (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));
      case 'created-asc': return (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
      case 'title-asc': return (a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' });
      case 'title-desc': return (a, b) => String(b.title).localeCompare(String(a.title), undefined, { sensitivity: 'base' });
      case 'distance-asc': return (a, b) => distanceFromMapCenter(a) - distanceFromMapCenter(b);
      case 'updated-desc':
      default: return (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
    }
  }

  function distanceFromMapCenter(annotation) {
    const center = annotationCenter(annotation);
    if (!center || !ui.mapView) return Number.POSITIVE_INFINITY;
    return haversineKm([ui.mapView.lng, ui.mapView.lat], center);
  }

  function findAnnotation(id) {
    return id ? state.annotations.find(annotation => annotation.id === id) || null : null;
  }

  function mapStatus() {
    if (ui.mapEnvironment && !ui.mapEnvironment.supported && ui.mapEnvironment.mode !== 'unknown') return { warn: true, message: ui.mapEnvironment.reason };
    if (!ui.mapRect) return { warn: true, message: 'Google Maps canvas not found yet. Move or zoom the map, then open Diagnostics to inspect canvas detection.' };
    if (!ui.mapView) return { warn: true, message: 'This view does not expose a standard latitude, longitude, and zoom. Return to a north-up 2D map view.' };
    if (ui.tool !== 'select' && !isLayerEditable()) return { warn: true, message: 'The active project or layer is archived or locked. Select an editable layer before adding markup.' };
    return {
      warn: false,
      message: `${TOOL_LABELS[ui.tool]} active. ${ui.tool === 'select' ? 'Click to select, Shift-click to add, then drag to move or use the edit handles.' : toolInstruction(ui.tool)}`,
    };
  }

  function toolInstruction(tool) {
    switch (tool) {
      case 'note': return 'Click once to place a map note.';
      case 'label': return 'Click once to place a text label.';
      case 'arrow': return 'Drag from the arrow tail to its point.';
      case 'box': return 'Drag diagonally to mark an area.';
      case 'pen': return 'Press and drag to draw a freehand line.';
      case 'callout': return 'Click once to place the next numbered callout.';
      case 'marker': return 'Click once to place a custom marker.';
      case 'route': return 'Click route vertices, then press Enter or Finish Route.';
      case 'polygon': return 'Click polygon vertices, then press Enter or Finish Polygon.';
      case 'circle': return 'Drag from the center to define the radius.';
      default: return '';
    }
  }

  function setStatus(message, warn = false) {
    const status = shadow.querySelector('#mm-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('warn', warn);
  }

  function updateMapContext() {
    ui.mapEnvironment = detectMapEnvironment(location.href);
    ui.mapRect = detectMapRect();
    ui.mapView = parseMapView(location.href);
    const safe = Boolean(ui.mapRect && ui.mapView && ui.mapEnvironment.supported);
    if (!safe) {
      overlay.style.display = 'none';
      if (ui.tool !== 'select' && !ui.mapEnvironment.supported) {
        ui.tool = 'select';
        ui.drawing = null;
        ui.interaction = null;
      }
      return;
    }
    overlay.style.display = ui.hidden ? 'none' : 'block';
    overlay.style.left = `${ui.mapRect.left}px`;
    overlay.style.top = `${ui.mapRect.top}px`;
    overlay.style.width = `${ui.mapRect.width}px`;
    overlay.style.height = `${ui.mapRect.height}px`;
    overlay.setAttribute('viewBox', `0 0 ${ui.mapRect.width} ${ui.mapRect.height}`);
    updateOverlayInteraction();
  }

  function detectMapEnvironment(url) {
    let decoded = String(url || '');
    try { decoded = decodeURIComponent(decoded); } catch (_) { /* keep original */ }
    const cameraSegment = decoded.match(/@[^/?#]+/)?.[0] || '';
    const signals = [];
    const streetDom = Boolean(document.querySelector('[aria-label*="Exit Street View" i], [aria-label*="Street View" i][role="dialog"]'));
    const streetUrl = /,3a(?:,|$)/i.test(cameraSegment) || /\/streetview(?:\/|$)/i.test(decoded);
    if (streetDom) signals.push('street-view-dom');
    if (streetUrl) signals.push('street-view-url');
    if (streetDom || streetUrl) return { mode: 'street-view', supported: false, reason: 'Street View uses a perspective camera, so geographic annotations are hidden to prevent misalignment. Exit Street View to continue.', signals };
    const altitude = /,(?!3a(?:,|$))\d+(?:\.\d+)?a(?:,|$)/i.test(cameraSegment);
    const heading = /,\d+(?:\.\d+)?h(?:,|$)/i.test(cameraSegment);
    const tilt = /,\d+(?:\.\d+)?t(?:,|$)/i.test(cameraSegment);
    if (altitude) signals.push('camera-altitude');
    if (heading) signals.push('camera-heading');
    if (tilt) signals.push('camera-tilt');
    if (altitude || heading || tilt) {
      const mode = altitude ? '3d-or-tilted' : 'rotated-or-tilted';
      return { mode, supported: false, reason: 'This map uses a rotated, tilted, or 3D camera. Return to a north-up 2D view before displaying or editing annotations.', signals };
    }
    const view = parseMapView(decoded);
    if (!view) return { mode: 'unknown', supported: false, reason: 'MAPMARK cannot verify a standard 2D geographic view from this Google Maps URL.', signals: ['no-lat-lng-zoom'] };
    return { mode: '2d-north-up', supported: true, reason: 'Standard north-up 2D map detected.', signals: ['lat-lng-zoom'] };
  }

  function detectMapRect() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const viewportArea = Math.max(1, viewportWidth * viewportHeight);
    const nodes = [
      ...document.querySelectorAll('canvas'),
      ...document.querySelectorAll('[role="application"]'),
      ...document.querySelectorAll('[aria-label*="Map" i][tabindex]'),
    ];
    const seen = new Set();
    const candidates = [];
    nodes.forEach((element, index) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left));
      const visibleHeight = Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top));
      if (visibleWidth < 260 || visibleHeight < 220) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const areaRatio = (visibleWidth * visibleHeight) / viewportArea;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const containsCenter = centerX > viewportWidth * 0.25 && centerX < viewportWidth * 0.85 && centerY > viewportHeight * 0.2 && centerY < viewportHeight * 0.85;
      const canvasBonus = element.tagName === 'CANVAS' ? 25 : 0;
      const webglBonus = element.tagName === 'CANVAS' && (Number(element.width) > 0 || Number(element.height) > 0) ? 8 : 0;
      const score = areaRatio * 100 + canvasBonus + webglBonus + (containsCenter ? 12 : 0) - Math.max(0, rect.top) * 0.005;
      candidates.push({ element, rect, score, source: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}[${index}]` });
    });
    candidates.sort((a, b) => b.score - a.score);
    ui.mapDetection = {
      candidates: candidates.length,
      source: candidates[0]?.source || 'none',
      score: candidates[0]?.score || 0,
      topCandidates: candidates.slice(0, 4).map(item => ({ source: item.source, score: round1(item.score), width: round1(item.rect.width), height: round1(item.rect.height) })),
    };
    if (!candidates.length) return null;
    const source = candidates[0].rect;
    let left = Math.max(0, source.left);
    let top = Math.max(0, source.top);
    let right = Math.min(viewportWidth, source.right);
    let bottom = Math.min(viewportHeight, source.bottom);

    const leftPanels = [...document.querySelectorAll('[role="main"]')]
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.width >= 260 && rect.width < viewportWidth * 0.62 && rect.height > viewportHeight * 0.45 && rect.left <= 8 && rect.right < viewportWidth - 200);
    if (leftPanels.length) left = Math.max(left, ...leftPanels.map(rect => rect.right));

    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (width < 260 || height < 220) return null;
    return { left, top, right, bottom, width, height };
  }

  function parseMapView(url) {
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch (_) { /* keep original */ }
    const match = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z(?=[,/?#]|$)/);
    if (!match) return null;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    const zoom = Number(match[3]);
    if (![lat, lng, zoom].every(Number.isFinite)) return null;
    return { lat, lng, zoom };
  }

  function updateOverlayInteraction() {
    overlay.classList.toggle('mm-drawing', ui.tool !== 'select' && !ui.captureMode);
    overlay.classList.toggle('mm-capture', ui.captureMode);
  }

  function renderOverlay() {
    if (!ui.mapRect || !ui.mapView || !ui.mapEnvironment?.supported || ui.hidden) {
      overlay.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    const overlayAnnotations = ui.captureMode && ui.captureIds instanceof Set
      ? state.annotations.filter(annotation => ui.captureIds.has(annotation.id))
      : annotationsForCurrentCollection();
    for (const annotation of overlayAnnotations) {
      const node = renderAnnotation(annotation);
      if (node) fragment.appendChild(node);
    }
    if (!ui.captureMode && ui.snapGuide) fragment.appendChild(renderSnapGuide(ui.snapGuide));
    if (!ui.captureMode && ui.drawing) {
      const preview = renderPreview(ui.drawing);
      if (preview) fragment.appendChild(preview);
    }
    overlay.replaceChildren(fragment);
  }

  function renderAnnotation(annotation) {
    const selected = !ui.captureMode && isSelected(annotation.id);
    const primary = !ui.captureMode && ui.selectedId === annotation.id;
    const group = svgEl('g', {
      class: `mm-ann mm-status-${annotation.status} ${selected ? 'mm-selected' : ''} ${primary ? 'mm-primary' : ''}`,
      opacity: annotation.status === 'resolved' ? 0.78 : 1,
      'data-ann-id': annotation.id,
      'aria-label': annotation.title,
    });

    if (POINT_TYPES.includes(annotation.type)) {
      const coordinates = annotation.geometry?.coordinates;
      if (!isCoordinate(coordinates)) return null;
      const point = geoToLocal(coordinates);
      if (!point || !nearViewport(point, 160)) return null;
      if (annotation.type === 'note') renderNote(group, annotation, point);
      else if (annotation.type === 'label') renderLabel(group, annotation, point);
      else if (annotation.type === 'callout') renderCallout(group, annotation, point);
      else renderMarker(group, annotation, point);
      return group;
    }

    if (LINE_TYPES.includes(annotation.type)) {
      const coordinates = annotation.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
      const points = coordinates.map(geoToLocal).filter(Boolean);
      if (points.length < 2 || !points.some(point => nearViewport(point, 100))) return null;
      renderLine(group, annotation, points, annotation.type === 'arrow');
      if (annotation.type === 'route' && annotation.showMeasurement !== false) renderMeasurementLabel(group, annotation, points);
      if (primary && selectionSet().size === 1 && ui.tool === 'select') renderEditHandles(group, annotation, points);
      return group;
    }

    if (POLYGON_TYPES.includes(annotation.type)) {
      const ring = annotation.geometry?.coordinates?.[0];
      if (!Array.isArray(ring) || ring.length < 4) return null;
      const points = ring.map(geoToLocal).filter(Boolean);
      if (points.length < 4 || !points.some(point => nearViewport(point, 120))) return null;
      renderPolygonShape(group, annotation, points);
      if (['polygon','circle'].includes(annotation.type) && annotation.showMeasurement !== false) renderMeasurementLabel(group, annotation, points);
      if (primary && selectionSet().size === 1 && ui.tool === 'select') renderEditHandles(group, annotation, points);
      return group;
    }
    return null;
  }

  function renderNote(group, annotation, [x, y]) {
    group.appendChild(svgEl('circle', {
      cx: x, cy: y, r: 12,
      fill: annotation.color,
      stroke: '#ffffff',
      'stroke-width': 2,
    }));
    const letter = svgEl('text', { x, y, class: 'mm-note-letter' });
    letter.textContent = 'N';
    group.appendChild(letter);
    const title = svgEl('text', {
      x: x + 17,
      y: y + 4,
      fill: annotation.color,
      class: 'mm-text',
    });
    title.textContent = truncate(annotation.title, 45);
    group.appendChild(title);
    group.appendChild(svgEl('circle', {
      cx: x, cy: y, r: 18,
      class: 'mm-hit',
      'data-ann-id': annotation.id,
    }));
  }

  function renderCallout(group, annotation, [x, y]) {
    group.appendChild(svgEl('circle', { cx: x, cy: y, r: 14, fill: annotation.color, stroke: '#ffffff', 'stroke-width': 2.5 }));
    const number = svgEl('text', { x, y, class: 'mm-callout-number' });
    number.textContent = String(annotation.calloutNumber || 1);
    group.appendChild(number);
    const title = svgEl('text', { x: x + 19, y: y + 4, fill: annotation.color, class: 'mm-text' });
    title.textContent = truncate(annotation.title, 45);
    group.appendChild(title);
    group.appendChild(svgEl('circle', { cx: x, cy: y, r: 20, class: 'mm-hit', 'data-ann-id': annotation.id }));
  }

  function renderMarker(group, annotation, [x, y]) {
    const icon = MARKER_ICONS[annotation.markerIcon] || MARKER_ICONS.pin;
    const path = `M ${x} ${y + 17} C ${x - 4} ${y + 10}, ${x - 12} ${y + 3}, ${x - 12} ${y - 6} A 12 12 0 1 1 ${x + 12} ${y - 6} C ${x + 12} ${y + 3}, ${x + 4} ${y + 10}, ${x} ${y + 17} Z`;
    group.appendChild(svgEl('path', { d: path, fill: annotation.color, stroke: '#ffffff', 'stroke-width': 2 }));
    const glyph = svgEl('text', { x, y: y - 5, class: 'mm-marker-glyph' });
    glyph.textContent = icon.glyph;
    group.appendChild(glyph);
    const title = svgEl('text', { x: x + 17, y: y - 1, fill: annotation.color, class: 'mm-text' });
    title.textContent = truncate(annotation.title, 45);
    group.appendChild(title);
    group.appendChild(svgEl('circle', { cx: x, cy: y, r: 21, class: 'mm-hit', 'data-ann-id': annotation.id }));
  }

  function renderLabel(group, annotation, [x, y]) {
    const text = truncate(annotation.title || 'Label', 50);
    const width = clamp(18 + text.length * 7.1, 54, 310);
    const rect = svgEl('rect', {
      x: x - 4,
      y: y - 17,
      width,
      height: 24,
      rx: 5,
      fill: 'rgba(255,255,255,.92)',
      stroke: annotation.color,
      'stroke-width': 2,
    });
    group.appendChild(rect);
    const title = svgEl('text', {
      x: x + 5,
      y: y,
      fill: annotation.color,
      'font-size': 13,
      'font-weight': 800,
    });
    title.textContent = text;
    group.appendChild(title);
    group.appendChild(svgEl('rect', {
      x: x - 8,
      y: y - 22,
      width: width + 8,
      height: 34,
      rx: 7,
      class: 'mm-hit',
      'data-ann-id': annotation.id,
    }));
  }

  function renderLine(group, annotation, points, arrow) {
    const pointString = points.map(([x, y]) => `${round1(x)},${round1(y)}`).join(' ');
    group.appendChild(svgEl('polyline', {
      points: pointString,
      fill: 'none',
      stroke: annotation.color,
      'stroke-width': annotation.strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));
    group.appendChild(svgEl('polyline', {
      points: pointString,
      fill: 'none',
      stroke: 'transparent',
      'stroke-width': Math.max(14, annotation.strokeWidth + 10),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'data-ann-id': annotation.id,
    }));
    if (arrow) {
      const end = points[points.length - 1];
      const before = points[points.length - 2];
      const head = arrowHead(before, end, 12 + annotation.strokeWidth * 1.4);
      group.appendChild(svgEl('polygon', {
        points: head.map(([x, y]) => `${round1(x)},${round1(y)}`).join(' '),
        fill: annotation.color,
        'data-ann-id': annotation.id,
      }));
    }
  }

  function renderPolygonShape(group, annotation, points) {
    const pointString = points.map(([x, y]) => `${round1(x)},${round1(y)}`).join(' ');
    group.appendChild(svgEl('polygon', {
      points: pointString,
      fill: hexToRgba(annotation.color, 0.10),
      stroke: annotation.color,
      'stroke-width': annotation.strokeWidth,
      'stroke-linejoin': 'round',
    }));
    group.appendChild(svgEl('polygon', {
      points: pointString,
      fill: 'transparent',
      stroke: 'transparent',
      'stroke-width': Math.max(14, annotation.strokeWidth + 10),
      'data-ann-id': annotation.id,
    }));
  }

  function renderMeasurementLabel(group, annotation, points) {
    const label = measurementLabel(annotation);
    if (!label) return;
    const center = annotation.type === 'route' ? polylineMidpoint(points) : polygonVisualCenter(points);
    if (!center) return;
    const text = svgEl('text', { x: center[0] + 6, y: center[1] - 7, fill: annotation.color, class: 'mm-measure-label' });
    text.textContent = label;
    group.appendChild(text);
  }

  function renderEditHandles(group, annotation, points) {
    if (annotation.type === 'arrow') {
      [0, points.length - 1].forEach(index => appendHandle(group, annotation, points[index], index, 'endpoint'));
      return;
    }
    if (annotation.type === 'box') {
      points.slice(0, 4).forEach((point, index) => appendHandle(group, annotation, point, index, 'corner', true));
      return;
    }
    if (annotation.type === 'pen' || annotation.type === 'route') {
      const step = Math.max(1, Math.ceil(points.length / 120));
      points.forEach((point, index) => {
        if (index % step === 0 || index === points.length - 1) appendHandle(group, annotation, point, index, 'vertex');
      });
      return;
    }
    if (annotation.type === 'polygon') {
      points.slice(0, -1).forEach((point, index) => appendHandle(group, annotation, point, index, 'vertex', true));
      return;
    }
    if (annotation.type === 'circle') {
      const center = geoToLocal(annotationCenter(annotation));
      if (center) appendHandle(group, annotation, points[0], 0, 'radius', true);
    }
  }

  function appendHandle(group, annotation, [x, y], index, kind, square = false) {
    group.appendChild(svgEl('circle', {
      cx: x, cy: y, r: 9,
      class: 'mm-handle-hit',
      'data-ann-id': annotation.id,
      'data-handle': kind,
      'data-index': index,
    }));
    const active = ui.activeVertex?.annotationId === annotation.id && ui.activeVertex?.index === index;
    if (square) {
      group.appendChild(svgEl('rect', {
        x: x - 4, y: y - 4, width: 8, height: 8, rx: 1,
        class: `mm-handle ${active ? 'active' : ''}`,
      }));
    } else {
      group.appendChild(svgEl('circle', {
        cx: x, cy: y, r: 4.5,
        class: `mm-handle ${active ? 'active' : ''}`,
      }));
    }
  }

  function renderSnapGuide(guide) {
    const [x, y] = guide.point;
    const group = svgEl('g', { 'aria-hidden': 'true' });
    if (guide.from) group.appendChild(svgEl('line', {
      x1: guide.from[0], y1: guide.from[1], x2: x, y2: y, class: 'mm-snap-line',
    }));
    group.appendChild(svgEl('circle', { cx: x, cy: y, r: 7, class: 'mm-snap-ring' }));
    group.appendChild(svgEl('line', { x1: x - 11, y1: y, x2: x + 11, y2: y, class: 'mm-snap-line' }));
    group.appendChild(svgEl('line', { x1: x, y1: y - 11, x2: x, y2: y + 11, class: 'mm-snap-line' }));
    return group;
  }

  function renderPreview(drawing) {
    if (!drawing.points?.length) return null;
    const group = svgEl('g', { opacity: .82, 'pointer-events': 'none' });
    const annotation = { color: state.preferences.color, strokeWidth: state.preferences.strokeWidth, id: 'preview' };
    if (drawing.type === 'arrow' || drawing.type === 'pen' || drawing.type === 'route') {
      renderLine(group, annotation, drawing.points, drawing.type === 'arrow');
    } else if (drawing.type === 'box' && drawing.points.length >= 2) {
      const [a, b] = drawing.points;
      const points = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
      renderPolygonShape(group, annotation, points);
    } else if (drawing.type === 'polygon' && drawing.points.length >= 2) {
      renderPolygonShape(group, annotation, [...drawing.points, drawing.points[0]]);
    } else if (drawing.type === 'circle' && drawing.points.length >= 2) {
      const center = drawing.points[0];
      const radius = distance(center, drawing.points[1]);
      group.appendChild(svgEl('circle', { cx: center[0], cy: center[1], r: radius, fill: hexToRgba(annotation.color, .10), stroke: annotation.color, 'stroke-width': annotation.strokeWidth }));
    }
    return group;
  }

  function scheduleOverlayRender() {
    if (ui.renderQueued) return;
    ui.renderQueued = true;
    requestAnimationFrame(() => {
      ui.renderQueued = false;
      renderOverlay();
    });
  }

  function svgEl(tag, attrs = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      element.setAttribute(key, String(value));
    }
    return element;
  }

  function localPointFromEvent(event) {
    if (!ui.mapRect) return null;
    return [
      clamp(event.clientX - ui.mapRect.left, 0, ui.mapRect.width),
      clamp(event.clientY - ui.mapRect.top, 0, ui.mapRect.height),
    ];
  }

  overlay.addEventListener('click', event => {
    if (ui.tool !== 'select' || Date.now() < ui.suppressClickUntil) return;
    const target = event.target.closest('[data-ann-id]');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const id = target.dataset.annId;
    if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelection(id);
    else setSelection([id], id, false);
    ui.expanded = true;
    renderAll();
  });

  overlay.addEventListener('dblclick', event => {
    if (ui.tool === 'route' || ui.tool === 'polygon') {
      event.preventDefault();
      event.stopPropagation();
      completeMultiPointDrawing();
      return;
    }
    const handle = event.target.closest('[data-handle="vertex"]');
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    ui.activeVertex = { annotationId: handle.dataset.annId, index: Number(handle.dataset.index) };
    deleteActiveVertex();
  });

  overlay.addEventListener('pointerdown', event => {
    if (!ui.mapRect || !ui.mapView) return;
    const local = localPointFromEvent(event);
    if (!local) return;

    if (ui.tool === 'select') {
      const target = event.target.closest('[data-ann-id]');
      if (!target) return;
      const id = target.dataset.annId;
      event.preventDefault();
      event.stopPropagation();

      if ((event.shiftKey || event.ctrlKey || event.metaKey) && !event.target.closest('[data-handle]')) {
        toggleSelection(id);
        ui.expanded = true;
        renderAll();
        ui.suppressClickUntil = Date.now() + 300;
        return;
      }

      if (isAnnotationLocked(findAnnotation(id))) {
        setSelection([id], id, false);
        ui.expanded = true;
        setStatus('This layer is locked or archived. Unlock or restore it before editing.', true);
        renderAll();
        return;
      }
      try { overlay.setPointerCapture?.(event.pointerId); } catch (_) { /* inactive pointer */ }
      if (!isSelected(id)) setSelection([id], id, false);
      else ui.selectedId = id;

      const handle = event.target.closest('[data-handle]');
      if (handle) {
        const index = Number(handle.dataset.index);
        ui.activeVertex = { annotationId: id, index };
        ui.interaction = {
          kind: 'handle',
          handleKind: handle.dataset.handle,
          annotationId: id,
          index,
          pointerId: event.pointerId,
          start: local,
          last: local,
          moved: false,
          undoPushed: false,
          originals: new Map([[id, structuredCloneSafe(findAnnotation(id).geometry)]]),
        };
      } else {
        const selected = selectedAnnotations();
        ui.activeVertex = null;
        ui.interaction = {
          kind: 'move',
          annotationId: id,
          pointerId: event.pointerId,
          start: local,
          last: local,
          moved: false,
          undoPushed: false,
          originals: new Map(selected.map(annotation => [annotation.id, structuredCloneSafe(annotation.geometry)])),
        };
      }
      scheduleOverlayRender();
      return;
    }

    if (!isLayerEditable()) { setStatus('Choose an unlocked, active layer before adding markup.', true); setTool('select'); return; }
    event.preventDefault();
    event.stopPropagation();
    try { overlay.setPointerCapture?.(event.pointerId); } catch (_) { /* synthetic or inactive pointer */ }

    if (POINT_TYPES.includes(ui.tool)) {
      addPointAnnotation(ui.tool, local);
      return;
    }

    if (ui.tool === 'route' || ui.tool === 'polygon') {
      const point = snappedDrawingPoint(local, event.altKey);
      if (!ui.drawing || ui.drawing.type !== ui.tool) ui.drawing = { type: ui.tool, pointerId: null, points: [] };
      const previous = ui.drawing.points.at(-1);
      if (!previous || distance(previous, point) >= 3) ui.drawing.points.push(point);
      ui.expanded = true;
      renderAll();
      return;
    }

    ui.drawing = {
      type: ui.tool,
      pointerId: event.pointerId,
      points: [local],
    };
    scheduleOverlayRender();
  });

  overlay.addEventListener('pointermove', event => {
    if (ui.interaction && ui.interaction.pointerId === event.pointerId) {
      const local = localPointFromEvent(event);
      if (!local) return;
      event.preventDefault();
      event.stopPropagation();
      const interaction = ui.interaction;
      interaction.last = local;
      if (!interaction.moved && distance(interaction.start, local) < 2.5) return;
      if (!interaction.undoPushed) {
        pushUndo();
        interaction.undoPushed = true;
      }
      interaction.moved = true;
      if (interaction.kind === 'move') applyMoveInteraction(interaction, local, event.altKey);
      else applyHandleInteraction(interaction, local, event.altKey);
      scheduleOverlayRender();
      return;
    }

    if (!ui.drawing || ui.drawing.pointerId !== event.pointerId) return;
    const local = localPointFromEvent(event);
    if (!local) return;
    event.preventDefault();
    if (ui.drawing.type === 'pen') {
      const previous = ui.drawing.points[ui.drawing.points.length - 1];
      if (distance(previous, local) >= 4) ui.drawing.points.push(local);
    } else {
      ui.drawing.points[1] = local;
    }
    scheduleOverlayRender();
  });

  overlay.addEventListener('pointerup', event => {
    if (ui.interaction && ui.interaction.pointerId === event.pointerId) {
      finishSelectionInteraction(event);
      return;
    }
    finishDrawing(event);
  });
  overlay.addEventListener('pointercancel', event => {
    if (ui.interaction && ui.interaction.pointerId === event.pointerId) cancelSelectionInteraction();
    else cancelDrawing(event);
  });

  function applyMoveInteraction(interaction, local, snapDisabled) {
    const rawDelta = [local[0] - interaction.start[0], local[1] - interaction.start[1]];
    let delta = rawDelta;
    ui.snapGuide = null;
    const primaryOriginal = interaction.originals.get(ui.selectedId);
    const centerGeo = geometryCenter(primaryOriginal);
    const centerLocal = centerGeo ? geoToLocal(centerGeo) : null;
    if (centerLocal && state.preferences.snap && !snapDisabled) {
      const movingCenter = [centerLocal[0] + rawDelta[0], centerLocal[1] + rawDelta[1]];
      const snap = nearestSnap(movingCenter, new Set(interaction.originals.keys()));
      if (snap) {
        delta = [snap.point[0] - centerLocal[0], snap.point[1] - centerLocal[1]];
        ui.snapGuide = { point: snap.point, from: movingCenter };
      }
    }
    for (const [id, original] of interaction.originals) {
      const annotation = findAnnotation(id);
      if (!annotation) continue;
      annotation.geometry = translateGeometryByPixels(original, delta[0], delta[1]);
      annotation.updatedAt = new Date().toISOString();
    }
  }

  function applyHandleInteraction(interaction, local, snapDisabled) {
    const annotation = findAnnotation(interaction.annotationId);
    const original = interaction.originals.get(interaction.annotationId);
    if (!annotation || !original) return;
    let target = local;
    ui.snapGuide = null;
    if (state.preferences.snap && !snapDisabled) {
      const snap = nearestSnap(local, new Set([annotation.id]));
      if (snap) {
        target = snap.point;
        ui.snapGuide = { point: snap.point, from: local };
      }
    }

    if (annotation.type === 'arrow' || annotation.type === 'pen' || annotation.type === 'route') {
      const coordinates = structuredCloneSafe(original.coordinates || []);
      if (!coordinates[interaction.index]) return;
      coordinates[interaction.index] = localToGeo(target);
      annotation.geometry = { ...structuredCloneSafe(original), coordinates };
    } else if (annotation.type === 'polygon') {
      const ring = structuredCloneSafe(original.coordinates?.[0] || []);
      const unique = ring.slice(0, -1);
      if (!unique[interaction.index]) return;
      unique[interaction.index] = localToGeo(target);
      annotation.geometry = { ...structuredCloneSafe(original), coordinates: [[...unique, structuredCloneSafe(unique[0])]] };
    } else if (annotation.type === 'circle') {
      const center = geometryCenter(original);
      const targetGeo = localToGeo(target);
      if (!center || !targetGeo) return;
      annotation.geometry = circleGeometry(center, haversineMeters(center, targetGeo));
    } else if (annotation.type === 'box') {
      const ring = structuredCloneSafe(original.coordinates?.[0] || []);
      const locals = ring.slice(0, 4).map(geoToLocal);
      if (locals.length < 4 || locals.some(point => !point)) return;
      const index = interaction.index;
      locals[index] = target;
      if (index === 0) { locals[1][1] = target[1]; locals[3][0] = target[0]; }
      if (index === 1) { locals[0][1] = target[1]; locals[2][0] = target[0]; }
      if (index === 2) { locals[1][0] = target[0]; locals[3][1] = target[1]; }
      if (index === 3) { locals[0][0] = target[0]; locals[2][1] = target[1]; }
      locals.push([...locals[0]]);
      annotation.geometry = { ...structuredCloneSafe(original), coordinates: [locals.map(localToGeo)] };
    }
    annotation.updatedAt = new Date().toISOString();
  }

  function finishSelectionInteraction(event) {
    const interaction = ui.interaction;
    ui.interaction = null;
    ui.snapGuide = null;
    try { overlay.releasePointerCapture?.(event.pointerId); } catch (_) { /* inactive pointer */ }
    if (interaction.moved) {
      saveStateSoon();
      ui.suppressClickUntil = Date.now() + 350;
    } else {
      ui.expanded = true;
      if (interaction.kind === 'handle') ui.suppressClickUntil = Date.now() + 300;
    }
    renderAll();
  }

  function cancelSelectionInteraction() {
    const interaction = ui.interaction;
    if (!interaction) return;
    for (const [id, geometry] of interaction.originals) {
      const annotation = findAnnotation(id);
      if (annotation) annotation.geometry = structuredCloneSafe(geometry);
    }
    if (interaction.undoPushed) ui.undo.pop();
    ui.interaction = null;
    ui.snapGuide = null;
    renderAll();
  }

  function finishDrawing(event) {
    if (!ui.drawing || ui.drawing.pointerId !== event.pointerId) return;
    event.preventDefault();
    const drawing = ui.drawing;
    ui.drawing = null;
    try { overlay.releasePointerCapture?.(event.pointerId); } catch (_) { /* synthetic or inactive pointer */ }

    if (drawing.type === 'pen') {
      const points = simplifyPolyline(drawing.points, 2.5);
      if (points.length >= 2 && polylineLength(points) >= 8) {
        addGeometryAnnotation('pen', { type: 'LineString', coordinates: points.map(localToGeo).filter(Boolean) });
      }
    } else if (drawing.type === 'arrow' && drawing.points.length >= 2 && distance(drawing.points[0], drawing.points[1]) >= 8) {
      addGeometryAnnotation('arrow', { type: 'LineString', coordinates: drawing.points.slice(0, 2).map(localToGeo).filter(Boolean) });
    } else if (drawing.type === 'box' && drawing.points.length >= 2 && distance(drawing.points[0], drawing.points[1]) >= 8) {
      const [a, b] = drawing.points;
      const localRing = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
      addGeometryAnnotation('box', { type: 'Polygon', coordinates: [localRing.map(localToGeo).filter(Boolean)] });
    } else if (drawing.type === 'circle' && drawing.points.length >= 2 && distance(drawing.points[0], drawing.points[1]) >= 8) {
      const center = localToGeo(drawing.points[0]);
      const edge = localToGeo(drawing.points[1]);
      if (center && edge) addGeometryAnnotation('circle', circleGeometry(center, haversineMeters(center, edge)));
    } else renderOverlay();
  }

  function completeMultiPointDrawing() {
    const drawing = ui.drawing;
    if (!drawing || !['route','polygon'].includes(drawing.type)) return false;
    const points = dedupeLocalPoints(drawing.points);
    const minimum = drawing.type === 'polygon' ? 3 : 2;
    if (points.length < minimum) {
      setStatus(`${TOOL_LABELS[drawing.type]} needs at least ${minimum} distinct points.`, true);
      return false;
    }
    ui.drawing = null;
    if (drawing.type === 'route') {
      addGeometryAnnotation('route', { type: 'LineString', coordinates: points.map(localToGeo).filter(Boolean) });
    } else {
      const coordinates = points.map(localToGeo).filter(Boolean);
      coordinates.push(structuredCloneSafe(coordinates[0]));
      addGeometryAnnotation('polygon', { type: 'Polygon', coordinates: [coordinates] });
    }
    return true;
  }

  function dedupeLocalPoints(points) {
    const output = [];
    for (const point of points || []) if (!output.length || distance(output.at(-1), point) >= 3) output.push(point);
    if (output.length > 2 && distance(output[0], output.at(-1)) < 4) output.pop();
    return output;
  }

  function snappedDrawingPoint(local, snapDisabled) {
    ui.snapGuide = null;
    if (!state.preferences.snap || snapDisabled) return local;
    const snap = nearestSnap(local, new Set());
    if (!snap) return local;
    ui.snapGuide = { point: snap.point, from: local };
    return snap.point;
  }

  function cancelDrawing(event) {
    if (!ui.drawing) return;
    if (event?.pointerId && ui.drawing.pointerId !== event.pointerId) return;
    ui.drawing = null;
    renderOverlay();
  }

  function addPointAnnotation(type, local) {
    if (!isLayerEditable()) { setStatus('Choose an unlocked, active layer before adding markup.', true); return; }
    const coordinate = localToGeo(local);
    if (!coordinate) return;
    pushUndo();
    const annotation = createAnnotation(type, { type: 'Point', coordinates: coordinate });
    if (type === 'callout') annotation.calloutNumber = nextCalloutNumber();
    if (type === 'marker' || type === 'callout') annotation.markerIcon = state.preferences.markerIcon;
    state.annotations.push(annotation);
    setSelection([annotation.id], annotation.id, false);
    ui.tool = 'select';
    ui.expanded = true;
    saveStateSoon();
    renderAll();
    setTimeout(() => shadow.querySelector('#mm-title')?.select(), 0);
  }

  function addGeometryAnnotation(type, geometry) {
    if (!isLayerEditable()) { setStatus('Choose an unlocked, active layer before adding markup.', true); return; }
    if (!geometry.coordinates || !geometry.coordinates.length) return;
    pushUndo();
    const annotation = createAnnotation(type, geometry);
    state.annotations.push(annotation);
    setSelection([annotation.id], annotation.id, false);
    ui.tool = 'select';
    ui.expanded = true;
    saveStateSoon();
    renderAll();
  }

  function createAnnotation(type, geometry) {
    const now = new Date().toISOString();
    return {
      id: makeId(type),
      type,
      collectionId: state.activeCollectionId,
      title: defaultTitle(type),
      note: '',
      tags: '',
      status: 'open',
      priority: 'normal',
      owner: '',
      legendLabel: '',
      markerIcon: state.preferences.markerIcon,
      calloutNumber: type === 'callout' ? nextCalloutNumber() : null,
      showMeasurement: true,
      color: state.preferences.color,
      strokeWidth: state.preferences.strokeWidth,
      geometry,
      createdAt: now,
      updatedAt: now,
    };
  }

  function defaultTitle(type) {
    return ({
      note: 'Map note',
      label: 'Map label',
      arrow: 'Map arrow',
      box: 'Marked area',
      pen: 'Map sketch',
      callout: 'Map callout',
      marker: 'Map marker',
      route: 'Measured route',
      polygon: 'Measured area',
      circle: 'Radius area',
    })[type] || 'Map annotation';
  }

  function nextCalloutNumber() {
    const numbers = state.annotations.filter(annotation => annotation.collectionId === state.activeCollectionId && annotation.type === 'callout').map(annotation => Number(annotation.calloutNumber) || 0);
    return Math.max(0, ...numbers) + 1;
  }

  function project(lat, lng, zoom) {
    const scale = APP.tileSize * Math.pow(2, zoom);
    const sin = clamp(Math.sin(lat * Math.PI / 180), -0.9999, 0.9999);
    const x = (lng + 180) / 360;
    const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    return { x: x * scale, y: y * scale, scale };
  }

  function unproject(x, y, zoom) {
    const scale = APP.tileSize * Math.pow(2, zoom);
    const lng = (x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
    return [normalizeLng(lng), clamp(lat, -85.05112878, 85.05112878)];
  }

  function geoToLocal(coordinate) {
    if (!ui.mapView || !ui.mapRect || !isCoordinate(coordinate)) return null;
    const [lng, lat] = coordinate;
    const center = project(ui.mapView.lat, ui.mapView.lng, ui.mapView.zoom);
    const point = project(lat, lng, ui.mapView.zoom);
    let dx = point.x - center.x;
    if (dx > center.scale / 2) dx -= center.scale;
    if (dx < -center.scale / 2) dx += center.scale;
    return [
      ui.mapRect.width / 2 + dx,
      ui.mapRect.height / 2 + (point.y - center.y),
    ];
  }

  function localToGeo(local) {
    if (!ui.mapView || !ui.mapRect || !Array.isArray(local)) return null;
    const center = project(ui.mapView.lat, ui.mapView.lng, ui.mapView.zoom);
    const x = center.x + local[0] - ui.mapRect.width / 2;
    const y = center.y + local[1] - ui.mapRect.height / 2;
    return unproject(x, y, ui.mapView.zoom);
  }

  function geometryCoordinates(geometry) {
    const output = [];
    flattenCoordinates(geometry?.coordinates, output);
    return output;
  }

  function geometryCenter(geometry) {
    const valid = geometryCoordinates(geometry).filter(isCoordinate);
    if (!valid.length) return null;
    const lng = valid.reduce((sum, point) => sum + Number(point[0]), 0) / valid.length;
    const lat = valid.reduce((sum, point) => sum + Number(point[1]), 0) / valid.length;
    return [normalizeLng(lng), lat];
  }

  function annotationCenter(annotation) {
    return annotation ? geometryCenter(annotation.geometry) : null;
  }

  function translateGeometryByPixels(geometry, dx, dy) {
    const copy = structuredCloneSafe(geometry);
    const translate = value => {
      if (isCoordinate(value)) {
        const local = geoToLocal(value);
        return local ? localToGeo([local[0] + dx, local[1] + dy]) : value;
      }
      return Array.isArray(value) ? value.map(translate) : value;
    };
    copy.coordinates = translate(copy.coordinates);
    return copy;
  }

  function translateGeometryGeodesic(geometry, [deltaLng, deltaLat]) {
    const copy = structuredCloneSafe(geometry);
    const translate = value => {
      if (isCoordinate(value)) return [normalizeLng(Number(value[0]) + deltaLng), clamp(Number(value[1]) + deltaLat, -85.05112878, 85.05112878)];
      return Array.isArray(value) ? value.map(translate) : value;
    };
    copy.coordinates = translate(copy.coordinates);
    return copy;
  }

  function circleGeometry(center, radiusMeters, segments = 64) {
    const radius = clamp(Number(radiusMeters) || 1, 1, 20000000);
    const ring = [];
    for (let i = 0; i < segments; i += 1) ring.push(destinationPoint(center, radius, (i / segments) * 360));
    ring.push(structuredCloneSafe(ring[0]));
    return { type: 'Polygon', coordinates: [ring] };
  }

  function destinationPoint([lng, lat], distanceMeters, bearingDegrees) {
    const earth = 6371008.8;
    const angular = distanceMeters / earth;
    const bearing = bearingDegrees * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lng1 = lng * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lng2 = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    return [normalizeLng(lng2 * 180 / Math.PI), clamp(lat2 * 180 / Math.PI, -85.05112878, 85.05112878)];
  }

  function annotationMeasurements(annotation) {
    if (!annotation?.geometry) return [];
    if (annotation.type === 'route') return [['Distance', formatMeasurementDistance(lineLengthMeters(annotation.geometry.coordinates || []))]];
    if (annotation.type === 'polygon') {
      const ring = annotation.geometry.coordinates?.[0] || [];
      return [['Perimeter', formatMeasurementDistance(lineLengthMeters(ring))], ['Area', formatMeasurementArea(polygonAreaMeters2(ring))]];
    }
    if (annotation.type === 'circle') {
      const ring = annotation.geometry.coordinates?.[0] || [];
      const center = annotationCenter(annotation);
      const radius = center && ring[0] ? haversineMeters(center, ring[0]) : 0;
      return [['Radius', formatMeasurementDistance(radius)], ['Diameter', formatMeasurementDistance(radius * 2)], ['Area', formatMeasurementArea(Math.PI * radius * radius)]];
    }
    return [];
  }

  function measurementLabel(annotation) {
    const metrics = annotationMeasurements(annotation);
    return metrics.map(([label, value]) => `${label}: ${value}`).join(' · ');
  }

  function lineLengthMeters(points) {
    let total = 0;
    for (let i = 1; i < (points || []).length; i += 1) total += haversineMeters(points[i - 1], points[i]);
    return total;
  }

  function polygonAreaMeters2(ring) {
    const points = (ring || []).filter(isCoordinate);
    if (points.length < 4) return 0;
    const meanLat = points.reduce((sum, point) => sum + point[1], 0) / points.length * Math.PI / 180;
    const earth = 6371008.8;
    const projected = points.map(([lng, lat]) => [earth * lng * Math.PI / 180 * Math.cos(meanLat), earth * lat * Math.PI / 180]);
    let sum = 0;
    for (let i = 0; i < projected.length - 1; i += 1) sum += projected[i][0] * projected[i + 1][1] - projected[i + 1][0] * projected[i][1];
    return Math.abs(sum) / 2;
  }

  function formatMeasurementDistance(meters) {
    if (!Number.isFinite(meters)) return 'n/a';
    if (meters < 0.3048) return `${Math.round(meters * 100)} cm`;
    if (meters < 160.9344) return `${Math.round(meters * 3.28084)} ft`;
    if (meters < 1000) return `${Math.round(meters)} m`;
    if (meters < 16093.44) return `${(meters / 1609.344).toFixed(2)} mi`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function formatMeasurementArea(squareMeters) {
    if (!Number.isFinite(squareMeters)) return 'n/a';
    if (squareMeters < 10) return `${squareMeters.toFixed(1)} m²`;
    if (squareMeters < 10000) return `${Math.round(squareMeters)} m²`;
    const acres = squareMeters / 4046.8564224;
    if (acres < 640) return `${acres.toFixed(acres < 10 ? 2 : 1)} ac`;
    return `${(squareMeters / 1e6).toFixed(2)} km²`;
  }

  function haversineMeters(a, b) { return haversineKm(a, b) * 1000; }

  function polylineMidpoint(points) {
    if (!points?.length) return null;
    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) { const length = distance(points[i - 1], points[i]); lengths.push(length); total += length; }
    let target = total / 2;
    for (let i = 0; i < lengths.length; i += 1) {
      if (target <= lengths[i]) { const t = lengths[i] ? target / lengths[i] : 0; return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t]; }
      target -= lengths[i];
    }
    return points.at(-1);
  }

  function polygonVisualCenter(points) {
    const unique = (points || []).slice(0, -1);
    if (!unique.length) return null;
    return [unique.reduce((sum, point) => sum + point[0], 0) / unique.length, unique.reduce((sum, point) => sum + point[1], 0) / unique.length];
  }

  function nudgeSelection(dx, dy) {
    const selected = selectedAnnotations().filter(annotation => !isAnnotationLocked(annotation));
    if (!selected.length || !ui.mapView || !ui.mapRect) return;
    pushUndo();
    selected.forEach(annotation => {
      annotation.geometry = translateGeometryByPixels(annotation.geometry, dx, dy);
      annotation.updatedAt = new Date().toISOString();
    });
    saveStateSoon();
    renderAll();
  }

  function nearestSnap(local, excludedIds = new Set(), threshold = 13) {
    const targets = collectSnapTargets(excludedIds);
    let nearest = null;
    let best = threshold;
    for (const target of targets) {
      const d = distance(local, target.point);
      if (d < best) {
        best = d;
        nearest = target;
      }
    }
    return nearest;
  }

  function collectSnapTargets(excludedIds) {
    const targets = [];
    for (const annotation of annotationsForCurrentCollection()) {
      if (excludedIds.has(annotation.id)) continue;
      const coordinates = geometryCoordinates(annotation.geometry);
      const step = Math.max(1, Math.ceil(coordinates.length / 40));
      coordinates.forEach((coordinate, index) => {
        if (index % step !== 0 && index !== coordinates.length - 1) return;
        const point = geoToLocal(coordinate);
        if (point && nearViewport(point, 20)) targets.push({ point, source: annotation.id });
      });
      const center = annotationCenter(annotation);
      const point = center ? geoToLocal(center) : null;
      if (point && nearViewport(point, 20)) targets.push({ point, source: annotation.id });
    }
    collectVisibleMapMarkerTargets().forEach(point => targets.push({ point, source: 'map-marker' }));
    return targets;
  }

  function collectVisibleMapMarkerTargets() {
    if (!ui.mapRect) return [];
    const selectors = [
      '.yNHHyP-marker-view',
      '[class*="marker-view"]',
      '[class*="Marker"][role="button"]',
      '[class*="marker"][role="button"]',
    ];
    const elements = new Set(document.querySelectorAll(selectors.join(',')));
    const points = [];
    elements.forEach(element => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.width > 90 || rect.height > 90) return;
      const x = rect.left + rect.width / 2 - ui.mapRect.left;
      const y = rect.top + rect.height / 2 - ui.mapRect.top;
      const point = [x, y];
      if (nearViewport(point, 0)) points.push(point);
    });
    return points;
  }

  function centerOnAnnotation(id) {
    const annotation = findAnnotation(id);
    const center = annotationCenter(annotation);
    if (!annotation || !center) return;
    try { sessionStorage.setItem('mapmark.pendingFocus', id); } catch (_) { /* storage unavailable */ }
    const coordinates = geometryCoordinates(annotation.geometry).filter(isCoordinate);
    let zoom = ui.mapView?.zoom || 18;
    if (coordinates.length > 1) {
      const lngs = coordinates.map(point => Number(point[0]));
      const lats = coordinates.map(point => Number(point[1]));
      zoom = fitZoom([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]);
    } else {
      zoom = Math.max(17, zoom);
    }
    zoom = clamp(Math.round(zoom * 10) / 10, 2, 21);
    location.assign(`https://www.google.com/maps/@${center[1].toFixed(7)},${center[0].toFixed(7)},${zoom}z`);
  }

  function zoomToSelection() {
    const selected = selectedAnnotations();
    if (!selected.length) return;
    const coordinates = selected.flatMap(annotation => geometryCoordinates(annotation.geometry)).filter(isCoordinate);
    if (!coordinates.length) return;
    const lngs = coordinates.map(point => Number(point[0]));
    const lats = coordinates.map(point => Number(point[1]));
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const center = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    let zoom = coordinates.length === 1 ? Math.max(18, ui.mapView?.zoom || 18) : fitZoom([minLng, minLat, maxLng, maxLat]);
    zoom = clamp(Math.round(zoom * 10) / 10, 2, 21);
    location.assign(`https://www.google.com/maps/@${center[1].toFixed(7)},${center[0].toFixed(7)},${zoom}z`);
  }

  function fitZoom([minLng, minLat, maxLng, maxLat]) {
    const width = Math.max(220, ui.mapRect?.width || window.innerWidth) * 0.72;
    const height = Math.max(180, ui.mapRect?.height || window.innerHeight) * 0.68;
    for (let zoom = 21; zoom >= 2; zoom -= 0.25) {
      const a = project(maxLat, minLng, zoom);
      const b = project(minLat, maxLng, zoom);
      if (Math.abs(b.x - a.x) <= width && Math.abs(b.y - a.y) <= height) return zoom;
    }
    return 2;
  }

  function evidenceAnnotations(scope = state.preferences.evidence.scope) {
    let result;
    switch (scope) {
      case 'active':
        result = state.annotations.filter(annotation => annotation.collectionId === state.activeCollectionId);
        break;
      case 'selected':
        result = selectedAnnotations();
        break;
      case 'register':
        result = filteredRegisterAnnotations();
        break;
      case 'all':
        result = annotationsForProject(state.activeProjectId);
        break;
      case 'visible':
      default:
        result = annotationsForCurrentCollection();
        break;
    }
    return [...result].sort(registerComparator('created-asc'));
  }

  function defaultEvidenceTitle() {
    const project = currentProject();
    const active = activeLayer();
    return `${project?.name || active?.name || 'Map'} Evidence`;
  }

  function buildEvidenceContext(annotations = evidenceAnnotations()) {
    const evidence = state.preferences.evidence;
    const capturedAt = new Date();
    const collectionNames = [...new Set(annotations.map(annotation => state.collections.find(collection => collection.id === annotation.collectionId)?.name || 'Unknown layer'))];
    const statusCounts = Object.fromEntries(Object.keys(STATUS_LABELS).map(status => [status, annotations.filter(annotation => annotation.status === status).length]));
    const typeCounts = Object.fromEntries(ANNOTATION_TYPES.map(type => [type, annotations.filter(annotation => annotation.type === type).length]));
    return {
      title: evidence.title.trim() || defaultEvidenceTitle(),
      subtitle: evidence.subtitle.trim(),
      scope: evidence.scope,
      scopeLabel: EVIDENCE_SCOPES[evidence.scope] || EVIDENCE_SCOPES.visible,
      annotations,
      collectionNames,
      project: currentProject() ? structuredCloneSafe(currentProject()) : null,
      statusCounts,
      typeCounts,
      capturedAt,
      capturedAtIso: capturedAt.toISOString(),
      sourceUrl: location.href,
      mapView: ui.mapView ? { ...ui.mapView } : null,
      mapRect: ui.mapRect ? { ...ui.mapRect } : null,
      options: { ...evidence },
      applicationVersion: APP.version,
    };
  }

  async function captureEvidencePng() {
    if (ui.captureBusy) return;
    try {
      const result = await captureEvidenceCanvas();
      await downloadCanvas(result.canvas, `mapmark-evidence-${dateStamp()}.png`);
      setStatus(`Captured ${result.context.annotations.length} annotation${result.context.annotations.length === 1 ? '' : 's'} as PNG.`, false);
    } catch (error) {
      handleCaptureError(error);
    }
  }

  async function openPrintableEvidenceReport() {
    if (ui.captureBusy) return;
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      setStatus('The printable report window was blocked. Allow pop-ups for Google Maps and try again.', true);
      return;
    }
    reportWindow.document.write('<!doctype html><title>Preparing MAPMARK report…</title><body style="font:16px system-ui;padding:32px">Preparing MAPMARK evidence report…</body>');
    try {
      const result = await captureEvidenceCanvas();
      const imageDataUrl = result.canvas.toDataURL('image/png');
      reportWindow.document.open();
      reportWindow.document.write(buildPrintableReportHtml(result.context, imageDataUrl));
      reportWindow.document.close();
      reportWindow.opener = null;
      setStatus('Printable evidence report opened in a new tab.', false);
    } catch (error) {
      reportWindow.close();
      handleCaptureError(error);
    }
  }

  function handleCaptureError(error) {
    console.warn(`[${APP.name}] Evidence capture failed.`, error);
    const name = error?.name || '';
    if (name === 'NotAllowedError') {
      setStatus('Capture was cancelled or blocked. Try again and choose the current browser tab.', true);
    } else {
      setStatus(`Evidence capture failed: ${error?.message || 'Unknown error'}`, true);
    }
  }

  async function captureEvidenceCanvas() {
    const annotations = evidenceAnnotations();
    if (!annotations.length) throw new Error('The selected evidence scope contains no annotations.');
    updateMapContext();
    if (!ui.mapRect || !ui.mapView) throw new Error('A standard 2D Google Maps viewport is required.');
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser does not support tab capture.');

    ui.captureBusy = true;
    renderShell();
    setStatus('Choose the current browser tab in the capture prompt.', false);
    let stream = null;
    const previousHidden = ui.hidden;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 15 } },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      });
      const track = stream.getVideoTracks()[0];
      const surface = track?.getSettings?.().displaySurface;
      if (surface && surface !== 'browser') throw new Error('Choose the current browser tab rather than a window or entire screen.');

      ui.captureMode = true;
      ui.captureIds = new Set(annotations.map(annotation => annotation.id));
      ui.hidden = false;
      shell.style.display = 'none';
      updateMapContext();
      renderOverlay();
      await nextPaint(3);

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await waitForVideoFrame(video);

      const scaleX = video.videoWidth / Math.max(1, window.innerWidth);
      const scaleY = video.videoHeight / Math.max(1, window.innerHeight);
      const crop = {
        x: Math.max(0, Math.round(ui.mapRect.left * scaleX)),
        y: Math.max(0, Math.round(ui.mapRect.top * scaleY)),
        width: Math.min(video.videoWidth, Math.max(1, Math.round(ui.mapRect.width * scaleX))),
        height: Math.min(video.videoHeight, Math.max(1, Math.round(ui.mapRect.height * scaleY))),
      };
      crop.width = Math.min(crop.width, video.videoWidth - crop.x);
      crop.height = Math.min(crop.height, video.videoHeight - crop.y);
      if (crop.width < 200 || crop.height < 160) throw new Error('The captured tab did not match the current map viewport.');

      const mapCanvas = document.createElement('canvas');
      mapCanvas.width = crop.width;
      mapCanvas.height = crop.height;
      const mapContext = mapCanvas.getContext('2d');
      mapContext.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      const context = buildEvidenceContext(annotations);
      const canvas = buildEvidenceCanvas(mapCanvas, context, scaleX);
      return { canvas, context };
    } finally {
      stream?.getTracks?.().forEach(track => track.stop());
      ui.captureMode = false;
      ui.captureIds = null;
      ui.captureBusy = false;
      ui.hidden = previousHidden;
      shell.style.display = '';
      updateOverlayInteraction();
      renderAll();
    }
  }

  async function waitForVideoFrame(video) {
    await Promise.race([
      video.play(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out while starting the captured tab.')), 5000)),
    ]);
    if (video.readyState < 2 || !video.videoWidth) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out while reading the captured tab.')), 5000);
        video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The captured tab could not be decoded.')); }, { once: true });
      });
    }
    if ('requestVideoFrameCallback' in video) {
      await new Promise(resolve => video.requestVideoFrameCallback(() => resolve()));
    } else {
      await nextPaint(2);
    }
  }

  function nextPaint(frames = 1) {
    return new Promise(resolve => {
      const step = remaining => requestAnimationFrame(() => remaining > 1 ? step(remaining - 1) : resolve());
      step(Math.max(1, frames));
    });
  }

  function buildEvidenceCanvas(mapCanvas, context, captureScale = 1) {
    const options = context.options;
    const unit = Math.max(1, Math.min(2.2, mapCanvas.width / 1050));
    const headerHeight = options.includeTitleBlock ? Math.round(92 * unit) : 0;
    const legendHeight = options.includeLegend ? Math.round(58 * unit) : 0;
    const output = document.createElement('canvas');
    output.width = mapCanvas.width;
    output.height = headerHeight + mapCanvas.height + legendHeight;
    const ctx = output.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, output.width, output.height);

    if (headerHeight) drawEvidenceTitleBlock(ctx, context, output.width, headerHeight, unit);
    ctx.drawImage(mapCanvas, 0, headerHeight);
    if (options.includeNorthArrow) drawNorthArrow(ctx, output.width - 38 * unit, headerHeight + 40 * unit, unit);
    if (options.includeScaleBar && context.mapView) drawScaleBar(ctx, 24 * unit, headerHeight + mapCanvas.height - 30 * unit, context.mapView, captureScale, unit);
    if (legendHeight) drawEvidenceLegend(ctx, context, headerHeight + mapCanvas.height, output.width, legendHeight, unit);
    return output;
  }

  function drawEvidenceTitleBlock(ctx, context, width, height, unit) {
    const pad = 18 * unit;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#c9d0d4';
    ctx.lineWidth = Math.max(1, unit);
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();
    ctx.fillStyle = '#172027';
    ctx.font = `700 ${Math.round(24 * unit)}px system-ui, sans-serif`;
    ctx.fillText(truncateCanvasText(ctx, context.title, width * 0.62), pad, 32 * unit);
    if (context.subtitle) {
      ctx.fillStyle = '#53636c';
      ctx.font = `500 ${Math.round(12 * unit)}px system-ui, sans-serif`;
      ctx.fillText(truncateCanvasText(ctx, context.subtitle, width * 0.62), pad, 54 * unit);
    }
    ctx.fillStyle = '#53636c';
    ctx.font = `500 ${Math.round(10 * unit)}px system-ui, sans-serif`;
    const sets = context.collectionNames.join(', ');
    ctx.fillText(truncateCanvasText(ctx, `${context.annotations.length} annotations · ${sets}`, width * 0.62), pad, 75 * unit);

    const right = width - pad;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#172027';
    ctx.font = `800 ${Math.round(12 * unit)}px system-ui, sans-serif`;
    ctx.fillText(`MAPMARK v${context.applicationVersion}`, right, 24 * unit);
    ctx.fillStyle = '#53636c';
    ctx.font = `500 ${Math.round(9 * unit)}px system-ui, sans-serif`;
    ctx.fillText(formatDateTime(context.capturedAtIso), right, 43 * unit);
    if (context.mapView) ctx.fillText(`${context.mapView.lat.toFixed(6)}, ${context.mapView.lng.toFixed(6)} · z${formatZoom(context.mapView.zoom)}`, right, 59 * unit);
    ctx.fillText(truncateCanvasText(ctx, location.hostname, width * 0.30), right, 75 * unit);
    ctx.textAlign = 'left';
  }

  function drawNorthArrow(ctx, x, y, unit) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.strokeStyle = '#172027';
    ctx.lineWidth = Math.max(1.5, unit);
    ctx.beginPath();
    ctx.roundRect(-17 * unit, -27 * unit, 34 * unit, 52 * unit, 7 * unit);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#172027';
    ctx.textAlign = 'center';
    ctx.font = `800 ${Math.round(12 * unit)}px system-ui, sans-serif`;
    ctx.fillText('N', 0, -10 * unit);
    ctx.beginPath();
    ctx.moveTo(0, -5 * unit);
    ctx.lineTo(-7 * unit, 13 * unit);
    ctx.lineTo(0, 9 * unit);
    ctx.lineTo(7 * unit, 13 * unit);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawScaleBar(ctx, x, y, mapView, captureScale, unit) {
    const metersPerCssPixel = 156543.03392 * Math.cos(mapView.lat * Math.PI / 180) / (2 ** mapView.zoom);
    const desiredMeters = Math.max(0.01, metersPerCssPixel * 120);
    const meters = niceScaleDistance(desiredMeters);
    const pixels = (meters / metersPerCssPixel) * captureScale;
    const label = formatScaleDistance(meters);
    ctx.save();
    ctx.font = `700 ${Math.round(10 * unit)}px system-ui, sans-serif`;
    const boxWidth = Math.max(pixels + 24 * unit, ctx.measureText(label).width + 24 * unit);
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.strokeStyle = '#172027';
    ctx.lineWidth = Math.max(1.5, unit);
    ctx.beginPath();
    ctx.roundRect(x - 8 * unit, y - 25 * unit, boxWidth, 34 * unit, 6 * unit);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + pixels, y);
    ctx.moveTo(x, y - 6 * unit);
    ctx.lineTo(x, y + 2 * unit);
    ctx.moveTo(x + pixels, y - 6 * unit);
    ctx.lineTo(x + pixels, y + 2 * unit);
    ctx.stroke();
    ctx.fillStyle = '#172027';
    ctx.fillText(label, x, y - 9 * unit);
    ctx.restore();
  }

  function niceScaleDistance(value) {
    const power = 10 ** Math.floor(Math.log10(value));
    const normalized = value / power;
    const nice = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
    return nice * power;
  }

  function formatScaleDistance(meters) {
    if (meters >= 1000) return `${roundSmart(meters / 1000)} km`;
    if (meters >= 1) return `${roundSmart(meters)} m`;
    return `${roundSmart(meters * 100)} cm`;
  }

  function roundSmart(value) {
    if (value >= 100) return Math.round(value);
    if (value >= 10) return Math.round(value * 10) / 10;
    return Math.round(value * 100) / 100;
  }

  function drawEvidenceLegend(ctx, context, y, width, height, unit) {
    const groups = evidenceLegendGroups(context.annotations);
    if (!groups.length) return;
    const boxHeight = 52 * unit;
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.fillRect(0, y, width, boxHeight);
    ctx.strokeStyle = '#d7dde0';
    ctx.lineWidth = unit;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    ctx.font = `${9 * unit}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    let x = 18 * unit;
    const baseline = y + 18 * unit;
    for (const group of groups.slice(0, 8)) {
      ctx.fillStyle = group.color;
      ctx.fillRect(x, baseline - 5 * unit, 10 * unit, 10 * unit);
      x += 14 * unit;
      ctx.fillStyle = '#172027';
      const text = `${group.label} (${group.count})`;
      ctx.fillText(text, x, baseline);
      x += Math.min(150 * unit, ctx.measureText(text).width + 18 * unit);
      if (x > width - 130 * unit) break;
    }
    ctx.fillStyle = '#617079';
    ctx.font = `${8 * unit}px system-ui, sans-serif`;
    ctx.fillText(`Scope: ${context.scopeLabel} · Captured ${context.capturedAt.toLocaleString()} · Source retained in report metadata`, 18 * unit, y + 39 * unit);
  }

  function evidenceLegendGroups(annotations) {
    const custom = new Map();
    for (const annotation of annotations || []) {
      const label = annotation.legendLabel?.trim() || `${TOOL_LABELS[annotation.type] || annotation.type}`;
      const key = `${annotation.color}|${label}`;
      const existing = custom.get(key) || { label, color: annotation.color, count: 0 };
      existing.count += 1;
      custom.set(key, existing);
    }
    return [...custom.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function statusLegendColor(status) {
    return { open: '#1565c0', review: '#f9a825', resolved: '#2e7d32', archived: '#6b7479' }[status] || '#6b7479';
  }

  function truncateCanvasText(ctx, value, maxWidth) {
    const text = String(value || '');
    if (ctx.measureText(text).width <= maxWidth) return text;
    let output = text;
    while (output.length > 3 && ctx.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
    return `${output}…`;
  }

  function buildPrintableReportHtml(context, imageDataUrl) {
    const summaryRows = Object.entries(STATUS_LABELS).map(([status, label]) => `<div><strong>${context.statusCounts[status] || 0}</strong><span>${escapeHtml(label)}</span></div>`).join('');
    const annotationRows = context.options.includeTable
      ? context.annotations.map((annotation, index) => printableAnnotationRow(annotation, index)).join('')
      : '';
    const mapView = context.mapView ? `${context.mapView.lat.toFixed(6)}, ${context.mapView.lng.toFixed(6)} · zoom ${formatZoom(context.mapView.zoom)}` : 'Unavailable';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(context.title)} — MAPMARK</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182128;background:#eef1f2}*{box-sizing:border-box}body{margin:0}.bar{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:#182128;color:#fff}.bar button{border:0;border-radius:7px;padding:9px 14px;font:700 13px inherit;cursor:pointer}.page{width:min(1100px,calc(100% - 28px));margin:20px auto;background:#fff;padding:34px;box-shadow:0 10px 30px #0002}.eyebrow{font-size:11px;font-weight:800;letter-spacing:.13em;color:#687780}.title{font-size:30px;line-height:1.1;margin:7px 0}.subtitle{font-size:15px;color:#53636c;margin:0 0 22px}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px;padding:14px 0;border-top:1px solid #d7dde0;border-bottom:1px solid #d7dde0;font-size:12px}.meta div{overflow-wrap:anywhere}.meta strong{display:block;font-size:9px;letter-spacing:.09em;color:#687780;text-transform:uppercase;margin-bottom:2px}.map{display:block;width:100%;margin:22px 0;border:1px solid #cbd2d6}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:18px 0}.summary div{padding:12px;border:1px solid #d7dde0;border-radius:8px}.summary strong{display:block;font-size:24px}.summary span{font-size:11px;color:#687780}.table{width:100%;border-collapse:collapse;font-size:10px}.table th,.table td{padding:7px;border-bottom:1px solid #e1e5e7;text-align:left;vertical-align:top}.table th{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#687780}.ann-title{font-weight:750}.notes{white-space:pre-wrap;max-width:300px}.footer{margin-top:24px;padding-top:12px;border-top:1px solid #d7dde0;color:#687780;font-size:9px}.chip{display:inline-block;padding:2px 6px;border:1px solid #cbd2d6;border-radius:999px;white-space:nowrap}@media print{body{background:#fff}.bar{display:none}.page{width:auto;margin:0;padding:0;box-shadow:none}.map{break-inside:avoid}.table tr{break-inside:avoid}@page{size:landscape;margin:.45in}}@media(max-width:700px){.page{padding:20px}.meta{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,1fr)}.table{font-size:9px}}
</style></head><body>
<div class="bar"><strong>MAPMARK Evidence Report</strong><button onclick="window.print()">Print / Save PDF</button></div>
<main class="page">
<div class="eyebrow">MAPMARK v${escapeHtml(context.applicationVersion)} · EVIDENCE PACKAGE</div>
<h1 class="title">${escapeHtml(context.title)}</h1>
${context.subtitle ? `<p class="subtitle">${escapeHtml(context.subtitle)}</p>` : ''}
<section class="meta">
<div><strong>Captured</strong>${escapeHtml(formatDateTime(context.capturedAtIso))}</div>
<div><strong>Annotation scope</strong>${escapeHtml(context.scopeLabel)} (${context.annotations.length})</div>
<div><strong>Layers</strong>${escapeHtml(context.collectionNames.join(', '))}</div>
<div><strong>Map center</strong>${escapeHtml(mapView)}</div>
<div style="grid-column:1/-1"><strong>Source URL</strong>${escapeHtml(context.sourceUrl)}</div>
</section>
<img class="map" src="${imageDataUrl}" alt="Annotated Google Maps evidence capture">
<section class="summary">${summaryRows}</section>
${context.options.includeTable ? `<h2>Annotation Register</h2><table class="table"><thead><tr><th>#</th><th>Annotation</th><th>Workflow</th><th>Coordinate</th><th>Owner / Tags</th><th>Notes</th></tr></thead><tbody>${annotationRows}</tbody></table>` : ''}
<div class="footer">Generated locally by MAPMARK v${escapeHtml(context.applicationVersion)}. The map image is a browser-tab capture of the current Google Maps viewport. Verify location and scale before relying on this report for field or design decisions.</div>
</main></body></html>`;
  }

  function printableAnnotationRow(annotation, index) {
    const center = annotationCenter(annotation);
    const coordinate = center ? `${center[1].toFixed(6)}, ${center[0].toFixed(6)}` : 'n/a';
    const collection = state.collections.find(item => item.id === annotation.collectionId)?.name || 'Unknown';
    return `<tr><td>${index + 1}</td><td><span class="ann-title">${escapeHtml(annotation.title || defaultTitle(annotation.type))}</span><br>${escapeHtml(TOOL_LABELS[annotation.type] || annotation.type)} · ${escapeHtml(collection)}</td><td><span class="chip">${escapeHtml(STATUS_LABELS[annotation.status])}</span><br>${escapeHtml(PRIORITY_LABELS[annotation.priority])}</td><td>${escapeHtml(coordinate)}${measurementLabel(annotation) ? `<br><strong>${escapeHtml(measurementLabel(annotation))}</strong>` : ''}</td><td>${escapeHtml(annotation.owner || '—')}<br>${escapeHtml(annotation.tags || '')}</td><td class="notes">${escapeHtml(annotation.note || '')}</td></tr>`;
  }

  function exportEvidenceMarkdown() {
    const context = buildEvidenceContext();
    if (!context.annotations.length) { setStatus('The selected evidence scope contains no annotations.', true); return; }
    downloadText(buildEvidenceMarkdown(context), `mapmark-evidence-${dateStamp()}.md`, 'text/markdown;charset=utf-8');
    setStatus(`Exported ${context.annotations.length} annotations as Markdown.`, false);
  }

  function buildEvidenceMarkdown(context = buildEvidenceContext()) {
    const mapView = context.mapView ? `${context.mapView.lat.toFixed(6)}, ${context.mapView.lng.toFixed(6)} at zoom ${formatZoom(context.mapView.zoom)}` : 'Unavailable';
    const lines = [
      `# ${context.title}`,
      context.subtitle ? `\n${context.subtitle}` : '',
      '',
      `> Generated by MAPMARK v${context.applicationVersion} on ${formatDateTime(context.capturedAtIso)}`,
      '',
      '## Capture metadata',
      '',
      `- **Scope:** ${context.scopeLabel}`,
      `- **Layers:** ${context.collectionNames.join(', ') || 'None'}`,
      `- **Map center:** ${mapView}`,
      `- **Source:** ${context.sourceUrl}`,
      `- **Annotations:** ${context.annotations.length}`,
      '',
      '## Workflow summary',
      '',
      ...Object.entries(STATUS_LABELS).map(([status, label]) => `- **${label}:** ${context.statusCounts[status] || 0}`),
      '',
      '## Annotations',
      '',
    ];
    context.annotations.forEach((annotation, index) => {
      const center = annotationCenter(annotation);
      const coordinate = center ? `${center[1].toFixed(6)}, ${center[0].toFixed(6)}` : 'n/a';
      const collection = state.collections.find(item => item.id === annotation.collectionId)?.name || 'Unknown layer';
      lines.push(`### ${index + 1}. ${annotation.title || defaultTitle(annotation.type)}`);
      lines.push('');
      lines.push(`- **Type:** ${TOOL_LABELS[annotation.type] || annotation.type}`);
      lines.push(`- **Layer:** ${collection}`);
      lines.push(`- **Status:** ${STATUS_LABELS[annotation.status]}`);
      lines.push(`- **Priority:** ${PRIORITY_LABELS[annotation.priority]}`);
      lines.push(`- **Owner:** ${annotation.owner || 'Unassigned'}`);
      lines.push(`- **Coordinate:** ${coordinate}`);
      if (annotation.tags) lines.push(`- **Tags:** ${annotation.tags}`);
      lines.push(`- **Created:** ${formatDateTime(annotation.createdAt)}`);
      lines.push(`- **Updated:** ${formatDateTime(annotation.updatedAt)}`);
      if (annotation.note) { lines.push('', annotation.note); }
      lines.push('');
    });
    return lines.filter((line, index, array) => !(line === '' && array[index - 1] === '' && array[index - 2] === '')).join('\n').trim() + '\n';
  }

  function exportEvidenceCsv() {
    const context = buildEvidenceContext();
    if (!context.annotations.length) { setStatus('The selected evidence scope contains no annotations.', true); return; }
    downloadText(buildEvidenceCsv(context), `mapmark-evidence-${dateStamp()}.csv`, 'text/csv;charset=utf-8');
    setStatus(`Exported ${context.annotations.length} annotations as CSV.`, false);
  }

  function buildEvidenceCsv(context = buildEvidenceContext()) {
    const headers = ['id','mapSet','type','title','status','priority','owner','latitude','longitude','measurements','legendLabel','markerIcon','calloutNumber','tags','notes','color','strokeWidth','createdAt','updatedAt','sourceUrl'];
    const rows = context.annotations.map(annotation => {
      const center = annotationCenter(annotation);
      const collection = state.collections.find(item => item.id === annotation.collectionId)?.name || 'Unknown layer';
      return [annotation.id, collection, annotation.type, annotation.title, annotation.status, annotation.priority, annotation.owner, center?.[1] ?? '', center?.[0] ?? '', measurementLabel(annotation), annotation.legendLabel, annotation.markerIcon, annotation.calloutNumber ?? '', annotation.tags, annotation.note, annotation.color, annotation.strokeWidth, annotation.createdAt, annotation.updatedAt, context.sourceUrl];
    });
    return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
    downloadBlob(new Blob([text], { type }), filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCanvas(canvas, filename) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('The PNG could not be encoded.')); return; }
        downloadBlob(blob, filename);
        resolve();
      }, 'image/png');
    });
  }

  function exportNativeJson() {
    const payload = buildNativePackage();
    downloadJson(payload, `mapmark-workspace-${dateStamp()}.json`);
  }

  function exportProjectPackage() {
    const project = currentProject();
    if (!project) return;
    const payload = buildProjectPackage(project.id);
    downloadJson(payload, `${slugId(project.name) || 'mapmark-project'}-${dateStamp()}.mapmark.json`);
  }

  function buildNativePackage() {
    return {
      format: 'mapmark-workspace',
      schema: 6,
      application: APP.name,
      applicationVersion: APP.version,
      exportedAt: new Date().toISOString(),
      sourceUrl: location.href,
      activeProjectId: state.activeProjectId,
      activeCollectionId: state.activeCollectionId,
      showAllCollections: state.showAllCollections,
      preferences: structuredCloneSafe(state.preferences),
      projects: structuredCloneSafe(state.projects),
      collections: structuredCloneSafe(state.collections),
      annotations: structuredCloneSafe(state.annotations),
    };
  }

  function buildProjectPackage(projectId = state.activeProjectId) {
    const project = state.projects.find(item => item.id === projectId);
    if (!project) throw new Error('Project not found.');
    const layers = state.collections.filter(layer => layer.projectId === project.id);
    const layerIds = new Set(layers.map(layer => layer.id));
    return {
      format: 'mapmark-project',
      schema: 6,
      application: APP.name,
      applicationVersion: APP.version,
      exportedAt: new Date().toISOString(),
      sourceUrl: location.href,
      project: structuredCloneSafe(project),
      layers: structuredCloneSafe(layers),
      annotations: structuredCloneSafe(state.annotations.filter(annotation => layerIds.has(annotation.collectionId))),
    };
  }

  function exportGeoJson() {
    downloadJson(buildGeoJson(), `mapmark-${dateStamp()}.geojson`);
  }

  function buildGeoJson() {
    return {
      type: 'FeatureCollection',
      name: `${currentProject()?.name || 'MAPMARK'} annotations`,
      mapmarkProject: currentProject() ? structuredCloneSafe(currentProject()) : null,
      bbox: calculateBbox(annotationsForProject(state.activeProjectId).map(annotation => annotation.geometry)),
      features: annotationsForProject(state.activeProjectId).map(annotation => {
        const collection = state.collections.find(item => item.id === annotation.collectionId);
        return {
          type: 'Feature',
          id: annotation.id,
          geometry: structuredCloneSafe(annotation.geometry),
          properties: {
            mapmarkType: annotation.type,
            title: annotation.title,
            note: annotation.note,
            tags: annotation.tags,
            status: annotation.status,
            priority: annotation.priority,
            owner: annotation.owner,
            legendLabel: annotation.legendLabel,
            markerIcon: annotation.markerIcon,
            calloutNumber: annotation.calloutNumber,
            showMeasurement: annotation.showMeasurement,
            measurements: Object.fromEntries(annotationMeasurements(annotation)),
            color: annotation.color,
            strokeWidth: annotation.strokeWidth,
            collectionId: annotation.collectionId,
            collectionName: collection?.name || '',
            projectId: collection?.projectId || state.activeProjectId,
            projectName: state.projects.find(project => project.id === collection?.projectId)?.name || '',
            layerVisible: collection?.visible !== false,
            layerLocked: Boolean(collection?.locked),
            createdAt: annotation.createdAt,
            updatedAt: annotation.updatedAt,
          },
        };
      }),
    };
  }

  async function copyPackage() {
    const active = state.collections.find(collection => collection.id === state.activeCollectionId);
    const annotations = annotationsForCurrentCollection();
    const lines = [
      `${APP.name} MAP ANNOTATION PACKAGE`,
      `Project: ${currentProject()?.name || 'Unknown'}`,
      `Layer scope: ${active?.name || 'Unknown'}`,
      `Source: ${location.href}`,
      `Exported: ${new Date().toISOString()}`,
      `Annotations: ${annotations.length}`,
      '',
      ...annotations.map((annotation, index) => {
        const center = annotationCenter(annotation);
        const coordinate = center ? `${center[1].toFixed(6)}, ${center[0].toFixed(6)}` : 'n/a';
        const detail = annotation.note ? `\n   ${annotation.note.replace(/\n/g, '\n   ')}` : '';
        const tags = annotation.tags ? `\n   Tags: ${annotation.tags}` : '';
        const owner = annotation.owner ? `\n   Owner: ${annotation.owner}` : '';
        return `${index + 1}. [${TOOL_LABELS[annotation.type] || annotation.type}] ${annotation.title}\n   Status: ${STATUS_LABELS[annotation.status]} · Priority: ${PRIORITY_LABELS[annotation.priority]}\n   Coordinate: ${coordinate}${owner}${tags}${detail}`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setStatus('Annotation package copied to the clipboard.', false);
    } catch (error) {
      console.warn(`[${APP.name}] Clipboard write failed.`, error);
      setStatus('Clipboard access was blocked. Use Export JSON instead.', true);
    }
  }

  function downloadJson(value, filename) {
    downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }), filename);
  }

  importInput.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const isKml = file.name.toLowerCase().endsWith('.kml') || /<\s*kml[\s>]/i.test(text);
      const imported = isKml ? parseKml(text) : parseImport(JSON.parse(text));
      if (!imported.annotations.length && !imported.projects?.length) throw new Error('No supported MAPMARK project data or annotations were found.');
      await createRecoverySnapshot('before-import');
      pushUndo();
      const report = mergeImportedData(imported, state.preferences.importStrategy);
      ui.lastImportReport = report;
      saveStateSoon();
      renderAll();
      setStatus(formatImportReport(report), report.conflicts > 0);
    } catch (error) {
      console.error(`[${APP.name}] Import failed.`, error);
      setStatus(`Import failed: ${error.message}`, true);
    }
  });

  function parseImport(data) {
    if (data?.format === 'mapmark-project' && data.project && Array.isArray(data.annotations)) {
      const project = normalizeProject(data.project);
      const layers = (Array.isArray(data.layers) ? data.layers : []).map((layer, index) => normalizeLayer(layer, project.id, index));
      return {
        projects: [project],
        collections: layers,
        annotations: data.annotations.filter(isValidAnnotation).map(normalizeAnnotation),
        sourceFormat: 'project',
      };
    }
    if ((data?.format === 'mapmark-workspace' || data?.format === 'mapmark-package') && Array.isArray(data.annotations)) {
      const normalized = normalizeState(data);
      return {
        projects: normalized.projects,
        collections: normalized.collections,
        annotations: normalized.annotations,
        sourceFormat: 'workspace',
      };
    }
    if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) {
      const projectId = String(data.mapmarkProject?.id || makeId('project'));
      const project = normalizeProject(data.mapmarkProject || { id: projectId, name: data.name || 'Imported GeoJSON' });
      const collectionNames = new Map();
      const annotations = [];
      for (const feature of data.features) {
        if (!feature?.geometry) continue;
        const properties = feature.properties || {};
        const collectionName = String(properties.collectionName || 'Imported GeoJSON');
        const collectionId = String(properties.collectionId || slugId(collectionName) || makeId('layer'));
        collectionNames.set(collectionId, { name: collectionName, visible: properties.layerVisible !== false, locked: Boolean(properties.layerLocked) });
        const type = inferAnnotationType(feature.geometry, properties.mapmarkType);
        if (!type) continue;
        annotations.push(normalizeAnnotation({
          id: feature.id || makeId(type), type, collectionId,
          title: properties.title || defaultTitle(type), note: properties.note || '', tags: properties.tags || '',
          status: properties.status || 'open', priority: properties.priority || 'normal', owner: properties.owner || '',
          legendLabel: properties.legendLabel || '', markerIcon: properties.markerIcon || 'pin', calloutNumber: properties.calloutNumber,
          showMeasurement: properties.showMeasurement !== false, color: properties.color || COLORS[0], strokeWidth: properties.strokeWidth || 3,
          geometry: feature.geometry, createdAt: properties.createdAt, updatedAt: properties.updatedAt,
        }));
      }
      return {
        projects: [project],
        collections: [...collectionNames].map(([id, info], index) => normalizeLayer({ id, name: info.name, visible: info.visible, locked: info.locked }, project.id, index)),
        annotations,
        sourceFormat: 'geojson',
      };
    }
    throw new Error('Unsupported JSON format.');
  }

  function inferAnnotationType(geometry, explicit) {
    if (ANNOTATION_TYPES.includes(explicit)) return explicit;
    if (geometry.type === 'Point') return 'marker';
    if (geometry.type === 'LineString') return 'route';
    if (geometry.type === 'Polygon') return 'polygon';
    return null;
  }

  function exportKml() {
    const xml = buildKml();
    downloadText(xml, `mapmark-${dateStamp()}.kml`, 'application/vnd.google-earth.kml+xml;charset=utf-8');
  }

  function buildKml() {
    const placemarks = annotationsForProject(state.activeProjectId).map(annotation => {
      const collection = state.collections.find(item => item.id === annotation.collectionId)?.name || '';
      const data = {
        mapmarkType: annotation.type,
        collection,
        project: currentProject()?.name || '',
        status: annotation.status,
        priority: annotation.priority,
        owner: annotation.owner,
        tags: annotation.tags,
        legendLabel: annotation.legendLabel,
        color: annotation.color,
        markerIcon: annotation.markerIcon,
        calloutNumber: annotation.calloutNumber || '',
      };
      const extended = Object.entries(data).map(([name, value]) => `<Data name="${escapeXml(name)}"><value>${escapeXml(value)}</value></Data>`).join('');
      return `<Placemark><name>${escapeXml(annotation.title)}</name><description>${escapeXml(annotation.note)}</description><ExtendedData>${extended}</ExtendedData>${geometryToKml(annotation.geometry)}</Placemark>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(currentProject()?.name || 'MAPMARK annotations')}</name>${placemarks}</Document></kml>`;
  }

  function geometryToKml(geometry) {
    if (geometry?.type === 'Point') return `<Point><coordinates>${kmlCoordinate(geometry.coordinates)}</coordinates></Point>`;
    if (geometry?.type === 'LineString') return `<LineString><tessellate>1</tessellate><coordinates>${(geometry.coordinates || []).map(kmlCoordinate).join(' ')}</coordinates></LineString>`;
    if (geometry?.type === 'Polygon') return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${(geometry.coordinates?.[0] || []).map(kmlCoordinate).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    return '';
  }

  function kmlCoordinate(coordinate) { return isCoordinate(coordinate) ? `${coordinate[0]},${coordinate[1]},0` : ''; }

  function parseKml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('The KML could not be parsed.');
    const collectionId = makeId('set');
    const collectionName = textContentByLocalName(doc.documentElement, 'name') || 'Imported KML';
    const annotations = [];
    for (const placemark of elementsByLocalName(doc, 'Placemark')) {
      const properties = {};
      for (const data of elementsByLocalName(placemark, 'Data')) properties[data.getAttribute('name')] = textContentByLocalName(data, 'value');
      const name = textContentByLocalName(placemark, 'name') || '';
      const note = textContentByLocalName(placemark, 'description') || '';
      const point = elementsByLocalName(placemark, 'Point')[0];
      const line = elementsByLocalName(placemark, 'LineString')[0];
      const polygon = elementsByLocalName(placemark, 'Polygon')[0];
      let geometry = null;
      if (point) geometry = { type: 'Point', coordinates: parseKmlCoordinates(textContentByLocalName(point, 'coordinates'))[0] };
      else if (line) geometry = { type: 'LineString', coordinates: parseKmlCoordinates(textContentByLocalName(line, 'coordinates')) };
      else if (polygon) geometry = { type: 'Polygon', coordinates: [parseKmlCoordinates(textContentByLocalName(polygon, 'coordinates'))] };
      if (!geometry || !geometry.coordinates) continue;
      const explicit = properties.mapmarkType;
      const type = inferAnnotationType(geometry, explicit);
      annotations.push(normalizeAnnotation({
        id: makeId(type), type, collectionId, title: name || defaultTitle(type), note,
        tags: properties.tags || '', status: properties.status || 'open', priority: properties.priority || 'normal', owner: properties.owner || '',
        legendLabel: properties.legendLabel || '', markerIcon: properties.markerIcon || 'pin', calloutNumber: properties.calloutNumber,
        color: properties.color || COLORS[0], strokeWidth: 3, geometry,
      }));
    }
    const projectId = makeId('project');
    return { projects: [normalizeProject({ id: projectId, name: collectionName })], collections: [normalizeLayer({ id: collectionId, name: collectionName }, projectId, 0)], annotations, sourceFormat: 'kml' };
  }

  function elementsByLocalName(root, name) { return [...root.getElementsByTagName('*')].filter(element => element.localName === name); }
  function textContentByLocalName(root, name) { return elementsByLocalName(root, name)[0]?.textContent?.trim() || ''; }
  function parseKmlCoordinates(value) {
    return String(value || '').trim().split(/\s+/).map(token => token.split(',').slice(0, 2).map(Number)).filter(isCoordinate);
  }
  function escapeXml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'); }

  function mergeImportedData(imported, strategy = 'merge') {
    const report = { projects: 0, layers: 0, annotations: 0, skipped: 0, conflicts: 0, strategy };
    const projectMap = new Map();
    const layerMap = new Map();
    const importedProjects = imported.projects?.length ? imported.projects : [normalizeProject({ id: makeId('project'), name: 'Imported project' })];

    for (const sourceProject of importedProjects) {
      const incoming = normalizeProject(sourceProject);
      let target = strategy === 'merge' ? state.projects.find(project => project.id === incoming.id) : null;
      if (!target && strategy === 'merge') target = state.projects.find(project => project.name.trim().toLowerCase() === incoming.name.trim().toLowerCase());
      if (!target) {
        target = structuredCloneSafe(incoming);
        if (strategy === 'duplicate' || state.projects.some(project => project.id === target.id)) target.id = makeId('project');
        if (strategy === 'duplicate') target.name = uniqueProjectName(`${target.name} copy`);
        state.projects.push(target);
        report.projects += 1;
      } else if (String(incoming.updatedAt) > String(target.updatedAt)) {
        target.description = incoming.description || target.description;
        target.reference = incoming.reference || target.reference;
        target.updatedAt = incoming.updatedAt;
      }
      projectMap.set(incoming.id, target.id);
    }

    for (const sourceLayer of imported.collections || []) {
      const sourceProjectId = sourceLayer.projectId || importedProjects[0].id;
      const targetProjectId = projectMap.get(sourceProjectId) || [...projectMap.values()][0] || state.activeProjectId;
      const incoming = normalizeLayer(sourceLayer, targetProjectId, projectLayers(true, targetProjectId).length);
      let target = strategy === 'merge' ? state.collections.find(layer => layer.projectId === targetProjectId && (layer.id === incoming.id || layer.name.trim().toLowerCase() === incoming.name.trim().toLowerCase())) : null;
      if (!target) {
        target = structuredCloneSafe(incoming);
        target.projectId = targetProjectId;
        if (strategy === 'duplicate' || state.collections.some(layer => layer.id === target.id)) target.id = makeId('layer');
        state.collections.push(target);
        report.layers += 1;
      }
      layerMap.set(String(sourceLayer.id), target.id);
    }

    if (!(imported.collections || []).length) {
      const projectId = [...projectMap.values()][0] || state.activeProjectId;
      const layer = normalizeLayer({ id: makeId('layer'), name: 'Imported annotations' }, projectId, projectLayers(true, projectId).length);
      state.collections.push(layer); report.layers += 1; layerMap.set('__fallback__', layer.id);
    }

    for (const sourceAnnotation of imported.annotations || []) {
      const copy = normalizeAnnotation(sourceAnnotation);
      copy.collectionId = layerMap.get(copy.collectionId) || layerMap.get('__fallback__') || state.activeCollectionId;
      const existing = state.annotations.find(annotation => annotation.id === copy.id);
      if (!existing || strategy === 'duplicate') {
        if (existing || strategy === 'duplicate') copy.id = makeId(copy.type);
        state.annotations.push(copy); report.annotations += 1; continue;
      }
      if (annotationFingerprint(existing) === annotationFingerprint(copy)) { report.skipped += 1; continue; }
      copy.id = makeId(copy.type);
      copy.title = `${copy.title || defaultTitle(copy.type)} (import conflict)`;
      copy.tags = [...parseTags(copy.tags), 'import-conflict'].filter((value, index, all) => all.indexOf(value) === index).join(', ');
      state.annotations.push(copy);
      report.annotations += 1;
      report.conflicts += 1;
    }

    const firstProjectId = [...projectMap.values()][0];
    if (firstProjectId) {
      state.activeProjectId = firstProjectId;
      state.activeCollectionId = projectLayers(false, firstProjectId)[0]?.id || projectLayers(true, firstProjectId)[0]?.id || state.activeCollectionId;
    }
    setSelection([], null, false);
    return report;
  }

  function annotationFingerprint(annotation) {
    return JSON.stringify({
      type: annotation.type, collectionId: annotation.collectionId, title: annotation.title, note: annotation.note, tags: annotation.tags,
      status: annotation.status, priority: annotation.priority, owner: annotation.owner, legendLabel: annotation.legendLabel,
      markerIcon: annotation.markerIcon, calloutNumber: annotation.calloutNumber, showMeasurement: annotation.showMeasurement,
      color: annotation.color, strokeWidth: annotation.strokeWidth, geometry: annotation.geometry,
    });
  }

  function uniqueProjectName(base) {
    const names = new Set(state.projects.map(project => project.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    let index = 2;
    while (names.has(`${base} ${index}`.toLowerCase())) index += 1;
    return `${base} ${index}`;
  }

  function formatImportReport(report) {
    return `Import ${report.strategy === 'duplicate' ? 'copy' : 'merge'}: ${report.projects} project${report.projects === 1 ? '' : 's'}, ${report.layers} layer${report.layers === 1 ? '' : 's'}, ${report.annotations} annotation${report.annotations === 1 ? '' : 's'} added, ${report.skipped} duplicate${report.skipped === 1 ? '' : 's'} skipped${report.conflicts ? `, ${report.conflicts} conflict${report.conflicts === 1 ? '' : 's'} preserved as copies` : ''}.`;
  }

  function calculateBbox(geometries) {
    const coordinates = [];
    for (const geometry of geometries) flattenCoordinates(geometry?.coordinates, coordinates);
    if (!coordinates.length) return undefined;
    const lngs = coordinates.map(point => point[0]);
    const lats = coordinates.map(point => point[1]);
    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  }

  function flattenCoordinates(value, output) {
    if (isCoordinate(value)) {
      output.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(item => flattenCoordinates(item, output));
  }

  function simplifyPolyline(points, tolerance) {
    if (points.length <= 2) return points;
    const sqTolerance = tolerance * tolerance;
    let previous = points[0];
    const radial = [previous];
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      if (squaredDistance(point, previous) > sqTolerance) {
        radial.push(point);
        previous = point;
      }
    }
    if (previous !== points[points.length - 1]) radial.push(points[points.length - 1]);
    return simplifyDouglasPeucker(radial, sqTolerance);
  }

  function simplifyDouglasPeucker(points, sqTolerance) {
    const last = points.length - 1;
    const markers = new Uint8Array(points.length);
    const stack = [[0, last]];
    markers[0] = markers[last] = 1;
    while (stack.length) {
      const [first, end] = stack.pop();
      let maxSqDistance = 0;
      let index = 0;
      for (let i = first + 1; i < end; i += 1) {
        const sqDistance = squaredSegmentDistance(points[i], points[first], points[end]);
        if (sqDistance > maxSqDistance) {
          index = i;
          maxSqDistance = sqDistance;
        }
      }
      if (maxSqDistance > sqTolerance) {
        markers[index] = 1;
        stack.push([first, index], [index, end]);
      }
    }
    return points.filter((_, index) => markers[index]);
  }

  function squaredSegmentDistance(point, start, end) {
    let x = start[0];
    let y = start[1];
    let dx = end[0] - x;
    let dy = end[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = end[0];
        y = end[1];
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = point[0] - x;
    dy = point[1] - y;
    return dx * dx + dy * dy;
  }

  function squaredDistance(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return dx * dx + dy * dy;
  }

  function distance(a, b) {
    return Math.sqrt(squaredDistance(a, b));
  }

  function polylineLength(points) {
    let total = 0;
    for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
    return total;
  }

  function arrowHead(start, end, size) {
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const wing = Math.PI / 7;
    return [
      end,
      [end[0] - size * Math.cos(angle - wing), end[1] - size * Math.sin(angle - wing)],
      [end[0] - size * 0.56 * Math.cos(angle), end[1] - size * 0.56 * Math.sin(angle)],
      [end[0] - size * Math.cos(angle + wing), end[1] - size * Math.sin(angle + wing)],
    ];
  }

  function isCoordinate(value) {
    return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
  }

  function nearViewport([x, y], margin = 0) {
    return x >= -margin && y >= -margin && x <= ui.mapRect.width + margin && y <= ui.mapRect.height + margin;
  }

  function formatZoom(zoom) {
    return Number.isFinite(zoom) ? `z${Number(zoom).toFixed(1).replace(/\.0$/, '')}` : 'No fix';
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function slugId(value) {
    return `set-${String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeLng(lng) {
    return ((lng + 540) % 360) - 180;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function truncate(value, maxLength) {
    const text = String(value || '');
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
  }

  function dateStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace('#', '');
    const number = Number.parseInt(value, 16);
    const red = (number >> 16) & 255;
    const green = (number >> 8) & 255;
    const blue = number & 255;
    return `rgba(${red},${green},${blue},${alpha})`;
  }

  function parseTags(value) {
    return String(value || '').split(/[,;\n]+/).map(tag => tag.trim()).filter(Boolean);
  }

  function haversineKm(a, b) {
    if (!isCoordinate(a) || !isCoordinate(b)) return Number.POSITIVE_INFINITY;
    const toRad = value => value * Math.PI / 180;
    const [lng1, lat1] = a.map(Number);
    const [lng2, lat2] = b.map(Number);
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function formatDistance(km) {
    if (!Number.isFinite(km)) return '';
    if (km < 0.16) return `${Math.round(km * 3280.84)} ft`;
    if (km < 1.609344) return `${(km * 0.621371).toFixed(1)} mi`;
    return `${(km * 0.621371).toFixed(km < 16.09344 ? 1 : 0)} mi`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
  }

  window.addEventListener('keydown', event => {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      ui.expanded = !ui.expanded;
      renderShell();
      return;
    }
    if (ui.expanded && event.altKey && !event.shiftKey && ['1','2','3','4','5'].includes(event.key)) {
      event.preventDefault();
      ui.workspace = ['annotate','review','evidence','project','system'][Number(event.key) - 1];
      if (ui.workspace === 'system') ui.diagnosticsOpen = true;
      renderShell();
      return;
    }
    if (event.key === 'Enter' && ui.drawing && ['route','polygon'].includes(ui.drawing.type)) {
      event.preventDefault();
      completeMultiPointDrawing();
      return;
    }
    if (event.key === 'Escape') {
      if (ui.interaction) cancelSelectionInteraction();
      else if (ui.drawing) cancelDrawing();
      else if (ui.tool !== 'select') setTool('select');
      else if (selectionSet().size) setSelection([]);
      return;
    }
    const active = shadow.activeElement || document.activeElement;
    const isTyping = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
    if (isTyping) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectionSet().size) {
      event.preventDefault();
      if (!ui.activeVertex || !deleteActiveVertex()) deleteSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selectionSet().size) {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (selectionSet().size && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const amount = event.shiftKey ? 10 : 1;
      const vector = {
        ArrowLeft: [-amount, 0],
        ArrowRight: [amount, 0],
        ArrowUp: [0, -amount],
        ArrowDown: [0, amount],
      }[event.key];
      nudgeSelection(vector[0], vector[1]);
    }
  }, true);

  window.addEventListener('resize', () => {
    updateMapContext();
    renderOverlay();
  });

  const mutationObserver = new MutationObserver(() => scheduleContextRefresh());
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  let contextTimer = null;
  function scheduleContextRefresh() {
    clearTimeout(contextTimer);
    contextTimer = setTimeout(() => {
      const previous = ui.mapRect;
      updateMapContext();
      if (!sameRect(previous, ui.mapRect)) {
        renderOverlay();
        if (ui.expanded) renderShell();
      }
    }, 180);
  }

  setInterval(() => {
    const hrefChanged = location.href !== ui.lastHref;
    if (hrefChanged) ui.lastHref = location.href;
    const previousView = ui.mapView;
    const previousRect = ui.mapRect;
    updateMapContext();
    const viewChanged = !sameView(previousView, ui.mapView);
    const rectChanged = !sameRect(previousRect, ui.mapRect);
    if (hrefChanged || viewChanged || rectChanged) {
      renderOverlay();
      if (ui.expanded) renderShell();
    }
  }, 250);

  function sameView(a, b) {
    if (!a || !b) return a === b;
    return a.lat === b.lat && a.lng === b.lng && a.zoom === b.zoom;
  }

  function sameRect(a, b) {
    if (!a || !b) return a === b;
    return ['left', 'top', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) < 0.5);
  }

  renderAll();
  void initializeReliabilityStorage();
  console.info(`[${APP.name}] v${APP.version} loaded. Alt+Shift+M toggles the panel.`);
})();
