// ==UserScript==
// @name         MAPMARK — Google Maps Annotator
// @namespace    https://mbparks.com/fieldinstruments
// @version      1.4.0
// @description  Add persistent Google Maps annotations with precision editing, rich geographic markup, measurements, KML/GeoJSON exchange, evidence capture, and printable reports.
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
    version: '1.4.0',
    storageKey: 'mapmark.state.v1',
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
    active: 'Active map set',
    selected: 'Selected annotations',
    register: 'Current register results',
    all: 'All annotations',
  });

  const DEFAULT_STATE = () => ({
    schema: 4,
    activeCollectionId: 'default',
    showAllCollections: false,
    collections: [
      { id: 'default', name: 'Field Notes', createdAt: new Date().toISOString() },
    ],
    annotations: [],
    preferences: {
      color: COLORS[0],
      strokeWidth: 3,
      markerIcon: 'pin',
      snap: true,
      showArchivedOnMap: false,
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
  });

  let state = loadState();
  let pendingFocusId = null;
  try {
    const candidate = sessionStorage.getItem('mapmark.pendingFocus');
    if (candidate && state.annotations.some(annotation => annotation.id === candidate)) pendingFocusId = candidate;
    sessionStorage.removeItem('mapmark.pendingFocus');
  } catch (_) { /* storage unavailable */ }
  let ui = {
    expanded: Boolean(pendingFocusId),
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
    clearArmed: false,
    saveTimer: null,
    renderQueued: false,
    undo: [],
    redo: [],
    captureBusy: false,
    captureMode: false,
    captureIds: null,
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
  importInput.accept = '.json,.geojson,.kml,application/json,application/geo+json,application/vnd.google-earth.kml+xml,text/xml,application/xml';
  shadow.appendChild(importInput);

  function loadState() {
    try {
      const stored = GM_getValue(APP.storageKey, null);
      if (!stored) return DEFAULT_STATE();
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return normalizeState(parsed);
    } catch (error) {
      console.warn(`[${APP.name}] Could not load saved data.`, error);
      return DEFAULT_STATE();
    }
  }

  function normalizeState(input) {
    const fresh = DEFAULT_STATE();
    if (!input || typeof input !== 'object') return fresh;
    const collections = Array.isArray(input.collections) && input.collections.length
      ? input.collections.filter(item => item && item.id && item.name)
      : fresh.collections;
    const activeExists = collections.some(item => item.id === input.activeCollectionId);
    const register = input.preferences?.register || {};
    const evidence = input.preferences?.evidence || {};
    return {
      schema: 4,
      activeCollectionId: activeExists ? input.activeCollectionId : collections[0].id,
      showAllCollections: Boolean(input.showAllCollections),
      collections,
      annotations: Array.isArray(input.annotations)
        ? input.annotations.filter(isValidAnnotation).map(normalizeAnnotation)
        : [],
      preferences: {
        color: COLORS.includes(input.preferences?.color) ? input.preferences.color : fresh.preferences.color,
        strokeWidth: clamp(Number(input.preferences?.strokeWidth) || fresh.preferences.strokeWidth, 1, 8),
        markerIcon: Object.prototype.hasOwnProperty.call(MARKER_ICONS, input.preferences?.markerIcon) ? input.preferences.markerIcon : fresh.preferences.markerIcon,
        snap: input.preferences?.snap !== false,
        showArchivedOnMap: Boolean(input.preferences?.showArchivedOnMap),
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
      calloutNumber: Number.isFinite(Number(annotation.calloutNumber)) ? Math.max(1, Math.round(Number(annotation.calloutNumber))) : null,
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

  function saveStateSoon() {
    setSaveIndicator(true);
    clearTimeout(ui.saveTimer);
    ui.saveTimer = setTimeout(() => {
      try {
        GM_setValue(APP.storageKey, JSON.stringify(state));
        setSaveIndicator(false);
      } catch (error) {
        console.error(`[${APP.name}] Save failed.`, error);
        setStatus('Save failed. Open the browser console for details.', true);
      }
    }, 220);
  }

  function setSaveIndicator(saving) {
    const save = shadow.querySelector('.mm-save');
    if (!save) return;
    save.classList.toggle('saving', saving);
    const label = save.querySelector('.mm-save-label');
    if (label) label.textContent = saving ? 'Saving' : 'Saved';
  }

  function pushUndo() {
    ui.undo.push(structuredCloneSafe({
      annotations: state.annotations,
      collections: state.collections,
      activeCollectionId: state.activeCollectionId,
    }));
    if (ui.undo.length > 40) ui.undo.shift();
    ui.redo.length = 0;
  }

  function restoreSnapshot(snapshot) {
    state.annotations = snapshot.annotations;
    state.collections = snapshot.collections;
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
      activeCollectionId: state.activeCollectionId,
    }));
    restoreSnapshot(ui.undo.pop());
  }

  function redo() {
    if (!ui.redo.length) return;
    ui.undo.push(structuredCloneSafe({
      annotations: state.annotations,
      collections: state.collections,
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
    const status = mapStatus();

    shell.innerHTML = ui.expanded ? `
      <aside id="mm-panel" aria-label="${APP.name} controls">
        <header class="mm-header">
          <div class="mm-brand">
            <strong>${APP.name}</strong>
            <span class="mm-version">v${APP.version}</span>
            <span class="mm-save"><span class="mm-save-dot"></span><span class="mm-save-label">Saved</span></span>
          </div>
          <button class="mm-icon-btn" data-action="collapse" title="Collapse (Alt+Shift+M)" aria-label="Collapse">×</button>
        </header>
        <div class="mm-scroll">
          <section class="mm-section">
            <div class="mm-section-title"><span>Map set</span><span>${state.annotations.length} total</span></div>
            <div class="mm-row">
              <select class="mm-select" id="mm-collection" aria-label="Active map set">
                ${state.collections.map(collection => `<option value="${escapeAttr(collection.id)}" ${collection.id === state.activeCollectionId ? 'selected' : ''}>${escapeHtml(collection.name)}</option>`).join('')}
              </select>
              <button class="mm-icon-btn" data-action="new-collection" title="New map set" aria-label="New map set">+</button>
            </div>
            ${ui.newCollectionOpen ? `
              <div class="mm-new-collection">
                <input class="mm-field" id="mm-new-collection-name" maxlength="80" placeholder="Map set name">
                <button class="mm-btn primary" data-action="add-collection">Add</button>
                <button class="mm-btn" data-action="cancel-collection">Cancel</button>
              </div>
            ` : ''}
            <label class="mm-check" style="margin-top:7px"><input id="mm-show-all" type="checkbox" ${state.showAllCollections ? 'checked' : ''}> Show annotations from every map set</label>
            <label class="mm-check" style="margin-top:7px"><input id="mm-show-archived" type="checkbox" ${state.preferences.showArchivedOnMap ? 'checked' : ''}> Show archived annotations on map</label>
          </section>

          <section class="mm-section">
            <div class="mm-section-title"><span>Tools</span><span>${escapeHtml(TOOL_LABELS[ui.tool])}</span></div>
            <div class="mm-tools">
              ${toolButton('select', '↖', 'Select')}
              ${toolButton('note', '●', 'Note')}
              ${toolButton('callout', '①', 'Callout')}
              ${toolButton('marker', '◆', 'Marker')}
              ${toolButton('label', 'T', 'Label')}
              ${toolButton('arrow', '→', 'Arrow')}
              ${toolButton('route', '⌁', 'Route')}
              ${toolButton('box', '□', 'Box')}
              ${toolButton('polygon', '⬡', 'Polygon')}
              ${toolButton('circle', '○', 'Circle')}
              ${toolButton('pen', '〰', 'Draw')}
            </div>
          </section>

          <section class="mm-section">
            <div class="mm-section-title"><span>Style</span><span id="mm-stroke-value">${state.preferences.strokeWidth}px</span></div>
            <div class="mm-colors">
              ${COLORS.map(color => `<button class="mm-color ${state.preferences.color === color ? 'active' : ''}" data-color="${color}" style="background:${color}" title="${color}" aria-label="Use ${color}"></button>`).join('')}
            </div>
            <div class="mm-row" style="margin-top:9px">
              <span style="font-size:10px;color:var(--mm-muted)">Line</span>
              <input class="mm-range" id="mm-stroke" type="range" min="1" max="8" step="1" value="${state.preferences.strokeWidth}" aria-label="Line width">
            </div>
            <label class="mm-label" style="margin-top:8px">Marker symbol
              <select class="mm-select" id="mm-marker-icon">
                ${Object.entries(MARKER_ICONS).map(([value, icon]) => `<option value="${value}" ${state.preferences.markerIcon === value ? 'selected' : ''}>${escapeHtml(icon.glyph)} ${escapeHtml(icon.label)}</option>`).join('')}
              </select>
            </label>
            <label class="mm-check" style="margin-top:8px"><input id="mm-snap" type="checkbox" ${state.preferences.snap ? 'checked' : ''}> Snap to nearby annotation anchors and visible map markers</label>
          </section>

          <section class="mm-section">
            <div class="mm-section-title"><span>Map status</span><span>${formatZoom(ui.mapView?.zoom)}</span></div>
            <div class="mm-status ${status.warn ? 'warn' : ''}" id="mm-status">${escapeHtml(status.message)}</div>
            ${ui.drawing && ['route','polygon'].includes(ui.drawing.type) ? `<div class="mm-row" style="margin-top:6px"><button class="mm-btn primary" data-action="finish-drawing">Finish ${escapeHtml(TOOL_LABELS[ui.drawing.type])}</button><button class="mm-btn" data-action="cancel-drawing">Cancel</button></div>` : ''}
          </section>

          ${registerMarkup(registerAnnotations, registerMetricsData, selectionCount)}

          <section class="mm-section">
            <div class="mm-section-title"><span>Inspector</span><span>${selectionCount > 1 ? `${selectionCount} selected` : selected ? escapeHtml(TOOL_LABELS[selected.type] || selected.type) : 'None'}</span></div>
            ${selectionCount > 1 ? multiInspectorMarkup(selectedList) : selected ? inspectorMarkup(selected) : '<div class="mm-empty">Select an annotation to edit it. Shift-click annotations or register entries to build a multi-selection.</div>'}
          </section>

          ${evidenceMarkup(evidenceCount)}

          <section class="mm-section">
            <div class="mm-section-title"><span>Data</span><span>Local only</span></div>
            <div class="mm-actions">
              <button class="mm-btn" data-action="undo" ${ui.undo.length ? '' : 'disabled'}>Undo</button>
              <button class="mm-btn" data-action="redo" ${ui.redo.length ? '' : 'disabled'}>Redo</button>
              <button class="mm-btn" data-action="toggle-hidden">${ui.hidden ? 'Show markup' : 'Hide markup'}</button>
              <button class="mm-btn" data-action="copy-package">Copy package</button>
              <button class="mm-btn" data-action="export-json">Export JSON</button>
              <button class="mm-btn" data-action="export-geojson">Export GeoJSON</button>
              <button class="mm-btn" data-action="export-kml">Export KML</button>
              <button class="mm-btn" data-action="import">Import JSON / GeoJSON / KML</button>
              <button class="mm-btn danger" data-action="clear">${ui.clearArmed ? 'Confirm clear' : 'Clear map set'}</button>
            </div>
          </section>
        </div>
        <footer class="mm-footer">Rich geographic markup is stored as portable coordinates. Routes, polygons, and circles include measurements; JSON, GeoJSON, KML, Markdown, CSV, PNG, and printable reports remain local to the browser.</footer>
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
    return `
      <section class="mm-section" id="mm-register-section">
        <div class="mm-section-title"><span>Annotation register</span><span id="mm-register-count">${annotations.length} of ${metrics.scopeCount}</span></div>
        <div class="mm-register-controls">
          <input class="mm-field" id="mm-register-search" value="${escapeAttr(register.query)}" placeholder="Search title, notes, tags, owner…" aria-label="Search annotations">
          <div class="mm-metrics">
            <div class="mm-metric-row" id="mm-status-metrics">
              ${registerMetric('status', 'all', 'All', metrics.status.all, register.status === 'all')}
              ${Object.keys(STATUS_LABELS).map(status => registerMetric('status', status, STATUS_LABELS[status], metrics.status[status], register.status === status)).join('')}
            </div>
            <div class="mm-metric-row" id="mm-type-metrics">
              ${registerMetric('type', 'all', 'All types', metrics.type.all, register.type === 'all')}
              ${ANNOTATION_TYPES.map(type => registerMetric('type', type, TOOL_LABELS[type], metrics.type[type], register.type === type)).join('')}
            </div>
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
            <select class="mm-select" id="mm-filter-collection" aria-label="Filter by map set">
              <option value="scope" ${register.collection === 'scope' ? 'selected' : ''}>Map visibility scope</option>
              <option value="all" ${register.collection === 'all' ? 'selected' : ''}>All map sets</option>
              ${state.collections.map(collection => `<option value="set:${escapeAttr(collection.id)}" ${register.collection === `set:${collection.id}` ? 'selected' : ''}>${escapeHtml(collection.name)}</option>`).join('')}
            </select>
            <input class="mm-field" id="mm-filter-tag" value="${escapeAttr(register.tag)}" placeholder="Filter tag" aria-label="Filter annotations by tag">
            <select class="mm-select" id="mm-register-sort" aria-label="Sort annotations">
              ${Object.entries(REGISTER_SORTS).map(([value, label]) => `<option value="${value}" ${register.sort === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
          </div>
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
        <label class="mm-label">Map set
          <select class="mm-select" id="mm-ann-collection">
            ${state.collections.map(collection => `<option value="${escapeAttr(collection.id)}" ${collection.id === annotation.collectionId ? 'selected' : ''}>${escapeHtml(collection.name)}</option>`).join('')}
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
      handleAction(actionButton.dataset.action);
    });

    panel.querySelector('#mm-collection')?.addEventListener('change', event => {
      state.activeCollectionId = event.target.value;
      setSelection([], null, false);
      saveStateSoon();
      renderAll();
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
    pushUndo();
    selected[property] = value;
    selected.updatedAt = new Date().toISOString();
    saveStateSoon();
    renderAll();
  }

  function applyBulkField(property, value) {
    const selected = selectedAnnotations();
    if (!selected.length) return;
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
    const selected = selectedAnnotations();
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

  function handleAction(action) {
    switch (action) {
      case 'collapse':
        ui.expanded = false;
        ui.clearArmed = false;
        renderShell();
        break;
      case 'new-collection':
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
      case 'expand':
        ui.expanded = true;
        renderShell();
        break;
      default:
        break;
    }
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
      id: makeId('set'),
      name,
      createdAt: new Date().toISOString(),
    };
    state.collections.push(collection);
    state.activeCollectionId = collection.id;
    setSelection([], null, false);
    ui.newCollectionOpen = false;
    saveStateSoon();
    renderAll();
  }

  function clearActiveCollection() {
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
    pushUndo();
    state.annotations = state.annotations.filter(annotation => annotation.collectionId !== state.activeCollectionId);
    setSelection([], null, false);
    ui.clearArmed = false;
    saveStateSoon();
    renderAll();
  }

  function deleteSelected() {
    const ids = selectionSet();
    if (!ids.size) return;
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
    const selected = selectedAnnotations();
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
    if (!TOOL_LABELS[tool]) return;
    ui.tool = tool;
    ui.drawing = null;
    ui.draftPoint = null;
    updateOverlayInteraction();
    renderShell();
    renderOverlay();
  }

  function annotationsInMapScope() {
    return state.showAllCollections
      ? state.annotations
      : state.annotations.filter(annotation => annotation.collectionId === state.activeCollectionId);
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
    if (!ui.mapRect) return { warn: true, message: 'Google Maps canvas not found yet. Move or zoom the map, then reopen the panel.' };
    if (!ui.mapView) return { warn: true, message: 'This view does not expose a standard latitude, longitude, and zoom in the URL. Return to a normal 2D map view.' };
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
    ui.mapRect = detectMapRect();
    ui.mapView = parseMapView(location.href);
    if (!ui.mapRect) {
      overlay.style.display = 'none';
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

  function detectMapRect() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const candidates = [...document.querySelectorAll('canvas')]
      .map(canvas => ({ canvas, rect: canvas.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 300 && rect.height > 250 && rect.bottom > 0 && rect.right > 0)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

    if (!candidates.length) return null;
    const source = candidates[0].rect;
    let left = Math.max(0, source.left);
    let top = Math.max(0, source.top);
    let right = Math.min(viewportWidth, source.right);
    let bottom = Math.min(viewportHeight, source.bottom);

    const leftPanels = [...document.querySelectorAll('[role="main"]')]
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.width >= 260 && rect.width < viewportWidth * 0.62 && rect.height > viewportHeight * 0.45 && rect.left <= 8 && rect.right < viewportWidth - 200);
    if (leftPanels.length) {
      left = Math.max(left, ...leftPanels.map(rect => rect.right));
    }

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
    if (!ui.mapRect || !ui.mapView || ui.hidden) {
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
      try { overlay.setPointerCapture?.(event.pointerId); } catch (_) { /* inactive pointer */ }

      if ((event.shiftKey || event.ctrlKey || event.metaKey) && !event.target.closest('[data-handle]')) {
        toggleSelection(id);
        ui.expanded = true;
        renderAll();
        ui.suppressClickUntil = Date.now() + 300;
        return;
      }

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
    const selected = selectedAnnotations();
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
        result = state.annotations;
        break;
      case 'visible':
      default:
        result = annotationsForCurrentCollection();
        break;
    }
    return [...result].sort(registerComparator('created-asc'));
  }

  function defaultEvidenceTitle() {
    const active = state.collections.find(collection => collection.id === state.activeCollectionId);
    return `${active?.name || 'Map'} Evidence`;
  }

  function buildEvidenceContext(annotations = evidenceAnnotations()) {
    const evidence = state.preferences.evidence;
    const capturedAt = new Date();
    const collectionNames = [...new Set(annotations.map(annotation => state.collections.find(collection => collection.id === annotation.collectionId)?.name || 'Unknown map set'))];
    const statusCounts = Object.fromEntries(Object.keys(STATUS_LABELS).map(status => [status, annotations.filter(annotation => annotation.status === status).length]));
    const typeCounts = Object.fromEntries(ANNOTATION_TYPES.map(type => [type, annotations.filter(annotation => annotation.type === type).length]));
    return {
      title: evidence.title.trim() || defaultEvidenceTitle(),
      subtitle: evidence.subtitle.trim(),
      scope: evidence.scope,
      scopeLabel: EVIDENCE_SCOPES[evidence.scope] || EVIDENCE_SCOPES.visible,
      annotations,
      collectionNames,
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
<div><strong>Map sets</strong>${escapeHtml(context.collectionNames.join(', '))}</div>
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
      `- **Map sets:** ${context.collectionNames.join(', ') || 'None'}`,
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
      const collection = state.collections.find(item => item.id === annotation.collectionId)?.name || 'Unknown map set';
      lines.push(`### ${index + 1}. ${annotation.title || defaultTitle(annotation.type)}`);
      lines.push('');
      lines.push(`- **Type:** ${TOOL_LABELS[annotation.type] || annotation.type}`);
      lines.push(`- **Map set:** ${collection}`);
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
      const collection = state.collections.find(item => item.id === annotation.collectionId)?.name || 'Unknown map set';
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
    downloadJson(payload, `mapmark-${dateStamp()}.json`);
  }

  function buildNativePackage() {
    return {
      format: 'mapmark-package',
      schema: 4,
      application: APP.name,
      applicationVersion: APP.version,
      exportedAt: new Date().toISOString(),
      sourceUrl: location.href,
      activeCollectionId: state.activeCollectionId,
      showAllCollections: state.showAllCollections,
      preferences: structuredCloneSafe(state.preferences),
      collections: structuredCloneSafe(state.collections),
      annotations: structuredCloneSafe(state.annotations),
    };
  }

  function exportGeoJson() {
    downloadJson(buildGeoJson(), `mapmark-${dateStamp()}.geojson`);
  }

  function buildGeoJson() {
    return {
      type: 'FeatureCollection',
      name: 'MAPMARK annotations',
      bbox: calculateBbox(state.annotations.map(annotation => annotation.geometry)),
      features: state.annotations.map(annotation => {
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
      `Map set: ${active?.name || 'Unknown'}`,
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
      if (!imported.annotations.length) throw new Error('No supported annotations were found.');
      pushUndo();
      mergeImportedData(imported);
      saveStateSoon();
      renderAll();
      setStatus(`Imported ${imported.annotations.length} annotation${imported.annotations.length === 1 ? '' : 's'}.`, false);
    } catch (error) {
      console.error(`[${APP.name}] Import failed.`, error);
      setStatus(`Import failed: ${error.message}`, true);
    }
  });

  function parseImport(data) {
    if (data?.format === 'mapmark-package' && Array.isArray(data.annotations)) {
      return {
        collections: Array.isArray(data.collections) ? data.collections : [],
        annotations: data.annotations.filter(isValidAnnotation).map(normalizeAnnotation),
      };
    }
    if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) {
      const collectionNames = new Map();
      const annotations = [];
      for (const feature of data.features) {
        if (!feature?.geometry) continue;
        const properties = feature.properties || {};
        const collectionName = String(properties.collectionName || 'Imported GeoJSON');
        let collectionId = String(properties.collectionId || slugId(collectionName));
        collectionNames.set(collectionId, collectionName);
        const type = inferAnnotationType(feature.geometry, properties.mapmarkType);
        if (!type) continue;
        annotations.push(normalizeAnnotation({
          id: feature.id || makeId(type),
          type,
          collectionId,
          title: properties.title || defaultTitle(type),
          note: properties.note || '',
          tags: properties.tags || '',
          status: properties.status || 'open',
          priority: properties.priority || 'normal',
          owner: properties.owner || '',
          legendLabel: properties.legendLabel || '',
          markerIcon: properties.markerIcon || 'pin',
          calloutNumber: properties.calloutNumber,
          showMeasurement: properties.showMeasurement !== false,
          color: properties.color || COLORS[0],
          strokeWidth: properties.strokeWidth || 3,
          geometry: feature.geometry,
          createdAt: properties.createdAt,
          updatedAt: properties.updatedAt,
        }));
      }
      return {
        collections: [...collectionNames].map(([id, name]) => ({ id, name, createdAt: new Date().toISOString() })),
        annotations,
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
    const placemarks = state.annotations.map(annotation => {
      const collection = state.collections.find(item => item.id === annotation.collectionId)?.name || '';
      const data = {
        mapmarkType: annotation.type,
        collection,
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
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>MAPMARK annotations</name>${placemarks}</Document></kml>`;
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
    return { collections: [{ id: collectionId, name: collectionName, createdAt: new Date().toISOString() }], annotations };
  }

  function elementsByLocalName(root, name) { return [...root.getElementsByTagName('*')].filter(element => element.localName === name); }
  function textContentByLocalName(root, name) { return elementsByLocalName(root, name)[0]?.textContent?.trim() || ''; }
  function parseKmlCoordinates(value) {
    return String(value || '').trim().split(/\s+/).map(token => token.split(',').slice(0, 2).map(Number)).filter(isCoordinate);
  }
  function escapeXml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'); }

  function mergeImportedData(imported) {
    const collectionMap = new Map();
    for (const importedCollection of imported.collections) {
      let id = String(importedCollection.id || makeId('set'));
      const existing = state.collections.find(collection => collection.id === id);
      if (existing && existing.name !== importedCollection.name) id = makeId('set');
      if (!state.collections.some(collection => collection.id === id)) {
        state.collections.push({
          id,
          name: String(importedCollection.name || 'Imported map set'),
          createdAt: importedCollection.createdAt || new Date().toISOString(),
        });
      }
      collectionMap.set(String(importedCollection.id), id);
    }
    for (const annotation of imported.annotations) {
      const copy = normalizeAnnotation(annotation);
      copy.id = state.annotations.some(item => item.id === copy.id) ? makeId(copy.type) : copy.id;
      copy.collectionId = collectionMap.get(copy.collectionId) || state.activeCollectionId;
      state.annotations.push(copy);
    }
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
  console.info(`[${APP.name}] v${APP.version} loaded. Alt+Shift+M toggles the panel.`);
})();
